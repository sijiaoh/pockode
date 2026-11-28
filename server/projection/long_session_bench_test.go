package projection

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// What serving a long, open session costs: the shape web/src/bench's
// longSession builds — 300 settled turns of planning, thinking, talk, 56
// top-level calls and two ten-call subagents each, about 53k records — and an
// open turn whose subagent is still running, which live records go into.
//
//	go test ./projection -run '^$' -bench LongSession -benchmem

const (
	benchSessionID = "long"
	benchTurns     = 300
	benchLiveAgent = "live-agent"
	benchOpenTurn  = "T-open"
)

// longSessionLines are the session's history, as appendLines takes them.
func longSessionLines(turns int) []string {
	var lines []string
	add := func(turn, format string, args ...any) {
		lines = append(lines, turn+"|"+fmt.Sprintf(format, args...))
	}
	paragraph := "Looked at how the handler retries; the backoff is applied twice when the server sends Retry-After, so the second attempt waits far longer than intended."
	call := func(turn, id, parent string, n int) {
		p := ""
		if parent != "" {
			p = fmt.Sprintf(`,"parent_tool_use_id":%q`, parent)
		}
		add(turn, `{"type":"tool_call","tool_use_id":%q,"tool_name":"Read","tool_input":{"file_path":"/work/project/server/internal/pkg%d/module%d.go"}%s}`, id, n%37, n%101, p)
	}
	result := func(turn, id, parent, text string) {
		p := ""
		if parent != "" {
			p = fmt.Sprintf(`,"parent_tool_use_id":%q`, parent)
		}
		add(turn, `{"type":"tool_result","tool_use_id":%q,"tool_result":%q,"duration_ms":800%s}`, id, text, p)
	}
	tool := func(turn, parent string, n int) {
		id := fmt.Sprintf("call-%d", len(lines))
		call(turn, id, parent, n)
		result(turn, id, parent, fmt.Sprintf("package pkg%d\n\nfunc Handle() error {\n\treturn nil\n}\n", n%37))
	}
	plan := func(turn string, done, total int) {
		id := fmt.Sprintf("plan-%d", len(lines))
		add(turn, `{"type":"tool_call","tool_use_id":%q,"tool_name":"TodoWrite","tool_input":{"todos":[]}}`, id)
		result(turn, id, "", "Todos have been modified successfully.")
		steps := make([]string, total)
		for i := range steps {
			status := "pending"
			if i < done {
				status = "completed"
			} else if i == done {
				status = "in_progress"
			}
			steps[i] = fmt.Sprintf(`{"id":"%d","text":"Step %d of the plan","status":%q}`, i+1, i+1, status)
		}
		add(turn, `{"type":"plan","tool_use_id":%q,"steps":[%s]}`, id, strings.Join(steps, ","))
	}
	agent := func(turn, id string, n, children int, settle bool) {
		add(turn, `{"type":"tool_call","tool_use_id":%q,"tool_name":"Agent","tool_input":{"description":"Investigate area %d","subagent_type":"Explore","prompt":"Find where the retry is applied."}}`, id, n)
		add(turn, `{"type":"text","content":"Starting with the transport package.","parent_tool_use_id":%q}`, id)
		for c := range children {
			tool(turn, id, n*100+c)
		}
		add(turn, `{"type":"text","content":%q,"parent_tool_use_id":%q}`, paragraph, id)
		if settle {
			result(turn, id, "", paragraph+"\n\nagentId: agent-"+id)
		}
	}
	open := func(turn, message, content string) {
		add("-", `{"type":"message","content":%q,"message_id":%q}`, content, message)
		add(turn, `{"type":"turn_started","turn_id":%q,"origin":"prompt","message_id":%q}`, turn, message)
	}

	var agents []string
	for t := range turns {
		turn := fmt.Sprintf("T%d", t)
		open(turn, fmt.Sprintf("m%d", t), fmt.Sprintf("Turn %d: fix the retry handling in package %d.", t, t))
		add(turn, `{"type":"thinking","content":"Planning how to approach this.","duration_ms":1200}`)
		add(turn, `{"type":"text","content":"On it — turn %d."}`, t)
		plan(turn, 3, 5)
		for c := range 56 {
			tool(turn, "", t*1000+c)
			if c%8 == 7 {
				add(turn, `{"type":"text","content":%q}`, paragraph)
			}
		}
		for a := range 2 {
			id := fmt.Sprintf("agent-%d-%d", t, a)
			agent(turn, id, t*10+a, 10, true)
			agents = append(agents, id)
		}
		if t > 0 && t%10 == 0 {
			resumed := agents[len(agents)-3]
			id := fmt.Sprintf("send-%d", t)
			add(turn, `{"type":"tool_call","tool_use_id":%q,"tool_name":"SendMessage","tool_input":{"to":"agent-%s","message":"Now check the client side too."}}`, id, resumed)
			for c := range 3 {
				tool(turn, resumed, t*1000+c)
			}
			result(turn, id, "", "Message sent.")
		}
		add(turn, `{"type":"text","content":%q}`, paragraph+"\n\n"+paragraph)
		add(turn, `{"type":"done"}`)
	}

	open(benchOpenTurn, "m-open", "Now the client side, please.")
	add(benchOpenTurn, `{"type":"text","content":"Looking at the client."}`)
	plan(benchOpenTurn, 1, 6)
	for c := range 30 {
		tool(benchOpenTurn, "", 9_000_000+c)
	}
	agent(benchOpenTurn, benchLiveAgent, 9_999, 5, false)
	return lines
}

func appendLines(tb testing.TB, store *session.FileStore, id string, lines []string) {
	tb.Helper()
	for _, line := range lines {
		turn, rec, _ := strings.Cut(line, "|")
		tag := session.InTurn(turn)
		if turn == "-" {
			tag = session.HistoryTurn{}
		}
		if _, err := store.AppendToHistory(context.Background(), id, rawRecord(rec), tag); err != nil {
			tb.Fatal(err)
		}
	}
}

// longSessionStore is a store holding the long session, its projection
// tracked.
func longSessionStore(b *testing.B) (*session.FileStore, *Live) {
	b.Helper()
	store, err := session.NewFileStore(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	live := Track(store)
	if _, err := store.Create(context.Background(), benchSessionID, session.CreateSpec{AgentType: session.AgentTypeClaude}); err != nil {
		b.Fatal(err)
	}
	appendLines(b, store, benchSessionID, longSessionLines(benchTurns))
	return store, live
}

// The newest page, as a subscribe cuts it, of a session somebody already
// holds, or let go of lately (Live's linger): what every subscribe after the
// first costs.
func BenchmarkLongSession_SubscribePageHeld(b *testing.B) {
	_, live := longSessionStore(b)
	defer live.Hold(benchSessionID)()
	ctx := context.Background()
	if _, err := live.Page(ctx, benchSessionID, session.NoHistorySeq, 0); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for b.Loop() {
		page, err := live.Page(ctx, benchSessionID, session.NoHistorySeq, 0)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := json.Marshal(page); err != nil {
			b.Fatal(err)
		}
	}
}

// The first subscribe to a session nobody holds or has read lately: the file
// is read and folded, and the fold kept.
func BenchmarkLongSession_SubscribePageCold(b *testing.B) {
	_, live := longSessionStore(b)
	live.linger = 0
	ctx := context.Background()
	for b.Loop() {
		release := live.Hold(benchSessionID)
		page, err := live.Page(ctx, benchSessionID, session.NoHistorySeq, 0)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := json.Marshal(page); err != nil {
			b.Fatal(err)
		}
		release()
	}
}

// Paging back through a held session, a page a request, from the newest to
// the oldest; reported per page.
func BenchmarkLongSession_OlderPageHeld(b *testing.B) {
	_, live := longSessionStore(b)
	defer live.Hold(benchSessionID)()
	ctx := context.Background()
	first, err := live.Page(ctx, benchSessionID, session.NoHistorySeq, 0)
	if err != nil {
		b.Fatal(err)
	}
	cursor := first.NextBeforeSeq
	b.ResetTimer()
	for b.Loop() {
		if cursor == session.NoHistorySeq {
			cursor = first.NextBeforeSeq
		}
		page, err := live.Page(ctx, benchSessionID, cursor, 0)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := json.Marshal(page); err != nil {
			b.Fatal(err)
		}
		cursor = page.NextBeforeSeq
	}
}

// One live record written into the open subagent, and the chat.update it
// makes: the append (folded as it is written), the update taken and encoded.
func BenchmarkLongSession_LiveRecordUpdate(b *testing.B) {
	store, live := longSessionStore(b)
	defer live.Hold(benchSessionID)()
	ctx := context.Background()
	if _, err := live.Page(ctx, benchSessionID, session.NoHistorySeq, 0); err != nil {
		b.Fatal(err)
	}
	n := 0
	b.ResetTimer()
	for b.Loop() {
		id := fmt.Sprintf("live-%d", n/2)
		rec := fmt.Sprintf(`{"type":"tool_call","tool_use_id":%q,"tool_name":"Grep","tool_input":{"pattern":"retry%d"},"parent_tool_use_id":%q}`, id, n, benchLiveAgent)
		if n%2 == 1 {
			rec = fmt.Sprintf(`{"type":"tool_result","tool_use_id":%q,"tool_result":"web/src/lib/retry.ts:12","parent_tool_use_id":%q}`, id, benchLiveAgent)
		}
		n++
		if _, err := store.AppendToHistory(ctx, benchSessionID, rawRecord(rec), session.InTurn(benchOpenTurn)); err != nil {
			b.Fatal(err)
		}
		u, _, err := live.TakeUpdate(ctx, benchSessionID)
		if err != nil {
			b.Fatal(err)
		}
		if u.Empty() {
			b.Fatal("the record changed nothing")
		}
		if _, err := json.Marshal(u); err != nil {
			b.Fatal(err)
		}
	}
}

// The fold alone, of a history already read: what a first read costs beyond
// reading the file.
func BenchmarkLongSession_Fold(b *testing.B) {
	store, _ := longSessionStore(b)
	records, err := store.GetHistory(context.Background(), benchSessionID)
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for b.Loop() {
		Fold(records, session.AgentTypeClaude)
	}
}

// Reading the file alone, as main's subscribe did before cutting a page.
func BenchmarkLongSession_ReadFile(b *testing.B) {
	store, _ := longSessionStore(b)
	for b.Loop() {
		if _, err := store.GetHistory(context.Background(), benchSessionID); err != nil {
			b.Fatal(err)
		}
	}
}

// Paging back through the session of a worktree that is not loaded, as
// session_view.history reads it (worktree.Manager.SessionProjections): kept by
// Folds, each page a stat and a cut once the first has folded the file.
func BenchmarkLongSession_OlderPageUnloaded(b *testing.B) {
	benchUnloadedPages(b, NewFolds(time.Hour))
}

// The same with nothing kept (FromReader, as SessionProjections served it
// before Folds): every page folds the whole file.
func BenchmarkLongSession_OlderPageUnloadedUnkept(b *testing.B) {
	benchUnloadedPages(b, NewFolds(0))
}

func benchUnloadedPages(b *testing.B, folds *Folds) {
	dir := b.TempDir()
	store, err := session.NewFileStore(dir)
	if err != nil {
		b.Fatal(err)
	}
	if _, err := store.Create(context.Background(), benchSessionID, session.CreateSpec{AgentType: session.AgentTypeClaude}); err != nil {
		b.Fatal(err)
	}
	appendLines(b, store, benchSessionID, longSessionLines(benchTurns))
	src := folds.Source(session.NewDirReader(dir))
	ctx := context.Background()
	first, err := src.Page(ctx, benchSessionID, session.NoHistorySeq, 0)
	if err != nil {
		b.Fatal(err)
	}
	cursor := first.NextBeforeSeq
	b.ResetTimer()
	for b.Loop() {
		if cursor == session.NoHistorySeq {
			cursor = first.NextBeforeSeq
		}
		page, err := src.Page(ctx, benchSessionID, cursor, 0)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := json.Marshal(page); err != nil {
			b.Fatal(err)
		}
		cursor = page.NextBeforeSeq
	}
}
