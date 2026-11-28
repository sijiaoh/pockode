package projection

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/session"
)

func newestPage(t *testing.T, p *Projection) Page {
	t.Helper()
	page, err := p.Page(session.NoHistorySeq, MaxPageSize)
	if err != nil {
		t.Fatal(err)
	}
	return page
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func pageJSON(t *testing.T, p *Projection) string {
	t.Helper()
	return jsonOf(t, newestPage(t, p))
}

// pageShape is each stretch of a page as "turn[+]: items", "-" for none and
// "+" for one continued from the older page; an item is "kind@seq-last_seq",
// a tool run's name and status after its kind and its nested items in
// brackets.
func pageShape(page Page) []string {
	var out []string
	for _, stretch := range page.Turns {
		head := "-"
		if stretch.Turn != nil {
			head = stretch.Turn.ID
		}
		if stretch.Continued {
			head += "+"
		}
		out = append(out, head+": "+itemsShapeOf(stretch.Items))
	}
	return out
}

func itemsShapeOf(items []PageItem) string {
	parts := make([]string, len(items))
	for i, item := range items {
		kind := string(item.Kind)
		if tool := item.Tool; tool != nil {
			kind = fmt.Sprintf("%s:%s:%s", tool.ToolUseID, tool.ToolName, tool.Status)
			if len(tool.Children) > 0 {
				kind += "[" + itemsShapeOf(tool.Children) + "]"
			}
		}
		parts[i] = fmt.Sprintf("%s@%d-%d", kind, item.Seq, item.LastSeq)
	}
	return strings.Join(parts, " ")
}

func foldLines(lines ...string) *Projection {
	return Fold(history(lines...), session.AgentTypeClaude)
}

// A page reads on its own: each item is the whole of what the records say
// about it, a subagent's work is inside its call however the records
// interleave, and each stretch names its turn as it stands.
func TestPage_ItemsAreWholeAndNested(t *testing.T) {
	p := foldLines(
		prompt1,                                // 1
		started1,                               // 2
		`T1|{"type":"text","content":"on it"}`, // 3
		`T1|{"type":"tool_call","tool_use_id":"task","tool_name":"Task"}`,                           // 4
		`T1|{"type":"text","content":"sub","parent_tool_use_id":"task"}`,                            // 5
		`T1|{"type":"thinking","content":"main thinks"}`,                                            // 6
		`T1|{"type":"permission_request","request_id":"p1","tool_use_id":"b1","tool_name":"Bash"}`,  // 7
		`T1|{"type":"tool_call","tool_use_id":"b1","tool_name":"Bash","parent_tool_use_id":"task"}`, // 8
		`T1|{"type":"permission_response","request_id":"p1","choice":"allow"}`,                      // 9
		`T1|{"type":"tool_result","tool_use_id":"b1","tool_result":"ok"}`,                           // 10
		`T1|{"type":"tool_result","tool_use_id":"task","tool_result":"done"}`,                       // 11
		asked,     // 12
		answer1In, // 13
		`T1|{"type":"done","observed_at":"2026-01-02T03:06:00Z"}`,   // 14
		`-|{"type":"message","content":"unread","message_id":"m9"}`, // 15
		`null|{"type":"warning","message":"between turns"}`,         // 16
	)
	page := newestPage(t, p)
	assertStrings(t, "page", pageShape(page), []string{
		"T1: message@1-1 text@3-3 task:Task:succeeded[text@5-5 b1:Bash:succeeded@7-10]@4-11 thinking@6-6 question@12-13 message@13-13",
		"-: message@15-15 warning@16-16",
	})

	turn := page.Turns[0].Turn
	if !turn.Ended || turn.Outcome != session.OutcomeCompleted || turn.EndSeq != 14 || turn.EndedAt == nil {
		t.Errorf("turn = %+v, want it ended completed at seq 14 with its moment", turn)
	}
	b1 := page.Turns[0].Items[2].Tool.Children[1].Tool
	if b1.Permission == nil || b1.Permission.Status != PermissionAllowed || b1.Result == nil || b1.Result.Text != "ok" {
		t.Errorf("nested run = %+v, want its permission and result on it", b1)
	}
	if q := page.Turns[0].Items[4].Question; q.Status != QuestionAnswered || q.AnsweredIn != "a1" {
		t.Errorf("question = %+v, want it answered by a1", q)
	}
}

// A message a Stop discarded says so, and its turn lists it; a read point is
// an item where the agent read the message.
func TestPage_DiscardedAndReadMessages(t *testing.T) {
	p := foldLines(
		prompt1, started1,
		prompt2,
		`T1|{"type":"message_ingested","message_id":"m2"}`,
		`-|{"type":"message","content":"too late","message_id":"m3"}`,
		`T1|{"type":"message_discarded","message_id":"m3"}`,
		`T1|{"type":"interrupted"}`,
	)
	page := newestPage(t, p)
	assertStrings(t, "page", pageShape(page), []string{"T1: message@1-1 message@3-3 read@4-4 message@5-5"})
	stretch := page.Turns[0]
	if !stretch.Items[3].Message.Discarded || stretch.Items[1].Message.Discarded {
		t.Errorf("discarded = %v, %v; want only m3", stretch.Items[1].Message.Discarded, stretch.Items[3].Message.Discarded)
	}
	if len(stretch.Discarded) != 1 || stretch.Discarded[0].MessageID != "m3" {
		t.Errorf("turn's discarded = %+v, want m3", stretch.Discarded)
	}
	if stretch.Turn.Outcome != session.OutcomeAborted {
		t.Errorf("outcome = %q, want aborted", stretch.Turn.Outcome)
	}
}

// A plan filed on a call rides on its run; one on no call is an item, and
// the session's current plan comes with every page.
func TestPage_Plans(t *testing.T) {
	p := foldLines(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"todo","tool_name":"TodoWrite"}`,
		`T1|{"type":"plan","tool_use_id":"todo","steps":[{"text":"a","status":"pending"}]}`,
		`T1|{"type":"plan","plan_id":"x","steps":[{"text":"b","status":"in_progress"}]}`,
	)
	page := newestPage(t, p)
	assertStrings(t, "page", pageShape(page), []string{"T1: message@1-1 todo:TodoWrite:running@3-4 plan@5-5"})
	if plan := page.Turns[0].Items[1].Tool.Plan; plan == nil || plan.Steps[0].Text != "a" {
		t.Errorf("run's plan = %+v, want the one filed on it", plan)
	}
	if page.Plan == nil || page.Plan.Seq != 5 || page.Plan.Plan.Steps[0].Text != "b" {
		t.Errorf("current plan = %+v, want the newest", page.Plan)
	}
}

// textHistory is a prompt and its turn, then n texts in it.
func textHistory(n int) []string {
	lines := []string{prompt1, started1}
	for i := 1; i <= n; i++ {
		lines = append(lines, fmt.Sprintf(`T1|{"type":"text","content":"t%d"}`, i))
	}
	return lines
}

// Walking the cursors back yields every item exactly once, a turn the
// boundary cuts saying so on the newer side, and the budget is spent in
// records: a run with its nested work is one item that weighs all of it.
func TestPage_WalksBackInRecords(t *testing.T) {
	lines := append(textHistory(2),
		`T1|{"type":"tool_call","tool_use_id":"task","tool_name":"Task"}`, // 5
		`T1|{"type":"text","content":"s1","parent_tool_use_id":"task"}`,
		`T1|{"type":"text","content":"s2","parent_tool_use_id":"task"}`,
		`T1|{"type":"text","content":"t3"}`, // 8
	)
	p := foldLines(lines...)

	newest, err := p.Page(session.NoHistorySeq, 2)
	if err != nil {
		t.Fatal(err)
	}
	// t3 spends 1, the run 3: the page ends on the run, whole.
	assertStrings(t, "newest", pageShape(newest), []string{"T1+: task:Task:running[text@6-6 text@7-7]@5-7 text@8-8"})
	if !newest.HasMore || newest.NextBeforeSeq != 5 || newest.ThroughSeq != 8 {
		t.Errorf("newest: more %v, next %d, through %d; want more, 5, 8", newest.HasMore, newest.NextBeforeSeq, newest.ThroughSeq)
	}

	older, err := p.Page(newest.NextBeforeSeq, 2)
	if err != nil {
		t.Fatal(err)
	}
	assertStrings(t, "older", pageShape(older), []string{"T1+: text@3-3 text@4-4"})
	oldest, err := p.Page(older.NextBeforeSeq, 2)
	if err != nil {
		t.Fatal(err)
	}
	assertStrings(t, "oldest", pageShape(oldest), []string{"T1: message@1-1"})
	if oldest.HasMore || oldest.NextBeforeSeq != session.NoHistorySeq {
		t.Errorf("oldest: more %v, next %d; want neither", oldest.HasMore, oldest.NextBeforeSeq)
	}
}

// A cursor in a gap still means "older than it"; one past the newest record,
// or below the first, names nothing.
func TestPage_Cursors(t *testing.T) {
	p := foldLines(textHistory(3)...)
	page, err := p.Page(4, 10)
	if err != nil {
		t.Fatal(err)
	}
	assertStrings(t, "before 4", pageShape(page), []string{"T1: message@1-1 text@3-3"})

	for _, before := range []session.HistorySeq{6, -1} {
		if _, err := p.Page(before, 10); !errors.Is(err, ErrInvalidCursor) {
			t.Errorf("before %d: err = %v, want ErrInvalidCursor", before, err)
		}
	}
	if _, err := p.Page(session.NoHistorySeq, -1); !errors.Is(err, ErrInvalidLimit) {
		t.Errorf("negative limit: err = %v, want ErrInvalidLimit", err)
	}
	if page, err := p.Page(session.NoHistorySeq, 0); err != nil || len(page.Turns[0].Items) != 4 {
		t.Errorf("default limit: %v, %+v; want every item", err, page)
	}
}

// One record can make several items (a legacy ask_user_question asking
// several questions): they share its seq, so a page takes all of them or
// none, or the page before it would end short of the rest.
func TestPage_ItemsOfOneRecordStayTogether(t *testing.T) {
	p := foldLines(
		prompt1,
		`-|{"type":"ask_user_question","tool_use_id":"tu","request_id":"r1","questions":[`+
			`{"question":"A?","header":"A","options":[]},{"question":"B?","header":"B","options":[]}]}`,
		`-|{"type":"text","content":"after"}`,
	)
	items := func(page Page) []string {
		var out []string
		for _, stretch := range page.Turns {
			out = append(out, itemsShapeOf(stretch.Items))
		}
		return out
	}
	var paged []string
	before := session.NoHistorySeq
	for {
		page, err := p.Page(before, 2)
		if err != nil {
			t.Fatal(err)
		}
		paged = append(items(page), paged...)
		if !page.HasMore {
			break
		}
		before = page.NextBeforeSeq
	}
	if got, want := strings.Join(paged, " "), strings.Join(items(newestPage(t, p)), " "); got != want {
		t.Errorf("paged back: %s\nwhole:     %s", got, want)
	}
}

// The warning a damaged file gets is in no file: it has no seq of its own,
// and a page never starts on it, since its cursor would name nothing.
func TestPage_ItemInNoFile(t *testing.T) {
	records := history(textHistory(2)...)
	records = append(records, json.RawMessage(`{"seq":0,"type":"warning","message":"damaged"}`))
	p := Fold(records, session.AgentTypeClaude)

	page, err := p.Page(session.NoHistorySeq, 1)
	if err != nil {
		t.Fatal(err)
	}
	items := page.Turns[len(page.Turns)-1].Items
	if got := items[len(items)-1]; got.Kind != KindWarning || got.Seq != session.NoHistorySeq {
		t.Fatalf("last item = %+v, want the warning without a seq", got)
	}
	if page.NextBeforeSeq != 4 {
		t.Errorf("next = %d, want the numbered item before the warning", page.NextBeforeSeq)
	}
}

// A message nothing followed yet is read as if nothing will: the page holds
// it, outside any turn, as State would; the turn it opens takes it in.
func TestPage_TrailingMessage(t *testing.T) {
	lines := []string{prompt1, started1, `T1|{"type":"done"}`, prompt2, started2}
	records := history(lines...)
	p := Fold(records[:4], session.AgentTypeClaude)
	assertStrings(t, "before its turn", pageShape(newestPage(t, p)), []string{"T1: message@1-1", "-: message@4-4"})
	p.Append(records[4])
	assertStrings(t, "in its turn", pageShape(newestPage(t, p)), []string{"T1: message@1-1", "T2: message@4-4"})
}

// A Codex straggler, tagged with a turn after the next has started, is a
// stretch of its own naming that turn.
func TestPage_StragglerIsAStretchOfItsTurn(t *testing.T) {
	p := foldLines(
		prompt1, started1,
		`T1|{"type":"done"}`,
		prompt2, started2,
		`T1|{"type":"text","content":"late"}`,
	)
	got := pageShape(newestPage(t, p))
	assertStrings(t, "page", got, []string{"T1: message@1-1", "T2: message@4-4", "T1: text@6-6"})
	if slices.ContainsFunc(newestPage(t, p).Turns[2:], func(s PageTurn) bool { return s.Continued }) {
		t.Error("the straggler's stretch reads as continued from an older page")
	}
}
