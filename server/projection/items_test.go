package projection

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// itemsShape is "id:status" per item, with "/permission" when a permission
// request belongs to the run and "<parent" when it ran inside another.
func itemsShape(s State) []string {
	var out []string
	for _, item := range s.Items {
		shape := item.ToolUseID + ":" + string(item.Status)
		if item.Permission != nil {
			shape += "/" + string(item.Permission.Status)
		}
		if item.ParentToolUseID != "" {
			shape += "<" + item.ParentToolUseID
		}
		out = append(out, shape)
	}
	return out
}

func mustItem(t *testing.T, s State, id string) Item {
	t.Helper()
	item, ok := s.Item(id)
	if !ok {
		t.Fatalf("no item %q in %q", id, itemsShape(s))
	}
	return item
}

func at(sec int) *time.Time {
	ts := time.Date(2026, 1, 2, 3, 4, sec, 0, time.UTC)
	return &ts
}

// TestItems_OneItemPerToolRun: a call, its permission request and answer, and
// its result are one item, whichever comes first — Claude announces the call
// before asking, Codex asks first — and a resend is the same run.
func TestItems_OneItemPerToolRun(t *testing.T) {
	s := fold(
		prompt1, started1,
		// Claude: call, request, allow, result.
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Bash","tool_input":{"command":"ls"},"observed_at":"2026-01-02T03:04:01Z"}`,
		`T1|{"type":"permission_request","request_id":"p1","tool_use_id":"c1","tool_name":"Bash","tool_input":{"command":"ls"},"permission_suggestions":[{"type":"addRules"}]}`,
		`T1|{"type":"permission_response","request_id":"p1","choice":"always_allow","observed_at":"2026-01-02T03:04:03Z"}`,
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Bash","tool_input":{"command":"ls -la"}}`,
		`T1|{"type":"tool_result","tool_use_id":"c1","tool_result":"ok","duration_ms":7,"observed_at":"2026-01-02T03:04:04Z"}`,
		// Codex: request, call, deny, then the engine's refusal.
		`T1|{"type":"permission_request","request_id":"p2","tool_use_id":"c2","tool_name":"Edit","tool_input":{"file_path":"a"}}`,
		`T1|{"type":"tool_call","tool_use_id":"c2","tool_name":"Edit","tool_input":{"file_path":"a"}}`,
		`T1|{"type":"permission_response","request_id":"p2","choice":"deny","by":"permission_reviewer","review":{"reason":"no"}}`,
		// Denied, the engine has not reported yet.
		`T1|{"type":"permission_request","request_id":"p3","tool_use_id":"c3","tool_name":"Bash"}`,
		`T1|{"type":"permission_response","request_id":"p3","choice":"deny"}`,
		`T1|{"type":"tool_result","tool_use_id":"c2","tool_result":"refused","is_error":true}`,
		// Still waiting.
		`T1|{"type":"tool_call","tool_use_id":"c4","tool_name":"Bash"}`,
		`T1|{"type":"permission_request","request_id":"p4","tool_use_id":"c4","tool_name":"Bash"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{
		"c1:succeeded/allowed", "c2:failed/denied", "c3:denied/denied", "c4:awaiting_permission/pending",
	})

	c1 := mustItem(t, s, "c1")
	if string(c1.ToolInput) != `{"command":"ls -la"}` || c1.TurnID != "T1" || c1.Seq != 3 {
		t.Errorf("c1 = %+v", c1)
	}
	// It ran from the answer: before that it waited on the user.
	if c1.StartedAt == nil || !c1.StartedAt.Equal(*at(3)) || c1.EndedAt == nil || !c1.EndedAt.Equal(*at(4)) {
		t.Errorf("c1 ran %v..%v, want 03..04", c1.StartedAt, c1.EndedAt)
	}
	if p := c1.Permission; !p.Always || p.Choice != agent.ChoiceNameAlwaysAllow || len(p.Suggestions) != 1 || p.By != "" {
		t.Errorf("c1 permission = %+v", p)
	}
	if r := c1.Result; r == nil || r.Text != "ok" || r.DurationMs != 7 {
		t.Errorf("c1 result = %+v", r)
	}
	c2 := mustItem(t, s, "c2")
	if c2.Permission.By != agent.RespondedByPermissionReviewer || c2.Permission.Review == nil || c2.StartedAt != nil {
		t.Errorf("c2 = %+v, permission %+v", c2, c2.Permission)
	}
}

// TestItems_PermissionAnswers: a person's answer moves only a pending request;
// one naming who gave it is the one the server took, and stands over a
// person's recorded beside it. An expired request ignores answers, and keeps
// the first reason a record gives.
func TestItems_PermissionAnswers(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"permission_request","request_id":"p1","tool_use_id":"c1","tool_name":"Bash"}`,
		`T1|{"type":"permission_response","request_id":"p1","choice":"allow","observed_at":"2026-01-02T03:04:01Z"}`,
		`T1|{"type":"permission_response","request_id":"p1","choice":"deny","by":"pockode","observed_at":"2026-01-02T03:04:02Z"}`,
		`T1|{"type":"permission_response","request_id":"p1","choice":"allow","by":"permission_reviewer"}`,
		`T1|{"type":"permission_request","request_id":"p2","tool_use_id":"c2","tool_name":"Bash"}`,
		`T1|{"type":"permission_response","request_id":"p2","choice":"deny"}`,
		`T1|{"type":"permission_response","request_id":"p2","choice":"allow"}`,
		`T1|{"type":"permission_request","request_id":"p3","tool_use_id":"c3","tool_name":"Bash"}`,
		`T1|{"type":"request_cancelled","request_id":"p3"}`,
		`T1|{"type":"request_cancelled","request_id":"p3","reason":"timeout"}`,
		`T1|{"type":"request_cancelled","request_id":"p3","reason":"work_closed"}`,
		`T1|{"type":"permission_response","request_id":"p3","choice":"allow"}`,
		`T1|{"type":"permission_request","request_id":"p4","tool_name":"Bash"}`,
		// Asked again under a new id: the older request's answer is not its.
		`T1|{"type":"permission_request","request_id":"p5","tool_use_id":"c5","tool_name":"Bash"}`,
		`T1|{"type":"permission_request","request_id":"p6","tool_use_id":"c5","tool_name":"Bash"}`,
		`T1|{"type":"permission_response","request_id":"p5","choice":"allow"}`,
		`T1|{"type":"permission_response","request_id":"p6","choice":"deny"}`,
		`null|{"type":"process_ended"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{
		"c1:denied/denied", "c2:denied/denied", "c3:expired/expired", ":expired/expired", "c5:denied/denied",
	})
	c1 := mustItem(t, s, "c1").Permission
	if c1.By != agent.RespondedByPockode || c1.AnsweredAt == nil || !c1.AnsweredAt.Equal(*at(1)) {
		t.Errorf("c1 permission = %+v", c1)
	}
	if got := mustItem(t, s, "c3").Permission.Reason; got != agent.ReasonTimeout {
		t.Errorf("c3 reason = %q, want timeout", got)
	}
	// A request naming no call is an item of its own.
	if got := s.Items[3].Permission; got.RequestID != "p4" || got.Reason != agent.ReasonProcessEnded {
		t.Errorf("p4 = %+v", got)
	}
}

// TestItems_BackgroundResults: a placeholder parks the run in the background
// past its turn — even one cut short — and its outcome settles it later; the
// process going away loses it.
func TestItems_BackgroundResults(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"b1","tool_name":"Bash"}`,
		`T1|{"type":"tool_result","tool_use_id":"b1","tool_result":"started","subtype":"background_started","exit_code":0}`,
		`T1|{"type":"tool_call","tool_use_id":"b2","tool_name":"Bash"}`,
		`T1|{"type":"tool_result","tool_use_id":"b2","tool_result":"started","subtype":"background_started"}`,
		`T1|{"type":"tool_call","tool_use_id":"b3","tool_name":"Bash"}`,
		`T1|{"type":"interrupted"}`,
		`T1|{"type":"tool_result","tool_use_id":"b1","tool_result":"finished","subtype":"background_result","observed_at":"2026-01-02T03:04:09Z"}`,
		prompt2, started2,
		`T2|{"type":"tool_result","tool_use_id":"b3","tool_result":"late","subtype":"background_result"}`,
		`null|{"type":"process_ended"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{"b1:succeeded", "b2:interrupted", "b3:interrupted"})

	b1 := mustItem(t, s, "b1")
	if !b1.Backgrounded || b1.Placeholder != "started" || b1.Result.Text != "finished" ||
		b1.Result.ExitCode == nil || b1.EndedAt == nil || b1.LostWithProcess {
		t.Errorf("b1 = %+v, result %+v", b1, b1.Result)
	}
	if b2 := mustItem(t, s, "b2"); !b2.LostWithProcess || !b2.Backgrounded {
		t.Errorf("b2 = %+v", b2)
	}
	// Cut short by the Stop, then finished all the same: the status is what
	// the turn did to it, and the outcome says the call finished.
	if b3 := mustItem(t, s, "b3"); !b3.FinishedAfterStop || !b3.Backgrounded || b3.LostWithProcess {
		t.Errorf("b3 = %+v", b3)
	}

	lost := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"b1","tool_name":"Bash"}`,
		`T1|{"type":"tool_result","tool_use_id":"b1","tool_result":"started","subtype":"background_started"}`,
		`T1|{"type":"done"}`,
		`null|{"type":"tool_result","tool_use_id":"b1","tool_result":"gone","subtype":"background_lost","is_error":true}`,
	)
	if b1 := mustItem(t, lost, "b1"); b1.Status != ItemFailed || !b1.LostWithProcess {
		t.Errorf("lost b1 = %+v", b1)
	}
}

// TestItems_SubagentNesting: a subagent's calls are its call's children, at any
// depth; settling a subagent settles what still runs under it, and a call
// trailing in after its subagent was cut short is born settled — unless a turn
// has begun since, which resumed it.
func TestItems_SubagentNesting(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"a","tool_name":"Task"}`,
		`T1|{"type":"tool_call","tool_use_id":"a1","tool_name":"Bash","parent_tool_use_id":"a"}`,
		`T1|{"type":"tool_call","tool_use_id":"a2","tool_name":"Task","parent_tool_use_id":"a"}`,
		`T1|{"type":"tool_call","tool_use_id":"a21","tool_name":"Bash","parent_tool_use_id":"a2"}`,
		// A subagent's request before its call, which names the parent.
		`T1|{"type":"permission_request","request_id":"p","tool_use_id":"a3","tool_name":"Bash"}`,
		`T1|{"type":"tool_call","tool_use_id":"a3","tool_name":"Bash","parent_tool_use_id":"a"}`,
		`T1|{"type":"tool_result","tool_use_id":"a1","tool_result":"ok"}`,
		`T1|{"type":"tool_result","tool_use_id":"a","tool_result":"failed","is_error":true}`,
		`T1|{"type":"tool_call","tool_use_id":"a4","tool_name":"Bash","parent_tool_use_id":"a"}`,
		`T1|{"type":"done"}`,
		prompt2, started2,
		`T2|{"type":"tool_call","tool_use_id":"a5","tool_name":"Bash","parent_tool_use_id":"a"}`,
		// Its parent is not in this history: a root all the same.
		`T2|{"type":"tool_call","tool_use_id":"o","tool_name":"Bash","parent_tool_use_id":"cut"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{
		"a:failed", "a1:succeeded<a", "a2:interrupted<a", "a21:interrupted<a2",
		"a3:awaiting_permission/pending<a", "a4:interrupted<a", "a5:running<a", "o:running<cut",
	})
	if got := mustItem(t, s, "a").Children; !reflect.DeepEqual(got, []string{"a1", "a2", "a3", "a4", "a5"}) {
		t.Errorf("a's children = %q", got)
	}
}

// TestItems_ACutTurnSettlesWhatItLeftRunning: a turn cut short leaves no call
// running, nor one trailing in after it; backgrounded work and what runs under
// it live on. A turn that completed settles nothing.
func TestItems_ACutTurnSettlesWhatItLeftRunning(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"r","tool_name":"Bash"}`,
		`T1|{"type":"tool_call","tool_use_id":"bg","tool_name":"Task"}`,
		`T1|{"type":"tool_result","tool_use_id":"bg","tool_result":"started","subtype":"background_started"}`,
		`T1|{"type":"tool_call","tool_use_id":"bg1","tool_name":"Bash","parent_tool_use_id":"bg"}`,
		`T1|{"type":"error","error":"boom"}`,
		`T1|{"type":"tool_call","tool_use_id":"late","tool_name":"Bash"}`,
		`T1|{"type":"tool_call","tool_use_id":"bg2","tool_name":"Bash","parent_tool_use_id":"bg"}`,
		`T1|{"type":"tool_result","tool_use_id":"r","tool_result":"ok"}`,
		prompt2, started2,
		`T2|{"type":"tool_call","tool_use_id":"n","tool_name":"Bash"}`,
		`T2|{"type":"done"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{
		"r:interrupted", "bg:background", "bg1:running<bg", "late:interrupted", "bg2:running<bg", "n:running",
	})
	if r := mustItem(t, s, "r"); !r.FinishedAfterStop || r.Result.Text != "ok" {
		t.Errorf("r = %+v", r)
	}
}

// TestItems_Resumed: a call announced again because its work started again is
// running again, from then; one this history never saw made is not started.
func TestItems_Resumed(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"a","tool_name":"Agent","observed_at":"2026-01-02T03:04:01Z"}`,
		`T1|{"type":"tool_result","tool_use_id":"a","tool_result":"done","duration_ms":5,"observed_at":"2026-01-02T03:04:02Z"}`,
		`T1|{"type":"done"}`,
		prompt2, started2,
		`T2|{"type":"tool_call","tool_use_id":"a","tool_name":"Agent","subtype":"resumed","observed_at":"2026-01-02T03:04:07Z"}`,
		`T2|{"type":"tool_call","tool_use_id":"x","tool_name":"Agent","subtype":"resumed"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{"a:running"})
	a := mustItem(t, s, "a")
	if a.StartedAt == nil || !a.StartedAt.Equal(*at(7)) || a.EndedAt != nil || a.Result.Text != "done" || a.Result.DurationMs != 0 {
		t.Errorf("a = %+v, result %+v", a, a.Result)
	}
}

func TestItems_PlanIsFiledOnItsCall(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"c","tool_name":"TodoWrite"}`,
		`T1|{"type":"plan","tool_use_id":"c","steps":[{"text":"a","status":"pending"}]}`,
		`T1|{"type":"plan","tool_use_id":"c","steps":[{"text":"a","status":"completed"}]}`,
	)
	if plan := mustItem(t, s, "c").Plan; plan == nil || plan.Steps[0].Status != "completed" {
		t.Errorf("plan = %+v", plan)
	}
}

// TestNormalizeToolInput_CodexPatch: the MCP channel's map of path to change is
// read into the app-server channel's array, in path order; the array, other
// inputs, and a map with an entry it cannot read are left as recorded.
func TestNormalizeToolInput_CodexPatch(t *testing.T) {
	cases := []struct {
		name, tool, in, want string
	}{
		{
			name: "map",
			in: `{"file_path":"/x","changes":{"/b":{"type":"update","unified_diff":"@@ -1 +1 @@\n-<a>\n+&b","move_path":"/c"},` +
				`"/a":{"type":"add","content":"hi"},"/d":{"type":"delete","content":"bye"}}}`,
			want: `{"file_path":"/x","changes":[{"path":"/a","kind":{"type":"add"},"diff":"hi"},` +
				`{"path":"/b","kind":{"type":"update","move_path":"/c"},"diff":"@@ -1 +1 @@\n-<a>\n+&b"},` +
				`{"path":"/d","kind":{"type":"delete"},"diff":"bye"}]}`,
		},
		{
			name: "only the changes are rewritten",
			in:   `{ "z": "\u003c", "changes" : {"/a":{"type":"add","content":""}} , "a":1}`,
			want: `{ "z": "\u003c", "changes" : [{"path":"/a","kind":{"type":"add"},"diff":""}] , "a":1}`,
		},
		{
			name: "another tool",
			tool: "mcp__x__apply",
			in:   `{"changes":{"/a":{"type":"add","content":""}}}`,
		},
		{
			name: "array",
			in:   `{"changes":[{"path":"/a","kind":{"type":"add"},"diff":"hi"}],"file_path":"/a"}`,
		},
		{name: "untyped entry", in: `{"changes":{"/a":{"content":"hi"}}}`},
		{name: "not an object entry", in: `{"changes":{"/a":"hi"}}`},
		{name: "other input", in: `{"command":"ls"}`},
		{name: "not an object", in: `"ls"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := tc.want
			if want == "" {
				want = tc.in
			}
			tool := tc.tool
			if tool == "" {
				tool = "Edit"
			}
			if got := string(normalizeToolInput(tool, json.RawMessage(tc.in))); got != want {
				t.Errorf("got  %s\nwant %s", got, want)
			}
		})
	}

	// Normalized where the record enters, request and call alike.
	s := Fold(history(
		prompt1, started1,
		`T1|{"type":"permission_request","request_id":"p","tool_use_id":"e","tool_name":"Edit","tool_input":{"changes":{"/a":{"type":"add","content":""}}}}`,
	), session.AgentTypeCodex).State()
	if got := string(mustItem(t, s, "e").ToolInput); got != `{"changes":[{"path":"/a","kind":{"type":"add"},"diff":""}]}` {
		t.Errorf("request input = %s", got)
	}
}

// TestItems_AskedAgain: a call asked about again — after its first request
// expired, or was denied before anything ran — waits on the new request and
// follows its answer.
func TestItems_AskedAgain(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Bash"}`,
		`T1|{"type":"permission_request","request_id":"r1","tool_use_id":"c1","tool_name":"Bash"}`,
		`T1|{"type":"request_cancelled","request_id":"r1","reason":"timeout"}`,
		`T1|{"type":"permission_request","request_id":"r2","tool_use_id":"c1","tool_name":"Bash"}`,
		`T1|{"type":"permission_request","request_id":"r3","tool_use_id":"c2","tool_name":"Bash"}`,
		`T1|{"type":"permission_response","request_id":"r3","choice":"deny"}`,
		`T1|{"type":"permission_request","request_id":"r4","tool_use_id":"c2","tool_name":"Bash"}`,
	)
	assertStrings(t, "asked again", itemsShape(s), []string{"c1:awaiting_permission/pending", "c2:awaiting_permission/pending"})

	s = fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Bash"}`,
		`T1|{"type":"permission_request","request_id":"r1","tool_use_id":"c1","tool_name":"Bash"}`,
		`T1|{"type":"request_cancelled","request_id":"r1"}`,
		`T1|{"type":"permission_request","request_id":"r2","tool_use_id":"c1","tool_name":"Bash"}`,
		`T1|{"type":"permission_response","request_id":"r2","choice":"allow"}`,
	)
	assertStrings(t, "answered", itemsShape(s), []string{"c1:running/allowed"})
}

// TestItems_ResumedWhileHeld: a call held on its request has nothing running
// to resume.
func TestItems_ResumedWhileHeld(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Agent"}`,
		`T1|{"type":"permission_request","request_id":"r1","tool_use_id":"c1","tool_name":"Agent"}`,
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Agent","subtype":"resumed"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{"c1:awaiting_permission/pending"})
}

// TestItems_ChildBeforeParent: a call naming a parent the history has not
// recorded yet is that parent's child once it is — settled with it — and a
// parent the call is itself an ancestor of is no parent.
func TestItems_ChildBeforeParent(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"c2","tool_name":"Bash","parent_tool_use_id":"c1"}`,
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Task"}`,
		// A cycle: b names a, which names b.
		`T1|{"type":"tool_call","tool_use_id":"a","tool_name":"Task","parent_tool_use_id":"b"}`,
		`T1|{"type":"tool_call","tool_use_id":"b","tool_name":"Task","parent_tool_use_id":"a"}`,
		`T1|{"type":"interrupted"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{"c2:interrupted<c1", "c1:interrupted", "a:interrupted<b", "b:interrupted"})
	if got := mustItem(t, s, "c1").Children; !reflect.DeepEqual(got, []string{"c2"}) {
		t.Errorf("c1's children = %q", got)
	}
}

// TestItems_TrailingAStopUnderAFinishedSubagent: a finished subagent can be
// resumed, so a call of its trailing a Stop is its resumed work, still to
// report — where one under a subagent still running when the turn was cut is
// settled with it.
func TestItems_TrailingAStopUnderAFinishedSubagent(t *testing.T) {
	s := fold(
		prompt1, started1,
		`T1|{"type":"tool_call","tool_use_id":"done","tool_name":"Task"}`,
		`T1|{"type":"tool_result","tool_use_id":"done","tool_result":"ok"}`,
		`T1|{"type":"tool_call","tool_use_id":"cut","tool_name":"Task"}`,
		`T1|{"type":"interrupted"}`,
		`T1|{"type":"tool_call","tool_use_id":"d1","tool_name":"Bash","parent_tool_use_id":"done"}`,
		`T1|{"type":"tool_call","tool_use_id":"c1","tool_name":"Bash","parent_tool_use_id":"cut"}`,
	)
	assertStrings(t, "items", itemsShape(s), []string{"done:succeeded", "cut:interrupted", "d1:running<done", "c1:interrupted<cut"})
}
