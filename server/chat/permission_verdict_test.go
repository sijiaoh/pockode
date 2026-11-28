package chat

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

// raisePermission blocks the fixture's turn on a permission request.
func (f *midTurnFixture) raisePermission(t *testing.T, sess *mockSession, requestID string) {
	t.Helper()
	sess.events <- agent.PermissionRequestEvent{RequestID: requestID, ToolName: "Bash"}
	f.waitForPhase(t, session.PhaseBlocked)
}

// permissionResponses is every permission_response record in the transcript.
func (f *midTurnFixture) permissionResponses(t *testing.T) []agent.PermissionResponseRecord {
	t.Helper()
	var out []agent.PermissionResponseRecord
	for _, rec := range f.records(t) {
		if response, ok := rec.(agent.PermissionResponseRecord); ok {
			out = append(out, response)
		}
	}
	return out
}

// A reviewer's verdict is recorded as the reviewer's, with what it said and
// which reviewer session said it, and broadcast — no client drew it already. A
// deny goes to the agent as a refusal it can act on, and the turn goes on.
func TestClient_SendPermissionVerdict(t *testing.T) {
	deny := agent.PermissionReview{
		SessionID: "reviewer-1",
		Category:  agent.DenySystemReachUnverifiable,
		Reason:    "$DIR may be empty; check it first.",
	}
	allow := agent.PermissionReview{SessionID: "reviewer-1"}

	tests := []struct {
		name       string
		allow      bool
		review     agent.PermissionReview
		wantChoice agent.PermissionChoiceName
		wantSent   sentAnswer
	}{
		{
			name:       "deny",
			review:     deny,
			wantChoice: "deny",
			wantSent:   sentAnswer{requestID: "req-1", choice: agent.PermissionDeny, denyMessage: deny.DenialMessage()},
		},
		{
			name:       "allow",
			allow:      true,
			review:     allow,
			wantChoice: "allow",
			// One request, never the always-allow that would persist a rule.
			wantSent: sentAnswer{requestID: "req-1", choice: agent.PermissionAllow},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newMidTurnFixture(t)
			sess := f.startTurn(t)
			f.raisePermission(t, sess, "req-1")

			if err := f.client.SendPermissionVerdict(context.Background(), f.pm.GetProcess("sess"),
				agent.PermissionRequestData{RequestID: "req-1"}, tt.allow, tt.review); err != nil {
				t.Fatalf("SendPermissionVerdict: %v", err)
			}

			if got := sess.sentAnswers(); len(got) != 1 || got[0] != tt.wantSent {
				t.Errorf("answers handed to the agent = %+v, want [%+v]", got, tt.wantSent)
			}
			if phase := f.phase(t); phase != session.PhaseRunning {
				t.Errorf("phase = %q, want the turn carrying on", phase)
			}

			responses := f.permissionResponses(t)
			if len(responses) != 1 {
				t.Fatalf("permission_response records = %d, want 1", len(responses))
			}
			rec := responses[0]
			if rec.RequestID != "req-1" || rec.Choice != tt.wantChoice || rec.By != agent.RespondedByPermissionReviewer {
				t.Errorf("record = {request %q, choice %q, by %q}, want {req-1, %s, permission_reviewer}",
					rec.RequestID, rec.Choice, rec.By, tt.wantChoice)
			}
			if rec.Review == nil || *rec.Review != tt.review {
				t.Errorf("review = %+v, want %+v", rec.Review, tt.review)
			}

			var broadcast bool
			for _, b := range f.broadcasts {
				if b, ok := b.(agent.PermissionResponseRecord); ok && b.By == agent.RespondedByPermissionReviewer {
					broadcast = true
				}
			}
			if !broadcast {
				t.Error("the reviewer's response was not broadcast")
			}
		})
	}
}

// A person's answer is unchanged by all this: a deny still stops the turn,
// and the record still says nothing about who gave it. It is broadcast: the
// client that pressed drew its own press, and any other client watching the
// session otherwise keeps the card live until it reloads.
func TestClient_PersonsPermissionResponseUnattributed(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)
	f.raisePermission(t, sess, "req-1")

	if err := f.client.SendPermissionResponse(context.Background(), "sess",
		agent.PermissionRequestData{RequestID: "req-1"}, agent.PermissionDeny); err != nil {
		t.Fatalf("SendPermissionResponse: %v", err)
	}

	want := sentAnswer{requestID: "req-1", choice: agent.PermissionDeny}
	if got := sess.sentAnswers(); len(got) != 1 || got[0] != want {
		t.Errorf("answers handed to the agent = %+v, want [%+v]", got, want)
	}
	responses := f.permissionResponses(t)
	if len(responses) != 1 || responses[0].By != "" || responses[0].Review != nil {
		t.Errorf("records = %+v, want one with no attribution", responses)
	}
	var broadcast bool
	for _, b := range f.broadcasts {
		if b, ok := b.(agent.PermissionResponseRecord); ok && b.RequestID == "req-1" {
			broadcast = true
		}
	}
	if !broadcast {
		t.Error("the person's response was not broadcast")
	}
}

// Whichever of a person and the reviewer answers first is the answer: the later
// one reaches neither the agent nor the transcript, and the caller is told so.
func TestClient_FirstPermissionAnswerWins(t *testing.T) {
	data := agent.PermissionRequestData{RequestID: "req-1"}
	review := agent.PermissionReview{SessionID: "reviewer-1", Category: agent.DenySystemDamage, Reason: "r"}
	person := func(f *midTurnFixture) error {
		return f.client.SendPermissionResponse(context.Background(), "sess", data, agent.PermissionAllow)
	}
	reviewer := func(f *midTurnFixture) error {
		return f.client.SendPermissionVerdict(context.Background(), f.pm.GetProcess("sess"), data, false, review)
	}

	tests := []struct {
		name          string
		first, second func(*midTurnFixture) error
		wantBy        agent.PermissionResponder
	}{
		{"person then reviewer", person, reviewer, ""},
		{"reviewer then person", reviewer, person, agent.RespondedByPermissionReviewer},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newMidTurnFixture(t)
			sess := f.startTurn(t)
			f.raisePermission(t, sess, "req-1")

			if err := tt.first(f); err != nil {
				t.Fatalf("first answer: %v", err)
			}
			if err := tt.second(f); !errors.Is(err, process.ErrRequestNotPending) {
				t.Errorf("second answer = %v, want %v", err, process.ErrRequestNotPending)
			}

			if got := sess.sentAnswers(); len(got) != 1 {
				t.Errorf("answers handed to the agent = %+v, want only the first", got)
			}
			responses := f.permissionResponses(t)
			if len(responses) != 1 || responses[0].By != tt.wantBy {
				t.Errorf("records = %+v, want only the first answer's", responses)
			}
		})
	}
}

// A deny the reviewer has no category for is not a verdict it may give, and
// nothing of it is acted on.
func TestClient_SendPermissionVerdictRefusesUncategorisedDeny(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)
	f.raisePermission(t, sess, "req-1")

	err := f.client.SendPermissionVerdict(context.Background(), f.pm.GetProcess("sess"),
		agent.PermissionRequestData{RequestID: "req-1"}, false,
		agent.PermissionReview{SessionID: "reviewer-1", Category: "looks_wrong"})
	if err == nil {
		t.Fatal("SendPermissionVerdict accepted a deny outside the categories")
	}
	if got := sess.sentAnswers(); len(got) != 0 {
		t.Errorf("answers handed to the agent = %+v, want none", got)
	}
	if phase := f.phase(t); phase != session.PhaseBlocked {
		t.Errorf("phase = %q, want the request still waiting", phase)
	}
}

// Pockode's own deny of a request whose review fell through is recorded as
// Pockode's, not the reviewer's, with why — and like a verdict's deny it tells
// the agent and leaves the turn running.
func TestClient_DenyPermissionAutomatically(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)
	f.raisePermission(t, sess, "req-1")

	review := agent.PermissionReview{SessionID: "reviewer-1", Automatic: agent.AutoDenyTimeout, Reason: "no verdict within 5 minutes."}
	if err := f.client.DenyPermissionAutomatically(context.Background(), f.pm.GetProcess("sess"),
		agent.PermissionRequestData{RequestID: "req-1"}, review); err != nil {
		t.Fatalf("DenyPermissionAutomatically: %v", err)
	}

	want := sentAnswer{requestID: "req-1", choice: agent.PermissionDeny, denyMessage: "Pockode denied this call: no verdict within 5 minutes."}
	if got := sess.sentAnswers(); len(got) != 1 || got[0] != want {
		t.Errorf("answers handed to the agent = %+v, want [%+v]", got, want)
	}
	if phase := f.phase(t); phase != session.PhaseRunning {
		t.Errorf("phase = %q, want the turn carrying on", phase)
	}
	responses := f.permissionResponses(t)
	if len(responses) != 1 || responses[0].By != agent.RespondedByPockode || responses[0].Review == nil || *responses[0].Review != review {
		t.Errorf("records = %+v, want one by pockode carrying the review", responses)
	}
}

// An answer is for the process that raised the request: once the session has
// another, a namesake request there is not the one being answered.
func TestClient_ReviewAnswerRefusedForAReplacedProcess(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)
	f.raisePermission(t, sess, "req-1")
	old := f.pm.GetProcess("sess")
	f.pm.Close("sess")

	err := f.client.SendPermissionVerdict(context.Background(), old,
		agent.PermissionRequestData{RequestID: "req-1"}, true, agent.PermissionReview{SessionID: "reviewer-1"})
	if !errors.Is(err, process.ErrRequestNotPending) {
		t.Errorf("err = %v, want %v", err, process.ErrRequestNotPending)
	}
	if got := sess.sentAnswers(); len(got) != 0 {
		t.Errorf("answers handed to the agent = %+v, want none", got)
	}
}

// A call that waited on a card could only start once it was answered, so the
// answer is where its measured duration begins (agent.ObserveAt):
// whoever answered, the record says when.
func TestClient_PermissionResponseRecordsWhenItWasAnswered(t *testing.T) {
	data := agent.PermissionRequestData{RequestID: "req-1"}
	review := agent.PermissionReview{SessionID: "reviewer-1"}
	answers := map[string]func(*midTurnFixture) error{
		"person": func(f *midTurnFixture) error {
			return f.client.SendPermissionResponse(context.Background(), "sess", data, agent.PermissionAllow)
		},
		"reviewer": func(f *midTurnFixture) error {
			return f.client.SendPermissionVerdict(context.Background(), f.pm.GetProcess("sess"), data, true, review)
		},
	}

	for name, answer := range answers {
		t.Run(name, func(t *testing.T) {
			f := newMidTurnFixture(t)
			sess := f.startTurn(t)
			f.raisePermission(t, sess, "req-1")

			before := time.Now()
			if err := answer(f); err != nil {
				t.Fatalf("answer: %v", err)
			}
			after := time.Now()

			responses := f.permissionResponses(t)
			if len(responses) != 1 {
				t.Fatalf("permission_response records = %d, want 1", len(responses))
			}
			at := responses[0].ObservedAt
			if at == nil || at.Before(before) || at.After(after) {
				t.Errorf("observed_at = %v, want between %v and %v", at, before, after)
			}
		})
	}
}
