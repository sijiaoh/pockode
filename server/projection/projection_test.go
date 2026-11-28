package projection

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// history numbers lines as a version-3 file holds them, each "turn|record": a
// turn id, "null" for none, or "-" for an untagged line — a message, or a line
// written before turns had ids.
func history(lines ...string) []json.RawMessage {
	records := make([]json.RawMessage, len(lines))
	for i, line := range lines {
		turn, rec, _ := strings.Cut(line, "|")
		tag := `"turn":"` + turn + `",`
		switch turn {
		case "null":
			tag = `"turn":null,`
		case "-":
			tag = ""
		}
		v := 3
		if turn == "-" && !strings.Contains(rec, `"type":"message"`) {
			v = 2
		}
		records[i] = json.RawMessage(fmt.Sprintf(`{"seq":%d,"v":%d,%s%s`, i+1, v, tag, strings.TrimPrefix(rec, "{")))
	}
	return records
}

func fold(lines ...string) State {
	return Fold(history(lines...), session.AgentTypeClaude).State()
}

// turnsShape is "id:outcome" per turn, "id:open" for one with no ending.
func turnsShape(s State) []string {
	var out []string
	for _, turn := range s.Turns {
		status := "open"
		if turn.Ended {
			status = string(turn.Outcome)
		}
		out = append(out, turn.ID+":"+status)
	}
	return out
}

func questionsShape(s State) []string {
	var out []string
	for _, q := range s.Questions {
		out = append(out, q.RequestID+":"+string(q.Status))
	}
	return out
}

func unansweredIDs(s State) []string {
	var out []string
	for _, q := range s.Unanswered() {
		out = append(out, q.RequestID)
	}
	return out
}

// samePending holds an empty list and none to be the same list.
func samePending(a, b []session.PendingQuestion) bool {
	return len(a) == 0 && len(b) == 0 || reflect.DeepEqual(a, b)
}

func assertStrings(t *testing.T, what string, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Errorf("%s = %q, want %q", what, got, want)
	}
}

const (
	prompt1   = `-|{"type":"message","content":"go","message_id":"m1"}`
	started1  = `T1|{"type":"turn_started","turn_id":"T1","origin":"prompt","message_id":"m1","observed_at":"2026-01-02T03:04:05Z"}`
	prompt2   = `-|{"type":"message","content":"more","message_id":"m2"}`
	started2  = `T2|{"type":"turn_started","turn_id":"T2","origin":"prompt","message_id":"m2"}`
	asked     = `T1|{"type":"question_posted","request_id":"q1","questions":[{"question":"Which DB?","header":"DB","options":[{"label":"Postgres"},{"label":"SQLite"}],"multiSelect":false}],"asked_at":"2026-01-02T03:04:06Z"}`
	askedQ2   = `T1|{"type":"question_posted","request_id":"q2","questions":[{"question":"Name?","header":"Name","options":[],"multiSelect":false}]}`
	answer1In = `-|{"type":"message","content":"Answering:","message_id":"a1","answering":[{"request_id":"q1","answers":["Postgres"],"answered_at":"2026-01-02T03:05:00Z"}]}`
)

// TestTurns_ReadOffTheRecordedIdentity: a turn_started opens a turn and the
// ending tagged with it closes it, how it ended included; a process_ended
// belongs to no turn and ends whichever is open; an ending tagged with no turn,
// or a straggler of the turn before, ends nothing.
func TestTurns_ReadOffTheRecordedIdentity(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"text","content":"working"}`,
		`T1|{"type":"interrupted"}`,
		`null|{"type":"done"}`,
		prompt2, started2,
		`T1|{"type":"tool_result","tool_use_id":"x"}`,
		`T1|{"type":"error","error":"late"}`,
		`T2|{"type":"error","error":"bad"}`,
		`T3|{"type":"turn_started","turn_id":"T3","origin":"output"}`,
		`null|{"type":"process_ended"}`,
		`T4|{"type":"turn_started","turn_id":"T4","origin":"answer"}`,
	)
	assertStrings(t, "turns", turnsShape(s), []string{"T1:aborted", "T2:failed", "T3:aborted", "T4:open"})
	if got := s.OpenTurn(); got != "T4" {
		t.Errorf("OpenTurn = %q, want T4", got)
	}
	first := s.Turns[0]
	if first.MessageID != "m1" || first.Origin != agent.TurnOriginPrompt || first.StartSeq != 2 || first.EndSeq != 4 ||
		first.StartedAt == nil || !first.StartedAt.Equal(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)) {
		t.Errorf("first turn = %+v", first)
	}
}

// TestTurns_InferredForOldLines: lines written before turns had ids get the
// turns agent.InferHistoryTurns gives them, with no seq for the turn_started
// no file holds — and the turn left open is the inferred one still running.
func TestTurns_InferredForOldLines(t *testing.T) {
	records := history(
		`-|{"type":"message","content":"fix it","message_id":"m1"}`,
		`-|{"type":"text","content":"fixed"}`,
		`-|{"type":"done"}`,
		`-|{"type":"text","content":"one more thing"}`,
	)
	s := Fold(records, session.AgentTypeClaude).State()
	assertStrings(t, "turns", turnsShape(s), []string{"legacy-1:completed", "legacy-4:open"})
	if s.Turns[0].StartSeq != session.NoHistorySeq || s.Turns[0].EndSeq != 3 {
		t.Errorf("first turn = %+v", s.Turns[0])
	}
	if got := s.OpenTurn(); got != "legacy-4" {
		t.Errorf("OpenTurn = %q, want legacy-4", got)
	}
	// Codex names every turn before its content: what follows a done is a
	// straggler of that turn, and opens none.
	codex := Fold(records, session.AgentTypeCodex).State()
	assertStrings(t, "Codex turns", turnsShape(codex), []string{"legacy-1:completed"})
}

// TestTurns_OpenTurn: the turn a history leaves open is what a fork cut there
// ends with a process_ended of its own.
func TestTurns_OpenTurn(t *testing.T) {
	opened := []string{prompt1, started1, `T1|{"type":"text","content":"working"}`}
	tests := []struct {
		name  string
		lines []string
		want  string
	}{
		{"no turn ever", nil, ""},
		{"a turn the cut went through", opened, "T1"},
		{"a turn its agent ended", append(slices.Clone(opened), `T1|{"type":"interrupted"}`), ""},
		{"a turn its process stopped carrying", append(slices.Clone(opened), `null|{"type":"process_ended"}`), ""},
		{"an ending in no turn ends nothing", append(slices.Clone(opened), `null|{"type":"done"}`), "T1"},
		{"a straggler of the turn before", append(slices.Clone(opened),
			`T1|{"type":"done"}`,
			`T2|{"type":"turn_started","turn_id":"T2","origin":"output"}`,
			`T1|{"type":"tool_result","tool_use_id":"x"}`,
			`T1|{"type":"error","error":"late"}`), "T2"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := fold(tc.lines...).OpenTurn(); got != tc.want {
				t.Errorf("OpenTurn = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestQuestions_WhatBecameOfEach(t *testing.T) {
	s := fold(
		prompt1, started1, asked, askedQ2,
		`T1|{"type":"question_posted","request_id":"q3","questions":[{"question":"Why?","header":"Why"}]}`,
		answer1In,
		`-|{"type":"message","content":"Answering:","message_id":"a2","answering":[{"request_id":"q2","declined":true}]}`,
		`T1|{"type":"request_cancelled","request_id":"q3","reason":"step_done","resolved_at":"2026-01-02T03:06:00Z"}`,
		`T1|{"type":"request_cancelled","request_id":"perm-1"}`,
	)
	assertStrings(t, "questions", questionsShape(s), []string{"q1:answered", "q2:declined", "q3:withdrawn"})
	if len(s.Unanswered()) != 0 {
		t.Errorf("unanswered = %v, want none", s.Unanswered())
	}

	q1, _ := s.Posted("q1")
	if q1.TurnID != "T1" || q1.AnsweredIn != "a1" || q1.Answer == nil || !slices.Equal(q1.Answer.Answers, []string{"Postgres"}) {
		t.Errorf("q1 = %+v", q1)
	}
	q3, _ := s.Posted("q3")
	if q3.Reason != agent.ReasonStepDone || q3.ResolvedAt == nil {
		t.Errorf("q3 = %+v", q3)
	}
}

// TestQuestions_UnansweredIsWhatAForkInherits: the questions still open, whole,
// in the order the session's list keeps them.
func TestQuestions_UnansweredIsWhatAForkInherits(t *testing.T) {
	records := history(
		prompt1, started1, asked, askedQ2,
		answer1In,
		`T1|{"type":"message_discarded","message_id":"a1"}`, // q1 back, behind q2
		`T1|{"type":"interrupted"}`,
	)
	s := Fold(records, session.AgentTypeClaude).State()
	assertStrings(t, "unanswered", unansweredIDs(s), []string{"q2", "q1"})
	if q := s.Unanswered()[1]; q.Header != "DB" || len(q.Options) != 2 {
		t.Errorf("reopened question = %+v, want it whole", q)
	}
	q1, _ := s.Posted("q1")
	if q1.Status != QuestionOpen || q1.Answer != nil || q1.AnsweredIn != "" {
		t.Errorf("q1 after its answer was discarded = %+v", q1)
	}
	// What its card still shows of the answer the Stop threw away.
	if q1.DiscardedIn != "a1" || q1.DiscardedAnswer == nil || !slices.Equal(q1.DiscardedAnswer.Answers, []string{"Postgres"}) {
		t.Errorf("q1's discarded answer = %+v in %q", q1.DiscardedAnswer, q1.DiscardedIn)
	}
	if len(s.Discarded) != 1 || s.Discarded[0] != (DiscardedMessage{MessageID: "a1", Seq: 6, TurnID: "T1"}) {
		t.Errorf("discarded = %+v", s.Discarded)
	}
}

// TestQuestions_UnansweredCarriesTheWholeQuestion: a fork inherits something
// the user can actually answer, so the options and the header have to survive
// the round trip through the record — including one written before options
// could be recommended, which carries no such key.
func TestQuestions_UnansweredCarriesTheWholeQuestion(t *testing.T) {
	s := fold(prompt1, started1,
		`T1|{"type":"question_posted","request_id":"q1","questions":[{"question":"Which database?","header":"Database","options":[{"label":"Postgres","description":"the one we have","recommended":true},{"label":"SQLite"}],"multiSelect":true}],"asked_at":"2026-01-02T03:04:06Z"}`,
		`T1|{"type":"question_posted","request_id":"q2","questions":[{"question":"Which?","header":"DB","options":[{"label":"Postgres","description":""}],"multiSelect":false}]}`,
	)
	want := []session.PendingQuestion{{
		RequestID: "q1", Header: "Database", Question: "Which database?", MultiSelect: true,
		Options: []session.QuestionOption{{Label: "Postgres", Description: "the one we have", Recommended: true}, {Label: "SQLite"}},
		AskedAt: time.Date(2026, 1, 2, 3, 4, 6, 0, time.UTC),
	}, {
		RequestID: "q2", Header: "DB", Question: "Which?",
		Options: []session.QuestionOption{{Label: "Postgres"}},
	}}
	if got := s.Unanswered(); !reflect.DeepEqual(got, want) {
		t.Errorf("unanswered =\n  %+v\nwant\n  %+v", got, want)
	}
}

// TestQuestions_UnansweredAtTheCut is what makes fork inheritance right: what
// crosses is what was open *at the cut*, so each of the three ways a question
// leaves the list has to be read out of the records — and a resolution past
// the cut, not being in them, leaves the question open. A discarded answer is
// no answer, and one given afresh after it holds.
func TestQuestions_UnansweredAtTheCut(t *testing.T) {
	both := []string{prompt1, started1, asked, askedQ2}
	tests := []struct {
		name  string
		lines []string
		want  []string
	}{
		{"nothing resolved", both, []string{"q1", "q2"}},
		{"answered", append(slices.Clone(both), answer1In), []string{"q2"}},
		{"declined", append(slices.Clone(both),
			`-|{"type":"message","content":"Answering:","message_id":"a1","answering":[{"request_id":"q1","declined":true}]}`), []string{"q2"}},
		{"withdrawn", append(slices.Clone(both), `T1|{"type":"request_cancelled","request_id":"q1"}`), []string{"q2"}},
		{"answered, then the answer discarded", append(slices.Clone(both), answer1In,
			`T1|{"type":"message_discarded","message_id":"a1"}`), []string{"q2", "q1"}},
		{"answered afresh after the discard", append(slices.Clone(both), answer1In,
			`T1|{"type":"message_discarded","message_id":"a1"}`,
			`-|{"type":"message","content":"Answering:","message_id":"a2","answering":[{"request_id":"q1","answers":["SQLite"]}]}`), []string{"q2"}},
		// An ordinary message, an unparseable line, a question naming no
		// request and a withdrawal of nothing asked leave the list alone.
		{"what it cannot use", []string{prompt1, started1,
			`-|not json at all`,
			`-|{"type":"message","content":"hello","message_id":"m9"}`,
			`T1|{"type":"question_posted","request_id":"","questions":[{"question":"?"}]}`,
			`T1|{"type":"request_cancelled","request_id":"never-asked"}`,
			asked}, []string{"q1"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assertStrings(t, "unanswered", unansweredIDs(fold(tc.lines...)), tc.want)
		})
	}
}

// TestQuestions_AnAnswerIsHeldOnlyWhileItCanBeDiscarded: as the session's
// turn holds it (session.TurnState.Delivered), an answer can be taken back by
// a discard only while the turn it went out in runs, and not once the
// question was withdrawn.
// TestQuestions_ADiscardedAnswerGoesWithTheNextResolution: the answer a Stop
// threw away stays on the question only until something settles it again.
func TestQuestions_ADiscardedAnswerGoesWithTheNextResolution(t *testing.T) {
	discarded := []string{prompt1, started1, asked, answer1In, `T1|{"type":"message_discarded","message_id":"a1"}`}
	for name, next := range map[string]string{
		"answered afresh": `-|{"type":"message","content":"Answering:","message_id":"a2","answering":[{"request_id":"q1","answers":["SQLite"]}]}`,
		"withdrawn":       `T1|{"type":"request_cancelled","request_id":"q1"}`,
	} {
		t.Run(name, func(t *testing.T) {
			q1, _ := fold(append(slices.Clone(discarded), next)...).Posted("q1")
			if q1.DiscardedAnswer != nil || q1.DiscardedIn != "" {
				t.Errorf("q1 = %+v, want its discarded answer gone", q1)
			}
		})
	}
}

func TestQuestions_AnAnswerIsHeldOnlyWhileItCanBeDiscarded(t *testing.T) {
	afterTheTurn := fold(
		prompt1, started1, asked, answer1In,
		`T1|{"type":"done"}`,
		`null|{"type":"message_discarded","message_id":"a1"}`,
	)
	assertStrings(t, "after the turn ended", questionsShape(afterTheTurn), []string{"q1:answered"})

	afterWithdrawal := fold(
		prompt1, started1, asked, answer1In,
		`T1|{"type":"request_cancelled","request_id":"q1","reason":"work_closed"}`,
		`T1|{"type":"message_discarded","message_id":"a1"}`,
	)
	assertStrings(t, "after it was withdrawn", questionsShape(afterWithdrawal), []string{"q1:withdrawn"})
	assertStrings(t, "unanswered after it was withdrawn", unansweredIDs(afterWithdrawal), nil)
}

// TestQuestions_LegacyAskUserQuestion: the CLI's own question, several under
// one request id, answered in the old flat shape — labels joined by ", ",
// free text behind "Other: " — or cancelled by a null map. Nothing can answer
// one any more, so an open one is not unanswered.
func TestQuestions_LegacyAskUserQuestion(t *testing.T) {
	s := fold(
		`-|{"type":"message","content":"go","message_id":"m1"}`,
		`-|{"type":"ask_user_question","tool_use_id":"tu1","request_id":"r1","questions":[`+
			`{"question":"Which stack?","header":"Stack","options":[{"label":"React"},{"label":"React Native"},{"label":"Vue, 3"}],"multiSelect":true},`+
			`{"question":"Anything else?","header":"Else","options":[{"label":"No"}],"multiSelect":false}]}`,
		`-|{"type":"question_response","request_id":"r1","answers":{"Which stack?":"React Native, Vue, 3","Else":"Other: tabs, not spaces"}}`,
		`-|{"type":"ask_user_question","tool_use_id":"tu2","request_id":"r2","questions":[{"question":"Go on?","header":"Go","options":[]}]}`,
		`-|{"type":"question_response","request_id":"r2"}`,
		`-|{"type":"ask_user_question","tool_use_id":"tu3","request_id":"r3","questions":[{"question":"Still there?","header":"Q","options":[]}]}`,
	)
	assertStrings(t, "questions", questionsShape(s), []string{"r1:answered", "r1:answered", "r2:withdrawn", "r3:open"})
	stack, other := s.Questions[0], s.Questions[1]
	if !stack.Legacy || stack.ToolUseID != "tu1" || stack.TurnID != "legacy-1" {
		t.Errorf("legacy question = %+v", stack)
	}
	if got := stack.Answer.Answers; !slices.Equal(got, []string{"React Native", "Vue, 3"}) || stack.Answer.Text != "" {
		t.Errorf("stack answer = %+v", stack.Answer)
	}
	if len(other.Answer.Answers) != 0 || other.Answer.Text != "tabs, not spaces" {
		t.Errorf("other answer = %+v", other.Answer)
	}
	if len(s.Unanswered()) != 0 {
		t.Errorf("unanswered = %v, want none", s.Unanswered())
	}
	if _, ok := s.Posted("r3"); ok {
		t.Error("a legacy question reads as posted")
	}
}

func TestParseLegacyAnswer(t *testing.T) {
	options := []agent.QuestionOption{{Label: "React"}, {Label: "React Native"}, {Label: "Other: odd"}}
	tests := []struct {
		answer string
		labels []string
		text   string
	}{
		{"", nil, ""},
		{"React", []string{"React"}, ""},
		{"React Native", []string{"React Native"}, ""},
		{"React, React Native", []string{"React", "React Native"}, ""},
		{"Other: odd", []string{"Other: odd"}, ""},
		{"React, Other: mine, really", []string{"React"}, "mine, really"},
		{"Svelte", nil, "Svelte"},
		{"React, Svelte", []string{"React"}, "Svelte"},
		{"Reactive", nil, "Reactive"},
	}
	for _, tc := range tests {
		labels, text := parseLegacyAnswer(tc.answer, options)
		if !slices.Equal(labels, tc.labels) || text != tc.text {
			t.Errorf("parseLegacyAnswer(%q) = %q, %q; want %q, %q", tc.answer, labels, text, tc.labels, tc.text)
		}
	}
}

func TestLookupLegacyAnswer(t *testing.T) {
	q := Question{Question: "Which?", Header: "Pick"}
	tests := []struct {
		name    string
		answers map[string]string
		count   int
		want    string
		found   bool
	}{
		{"by question", map[string]string{"Which?": "a", "Pick": "b"}, 2, "a", true},
		{"by header", map[string]string{"Pick": "b"}, 2, "b", true},
		{"the one entry of the one question", map[string]string{"?": "c"}, 1, "c", true},
		{"one entry among several questions", map[string]string{"?": "c"}, 2, "", false},
	}
	for _, tc := range tests {
		got, found := lookupLegacyAnswer(q, tc.answers, tc.count)
		if got != tc.want || found != tc.found {
			t.Errorf("%s: = %q, %v; want %q, %v", tc.name, got, found, tc.want, tc.found)
		}
	}
}

// TestNormalize_LegacyMessageOrigin: system messages were recorded with
// origin "work" before the concept was renamed.
func TestNormalize_LegacyMessageOrigin(t *testing.T) {
	for _, origin := range []agent.MessageOrigin{"work", agent.MessageOriginSystem} {
		facts := normalize(agent.MessageRecord{Content: "x", Origin: origin})
		if got := facts[0].(messageSent).message.Origin; got != agent.MessageOriginSystem {
			t.Errorf("origin %q reads as %q", origin, got)
		}
	}
	facts := normalize(agent.MessageRecord{Content: "x"})
	if got := facts[0].(messageSent).message.Origin; got != "" {
		t.Errorf("a user's message reads as origin %q", got)
	}
}

// TestDiscarded_LegacyWarning: before message_discarded existed, a Stop
// wrote a warning that named no message and quoted it. It reads as a discard
// in the turn the Stop ended, with what it quoted; any other warning is none.
func TestDiscarded_LegacyWarning(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"warning","code":"message_discarded","message":"Stopping the turn discarded a message the agent had not read yet, so it will not be answered: \"also the lint\""}`,
		`T1|{"type":"warning","code":"other","message":"Stopping the turn discarded a message the agent had not read yet, so it will not be answered: x"}`,
		`T1|{"type":"interrupted"}`,
	)
	want := []DiscardedMessage{{Excerpt: `"also the lint"`, Seq: 3, TurnID: "T1"}}
	if !reflect.DeepEqual(s.Discarded, want) {
		t.Errorf("discarded = %+v, want %+v", s.Discarded, want)
	}
}

func TestReadPoints(t *testing.T) {
	s := fold(
		prompt1, started1, prompt2,
		`T1|{"type":"message_ingested","message_id":"m2","observed_at":"2026-01-02T03:04:07Z"}`,
	)
	if len(s.ReadPoints) != 1 {
		t.Fatalf("read points = %+v", s.ReadPoints)
	}
	if p := s.ReadPoints[0]; p.MessageID != "m2" || p.Seq != 4 || p.TurnID != "T1" || p.ObservedAt == nil {
		t.Errorf("read point = %+v", p)
	}
}

// TestPlan: the current plan is the newest main-thread one, whoever stated
// it; a subagent's own checklist is not the session's. The seed is the newest
// main-thread plan that came out of a Claude call, when it is a snapshot of
// the Task-tool fold: a TodoWrite list has no task ids to seed one with.
func TestPlan(t *testing.T) {
	taskFold := `T1|{"type":"plan","tool_use_id":"c1","steps":[{"id":"1","text":"a","status":"completed"},{"id":"2","text":"b","status":"pending"}]}`
	seed := []agent.PlanStep{{ID: "1", Text: "a", Status: agent.PlanStepCompleted}, {ID: "2", Text: "b", Status: agent.PlanStepPending}}
	tests := []struct {
		name    string
		lines   []string
		current string
		seed    []agent.PlanStep
	}{
		{"none", []string{prompt1, started1,
			`T1|{"type":"text","content":"plan"}`,
			`T1|{"type":"tool_call","tool_use_id":"r1","tool_name":"Read"}`,
		}, "", nil},
		{"a task fold", []string{prompt1, started1,
			`T1|{"type":"plan","tool_use_id":"c0","steps":[{"id":"1","text":"a","status":"pending"}]}`,
			taskFold,
			`T1|{"type":"plan","tool_use_id":"c2","parent_tool_use_id":"sub","steps":[{"text":"theirs","status":"pending"}]}`,
			`T1|{"type":"text","content":"the plan is done"}`,
		}, "c1", seed},
		{"a TodoWrite list after it", []string{prompt1, started1,
			taskFold,
			`T1|{"type":"plan","tool_use_id":"c3","steps":[{"text":"b","status":"pending"}]}`,
		}, "c3", nil},
		{"a Codex plan after a task fold", []string{prompt1, started1,
			taskFold,
			`T1|{"type":"plan","plan_id":"turn:plan:1","steps":[{"text":"c","status":"pending"}]}`,
		}, "turn:plan:1", seed},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := fold(tc.lines...)
			current := ""
			if s.Plan != nil {
				current = s.Plan.Record.ToolUseID + s.Plan.Record.PlanID
				if s.Plan.TurnID != "T1" {
					t.Errorf("plan turn = %q", s.Plan.TurnID)
				}
			}
			if current != tc.current {
				t.Errorf("current plan = %q, want %q", current, tc.current)
			}
			if got := s.PlanSeed(); !reflect.DeepEqual(got, tc.seed) {
				t.Errorf("PlanSeed = %+v, want %+v", got, tc.seed)
			}
		})
	}
}

// mixedHistory is a history of every kind of line, old and new: legacy
// questions and turns inferred from untagged lines, calls nested before their
// parent arrives, permission requests asked again, background work, a Stop
// discarding a message, a straggler.
var mixedHistory = history(
	`-|{"type":"message","content":"old","message_id":"m0","origin":"work"}`,
	`-|{"type":"ask_user_question","tool_use_id":"tu","request_id":"r1","questions":[{"question":"Q?","header":"Q","options":[{"label":"A"}]}]}`,
	`-|{"type":"question_response","request_id":"r1","answers":{"Q?":"A"}}`,
	`-|{"type":"warning","code":"message_discarded","message":"x"}`,
	`-|{"type":"done"}`,
	`null|{"type":"process_ended"}`,
	`-|{"type":"tool_call","tool_use_id":"e0","tool_name":"Edit","tool_input":{"changes":{"/a":{"type":"add","content":"x"}}}}`,
	`-|{"type":"tool_result","tool_use_id":"e0","tool_result":"ok"}`,
	prompt1, started1,
	`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Task"}`,
	`T1|{"type":"tool_call","tool_use_id":"c2","tool_name":"Bash","parent_tool_use_id":"c1"}`,
	`T1|{"type":"permission_request","request_id":"p1","tool_use_id":"c2","tool_name":"Bash"}`,
	`T1|{"type":"permission_response","request_id":"p1","choice":"allow"}`,
	`T1|{"type":"permission_request","request_id":"p2","tool_use_id":"c3","tool_name":"Bash"}`,
	`T1|{"type":"tool_call","tool_use_id":"k1","tool_name":"Bash","parent_tool_use_id":"k0"}`,
	`T1|{"type":"tool_call","tool_use_id":"k0","tool_name":"Task"}`,
	`T1|{"type":"tool_result","tool_use_id":"k0","tool_result":"ok"}`,
	`T1|{"type":"permission_request","request_id":"p3","tool_use_id":"c3","tool_name":"Bash"}`,
	`T1|{"type":"tool_call","tool_use_id":"c3","tool_name":"Bash","subtype":"resumed"}`,
	`T1|{"type":"permission_response","request_id":"p1","choice":"deny","by":"pockode"}`,
	`T1|{"type":"tool_call","tool_use_id":"bg","tool_name":"Bash"}`,
	`T1|{"type":"tool_result","tool_use_id":"bg","tool_result":"started","subtype":"background_started"}`,
	asked, askedQ2,
	`T1|{"type":"plan","tool_use_id":"c1","steps":[{"id":"1","text":"a","status":"pending"}]}`,
	answer1In,
	prompt2,
	`T1|{"type":"message_ingested","message_id":"m2"}`,
	`T1|{"type":"message_discarded","message_id":"a1"}`,
	`T1|{"type":"interrupted"}`,
	`T1|{"type":"tool_call","tool_use_id":"k2","tool_name":"Bash","parent_tool_use_id":"k0"}`,
	`T1|{"type":"tool_call","tool_use_id":"late","tool_name":"Bash"}`,
	`-|{"type":"message","content":"Answering:","message_id":"a3","answering":[{"request_id":"q2","text":"Bob"}]}`,
	`-|{"type":"message","content":"and","message_id":"m3"}`,
	`T3|{"type":"turn_started","turn_id":"T3","origin":"prompt","message_id":"a3"}`,
	`T3|{"type":"request_cancelled","request_id":"q1","reason":"work_closed"}`,
	`T3|{"type":"tool_call","tool_use_id":"c1","tool_name":"Task","subtype":"resumed"}`,
	`T3|{"type":"tool_call","tool_use_id":"c4","tool_name":"Bash","parent_tool_use_id":"c1"}`,
	`T3|{"type":"tool_result","tool_use_id":"bg","tool_result":"done","subtype":"background_result"}`,
	`T3|{"type":"done"}`,
	`-|{"type":"message","content":"last","message_id":"m4"}`,
)

// TestFold_AnyPrefix is the contract fork and an open session both rest on:
// the state after any prefix is the fold of that prefix alone, folding a
// prefix and appending the rest is folding everything at once, and a state
// read earlier is not changed by what is appended after it. The history mixes
// old lines and new, and runs of messages — which are read off the record
// after them — at the cuts.
func TestFold_AnyPrefix(t *testing.T) {
	records := mixedHistory
	for _, agentType := range []session.AgentType{session.AgentTypeClaude, session.AgentTypeCodex} {
		whole := Fold(records, agentType)
		wholeState, wholePage := whole.State(), pageJSON(t, whole)
		for cut := 0; cut <= len(records); cut++ {
			p := Fold(records[:cut], agentType)
			// Kept as a value: what a page holds must not change under it as
			// the fold goes on.
			before, beforePage := p.State(), newestPage(t, p)
			p.Append(records[cut:]...)
			if got := p.State(); !reflect.DeepEqual(got, wholeState) {
				t.Errorf("%s: folding %d records and appending the rest:\n  %+v\nfolding all:\n  %+v", agentType, cut, got, wholeState)
			}
			if got := pageJSON(t, p); got != wholePage {
				t.Errorf("%s: the transcript of %d records and the rest appended:\n  %s\nof all:\n  %s", agentType, cut, got, wholePage)
			}
			again := Fold(records[:cut], agentType)
			if !reflect.DeepEqual(before, again.State()) {
				t.Errorf("%s: the state of %d records changed when the rest was appended:\n  %+v\nwas:\n  %+v", agentType, cut, before, again.State())
			}
			if got, was := jsonOf(t, beforePage), pageJSON(t, again); got != was {
				t.Errorf("%s: the transcript of %d records changed when the rest was appended:\n  %s\nwas:\n  %s", agentType, cut, got, was)
			}
		}
	}

	// Record by record is one more way of appending.
	p := New(session.AgentTypeClaude)
	for _, raw := range records {
		p.Append(raw)
		_ = p.State()
	}
	if got := p.State(); !reflect.DeepEqual(got, Fold(records, session.AgentTypeClaude).State()) {
		t.Errorf("appending one record at a time:\n  %+v", got)
	}
	if got, want := pageJSON(t, p), pageJSON(t, Fold(records, session.AgentTypeClaude)); got != want {
		t.Errorf("appending one record at a time, the transcript:\n  %s\nwant:\n  %s", got, want)
	}
}

// TestQuestions_WhichRecordHolds: a posted question can be reopened, so its
// newest record holds — an answer after a withdrawal is the answer. The CLI's
// own question never was, so what settled it first holds.
func TestQuestions_WhichRecordHolds(t *testing.T) {
	posted := fold(
		prompt1, started1, asked,
		`T1|{"type":"request_cancelled","request_id":"q1"}`,
		answer1In,
	)
	assertStrings(t, "posted", questionsShape(posted), []string{"q1:answered"})

	legacy := fold(
		`-|{"type":"ask_user_question","request_id":"r1","questions":[{"question":"Q?","header":"Q","options":[{"label":"A"}]}]}`,
		`-|{"type":"question_response","request_id":"r1","answers":{"Q?":"A"}}`,
		`-|{"type":"request_cancelled","request_id":"r1"}`,
		`-|{"type":"ask_user_question","request_id":"r2","questions":[{"question":"Q?","header":"Q","options":[{"label":"A"}]}]}`,
		`-|{"type":"request_cancelled","request_id":"r2","reason":"process_ended"}`,
		`-|{"type":"question_response","request_id":"r2","answers":{"Q?":"A"}}`,
	)
	assertStrings(t, "legacy", questionsShape(legacy), []string{"r1:answered", "r2:withdrawn"})
}
