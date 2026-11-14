package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliauth/cliauthtest"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// subscribeCLIProfiles subscribes and reads past the resend that follows the
// reply, so the next cli_profile.changed is one a change caused.
func (e *testEnv) subscribeCLIProfiles() cliprofile.Overview {
	e.t.Helper()
	resp := e.call("cli_profile.subscribe", rpc.SubscribeParams{ID: e.nextSubID()})
	if resp.Error != nil {
		e.t.Fatalf("cli_profile.subscribe: %s", resp.Error.Message)
	}
	var result rpc.CLIProfileSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("unmarshal subscribe: %v", err)
	}
	e.awaitCLIProfiles()
	return result.Profiles
}

func (e *testEnv) awaitCLIProfiles() cliprofile.Overview {
	e.t.Helper()
	notif := e.awaitNotification("cli_profile.changed")
	var params struct {
		Profiles cliprofile.Overview `json:"profiles"`
	}
	if err := json.Unmarshal(notif.Params, &params); err != nil {
		e.t.Fatalf("unmarshal cli_profile.changed: %v", err)
	}
	return params.Profiles
}

func (e *testEnv) mustCallCLIProfile(method string, params any) json.RawMessage {
	e.t.Helper()
	resp := e.call(method, params)
	if resp.Error != nil {
		e.t.Fatalf("%s %+v: %s", method, params, resp.Error.Message)
	}
	return resp.Result
}

// pushedCLIProfiles reports whether a cli_profile.changed has arrived that the
// test has not read. A round trip first, so that one sent before it is in.
func (e *testEnv) pushedCLIProfiles() bool {
	e.t.Helper()
	e.mustCallCLIProfile("cli_profile.inspect", nil)
	for _, frame := range e.buffered {
		var notif rpcNotification
		if json.Unmarshal(frame, &notif) == nil && notif.Method == "cli_profile.changed" {
			return true
		}
	}
	return false
}

// Every change a client makes here is pushed to the clients of this server,
// carrying the lists as they now are.
func TestCLIProfile_ChangesArePushed(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	initial := env.subscribeCLIProfiles()
	if !initial.Available || len(initial.CLIs) != 1 || initial.CLIs[0].Agent != session.AgentTypeClaude ||
		initial.CLIs[0].CurrentProfileID != "" || len(initial.CLIs[0].Profiles) != 0 {
		t.Fatalf("subscribe = %+v, want session.AgentTypeClaude alone, with only its default profile", initial)
	}

	var added rpc.CLIProfileAddResult
	if err := json.Unmarshal(env.mustCallCLIProfile("cli_profile.add", rpc.CLIProfileAddParams{Agent: session.AgentTypeClaude, Name: "  Work  "}), &added); err != nil {
		t.Fatal(err)
	}
	if added.Profile.Name != "Work" || added.Profile.ID == "" {
		t.Errorf("add = %+v, want Work with an ID the server made", added.Profile)
	}
	if got := env.awaitCLIProfiles().CLIs[0]; len(got.Profiles) != 1 || got.Profiles[0] != added.Profile || got.CurrentProfileID != "" {
		t.Errorf("pushed after add: %+v, want Work, not current", got)
	}

	env.mustCallCLIProfile("cli_profile.rename", rpc.CLIProfileRenameParams{Agent: session.AgentTypeClaude, ProfileID: added.Profile.ID, Name: "Personal"})
	if got := env.awaitCLIProfiles().CLIs[0]; len(got.Profiles) != 1 || got.Profiles[0].Name != "Personal" {
		t.Errorf("pushed after rename: %+v, want Personal", got)
	}

	env.mustCallCLIProfile("cli_profile.switch", rpc.CLIProfileSwitchParams{Agent: session.AgentTypeClaude, ProfileID: &added.Profile.ID})
	if got := env.awaitCLIProfiles().CLIs[0]; got.CurrentProfileID != added.Profile.ID {
		t.Errorf("pushed after switch: current %q, want %q", got.CurrentProfileID, added.Profile.ID)
	}
	if current, _ := env.cliProfiles.Current(session.AgentTypeClaude); current == nil || current.ID != added.Profile.ID {
		t.Errorf("stored current = %+v, want the profile switched to", current)
	}

	defaultID := ""
	env.mustCallCLIProfile("cli_profile.switch", rpc.CLIProfileSwitchParams{Agent: session.AgentTypeClaude, ProfileID: &defaultID})
	if got := env.awaitCLIProfiles().CLIs[0]; got.CurrentProfileID != "" {
		t.Errorf("pushed after switching to the default: current %q", got.CurrentProfileID)
	}
}

// A change made by another Pockode process of the OS user — another cluster
// node — is not pushed: this server cannot hear of it. The client sees it the
// next time anything is read, a push of this server's own included.
func TestCLIProfile_OtherProcessesChangesAreNotPushed(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.subscribeCLIProfiles()

	otherNode := cliprofile.NewStore(env.cliProfilesDir)
	elsewhere, err := otherNode.Add(session.AgentTypeClaude, "Elsewhere")
	if err != nil {
		t.Fatal(err)
	}
	if env.pushedCLIProfiles() {
		t.Fatal("another process's change was pushed")
	}

	env.mustCallCLIProfile("cli_profile.add", rpc.CLIProfileAddParams{Agent: session.AgentTypeClaude, Name: "Here"})
	got := env.awaitCLIProfiles().CLIs[0]
	if len(got.Profiles) != 2 || got.Profiles[0] != elsewhere || got.Profiles[1].Name != "Here" {
		t.Errorf("pushed = %+v, want both profiles, read afresh", got.Profiles)
	}
}

// Names are the user's, and are checked here with a reason they can act on;
// IDs must be ones the server issued. A refused change changes and pushes
// nothing.
func TestCLIProfile_RefusedChanges(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	work, err := env.cliProfiles.Add(session.AgentTypeClaude, "Work")
	if err != nil {
		t.Fatal(err)
	}
	env.subscribeCLIProfiles()
	missing := "0190d4a0-0000-7000-8000-000000000000"
	pathLike := "../../escape"

	tests := []struct {
		name   string
		method string
		params any
		reason string
	}{
		{"add without agent", "cli_profile.add", rpc.CLIProfileAddParams{Name: "Home"}, "agent is required"},
		{"add for an unknown CLI", "cli_profile.add", rpc.CLIProfileAddParams{Agent: "gemini", Name: "Home"}, "unknown agent"},
		// A CLI cliprofile knows, but this server does not list.
		{"add for an unlisted CLI", "cli_profile.add", rpc.CLIProfileAddParams{Agent: session.AgentTypeCodex, Name: "Home"}, "unknown agent"},
		{"add a blank name", "cli_profile.add", rpc.CLIProfileAddParams{Agent: session.AgentTypeClaude, Name: "   "}, "profile name must be"},
		{"add a name too long", "cli_profile.add", rpc.CLIProfileAddParams{Agent: session.AgentTypeClaude, Name: strings.Repeat("あ", cliprofile.MaxNameLength+1)}, "profile name must be"},
		{"add a control character", "cli_profile.add", rpc.CLIProfileAddParams{Agent: session.AgentTypeClaude, Name: "Wo\nrk"}, "profile name must be"},
		{"add a name taken, case aside", "cli_profile.add", rpc.CLIProfileAddParams{Agent: session.AgentTypeClaude, Name: "WORK"}, "already has that name"},
		{"rename the default profile", "cli_profile.rename", rpc.CLIProfileRenameParams{Agent: session.AgentTypeClaude, Name: "Home"}, "default profile has no name"},
		{"rename a missing profile", "cli_profile.rename", rpc.CLIProfileRenameParams{Agent: session.AgentTypeClaude, ProfileID: missing, Name: "Home"}, "profile not found"},
		{"rename to a blank name", "cli_profile.rename", rpc.CLIProfileRenameParams{Agent: session.AgentTypeClaude, ProfileID: work.ID, Name: ""}, "profile name must be"},
		{"switch without a profile", "cli_profile.switch", rpc.CLIProfileSwitchParams{Agent: session.AgentTypeClaude}, "profile_id is required"},
		{"switch to a missing profile", "cli_profile.switch", rpc.CLIProfileSwitchParams{Agent: session.AgentTypeClaude, ProfileID: &missing}, "profile not found"},
		{"switch to a path", "cli_profile.switch", rpc.CLIProfileSwitchParams{Agent: session.AgentTypeClaude, ProfileID: &pathLike}, "profile not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := env.call(tt.method, tt.params)
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, tt.reason) {
				t.Fatalf("got %+v, want invalid params saying %q", resp.Error, tt.reason)
			}
		})
	}

	list, err := env.cliProfiles.Load(session.AgentTypeClaude)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Profiles) != 1 || list.Profiles[0] != work || list.Current != "" {
		t.Errorf("after refused changes: %+v, want Work alone and unchanged", list)
	}
	if env.pushedCLIProfiles() {
		t.Error("a refused change was pushed")
	}
}

// Inspecting reads each profile as it is now: its sign-in, and the entries
// it should share but has its own copy of. A pushed list carries neither.
func TestCLIProfile_Inspect(t *testing.T) {
	defaultDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", defaultDir)
	env := newTestEnv(t, &mockAgent{})
	env.cliAuth.Set(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}})
	work, err := env.cliProfiles.Add(session.AgentTypeClaude, "Work")
	if err != nil {
		t.Fatal(err)
	}
	// settings.json in the default directory is shared; the profile has a
	// real one, as when the CLI wrote it before the default directory had it.
	if err := os.WriteFile(filepath.Join(defaultDir, "settings.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	workDir, err := env.cliProfiles.Dir(session.AgentTypeClaude, work.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		t.Fatal(err)
	}
	ownCopy := filepath.Join(workDir, "settings.json")
	if err := os.WriteFile(ownCopy, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	var result rpc.CLIProfileInspectResult
	if err := json.Unmarshal(env.mustCallCLIProfile("cli_profile.inspect", rpc.CLIProfileInspectParams{Agent: session.AgentTypeClaude}), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Profiles) != 2 {
		t.Fatalf("inspected %d profiles, want the default one and Work", len(result.Profiles))
	}
	def, w := result.Profiles[0], result.Profiles[1]
	if def.Status.ProfileID != "" || def.Status.State != cliauth.StateSignedIn || len(def.Conflicts) != 0 {
		t.Errorf("default = %+v, want signed in, without conflicts", def)
	}
	if w.Status.ProfileID != work.ID || w.Status.State != cliauth.StateSignedIn {
		t.Errorf("Work status = %+v, want signed in", w.Status)
	}
	if len(w.Conflicts) != 1 || w.Conflicts[0] != (cliprofile.Conflict{Name: "settings.json", Path: ownCopy}) || w.ConflictsError != "" {
		t.Errorf("Work conflicts = %+v (%q), want its own settings.json", w.Conflicts, w.ConflictsError)
	}

	if resp := env.call("cli_profile.inspect", rpc.CLIProfileInspectParams{Agent: "gemini"}); resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Errorf("unknown CLI: got %+v, want invalid params", resp.Error)
	}

	// One profile: the same inspection, alone.
	var one rpc.CLIProfileInspectResult
	if err := json.Unmarshal(env.mustCallCLIProfile("cli_profile.inspect", rpc.CLIProfileInspectParams{Agent: session.AgentTypeClaude, ProfileID: &work.ID}), &one); err != nil {
		t.Fatal(err)
	}
	if len(one.Profiles) != 1 || one.Profiles[0].Status.ProfileID != work.ID || len(one.Profiles[0].Conflicts) != 1 {
		t.Errorf("inspect Work alone = %+v, want Work with its conflict", one.Profiles)
	}
	defaultID := ""
	var alone rpc.CLIProfileInspectResult
	if err := json.Unmarshal(env.mustCallCLIProfile("cli_profile.inspect", rpc.CLIProfileInspectParams{Agent: session.AgentTypeClaude, ProfileID: &defaultID}), &alone); err != nil {
		t.Fatal(err)
	}
	if len(alone.Profiles) != 1 || alone.Profiles[0].Status.ProfileID != "" {
		t.Errorf("inspect the default alone = %+v, want the default profile", alone.Profiles)
	}
	unknown := "01900000-0000-7000-8000-000000000000"
	for name, params := range map[string]rpc.CLIProfileInspectParams{
		"unknown profile":   {Agent: session.AgentTypeClaude, ProfileID: &unknown},
		"profile, no agent": {ProfileID: &work.ID},
	} {
		if resp := env.call("cli_profile.inspect", params); resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
			t.Errorf("%s: got %+v, want invalid params", name, resp.Error)
		}
	}
}

// fakeReleaser stands in for worktree.Manager.ReleaseProfile.
type fakeReleaser struct {
	busy []worktree.ProfileUser
	err  error
}

func (r fakeReleaser) ReleaseProfile(context.Context, session.AgentType, string) ([]worktree.ProfileUser, error) {
	return r.busy, r.err
}

// removeRefusal calls cli_profile.remove and returns the data of the refusal
// it must answer with.
func (e *testEnv) removeRefusal(profileID string) (string, rpc.CLIProfileRemoveRefusedData) {
	e.t.Helper()
	resp := e.call("cli_profile.remove", rpc.CLIProfileRemoveParams{Agent: session.AgentTypeClaude, ProfileID: profileID})
	if resp.Error == nil || resp.Error.Code != rpc.CodeCLIProfileRemoveRefused || resp.Error.Data == nil {
		e.t.Fatalf("got %+v, want CodeCLIProfileRemoveRefused with data", resp.Error)
	}
	var data rpc.CLIProfileRemoveRefusedData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		e.t.Fatal(err)
	}
	return resp.Error.Message, data
}

// A removal goes through the real worktree manager — with no session on the
// profile, nothing is in use — signs the profile out, and is pushed.
func TestCLIProfile_Remove(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	work, err := env.cliProfiles.Add(session.AgentTypeClaude, "Work")
	if err != nil {
		t.Fatal(err)
	}
	env.subscribeCLIProfiles()

	env.mustCallCLIProfile("cli_profile.remove", rpc.CLIProfileRemoveParams{Agent: session.AgentTypeClaude, ProfileID: work.ID})
	if got := env.awaitCLIProfiles().CLIs[0]; len(got.Profiles) != 0 {
		t.Errorf("pushed after remove: %+v, want no stored profile", got.Profiles)
	}
	if env.cliProfiles.Availability().Available && !slices.Contains(env.cliAuth.Profiles(), work.ID) {
		t.Errorf("provider ran as %q; want the profile signed out", env.cliAuth.Profiles())
	}
}

// A removal refused for a state the user can change says which, with the
// sessions in the way when there are any, and changes and pushes nothing.
func TestCLIProfile_RemoveRefused(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.cliAuth.Set(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}})
	work, err := env.cliProfiles.Add(session.AgentTypeClaude, "Work")
	if err != nil {
		t.Fatal(err)
	}
	env.subscribeCLIProfiles()
	kept := func() {
		t.Helper()
		if err := env.cliProfiles.Check(session.AgentTypeClaude, cliprofile.Select(work.ID)); err != nil {
			t.Errorf("profile no longer listed: %v", err)
		}
		// The provider's sign-out leaves it signed out.
		if st, _ := env.cliAuth.Status(context.Background(), work.ID); st.State != cliauth.StateSignedIn {
			t.Errorf("provider reads %q; a refused removal must not sign the profile out", st.State)
		}
		if env.pushedCLIProfiles() {
			t.Error("a refused removal was pushed")
		}
	}

	t.Run("in use", func(t *testing.T) {
		busy := []worktree.ProfileUser{{SessionID: "s1"}, {Worktree: "feature-x", SessionID: "s2"}}
		env.handler.profileReleaser = fakeReleaser{busy: busy}
		defer func() { env.handler.profileReleaser = env.worktreeManager }()

		message, data := env.removeRefusal(work.ID)
		want := []rpc.CLIProfileUser{{SessionID: "s1"}, {Worktree: "feature-x", SessionID: "s2"}}
		if data.Reason != rpc.CLIProfileRemoveRefusedInUse || !slices.Equal(data.Sessions, want) {
			t.Errorf("data = %+v, want in_use naming %+v", data, want)
		}
		if !strings.Contains(message, "2 session(s)") {
			t.Errorf("message %q does not say how many sessions", message)
		}
		kept()
	})

	t.Run("still exiting", func(t *testing.T) {
		env.handler.profileReleaser = fakeReleaser{err: fmt.Errorf("release profile in worktree %q: %w", "", context.DeadlineExceeded)}
		defer func() { env.handler.profileReleaser = env.worktreeManager }()

		if _, data := env.removeRefusal(work.ID); data.Reason != rpc.CLIProfileRemoveRefusedStillExiting {
			t.Errorf("reason = %q, want %q", data.Reason, rpc.CLIProfileRemoveRefusedStillExiting)
		}
		kept()
	})

	t.Run("current", func(t *testing.T) {
		env.mustCallCLIProfile("cli_profile.switch", rpc.CLIProfileSwitchParams{Agent: session.AgentTypeClaude, ProfileID: &work.ID})
		env.awaitCLIProfiles()
		if _, data := env.removeRefusal(work.ID); data.Reason != rpc.CLIProfileRemoveRefusedCurrent {
			t.Errorf("reason %q, want current", data.Reason)
		}
		defaultID := ""
		env.mustCallCLIProfile("cli_profile.switch", rpc.CLIProfileSwitchParams{Agent: session.AgentTypeClaude, ProfileID: &defaultID})
		env.awaitCLIProfiles()
		kept()
	})

	t.Run("signing in", func(t *testing.T) {
		var started rpc.CLIAuthLoginResult
		profileID := work.ID
		if err := json.Unmarshal(env.mustCallCLIProfile("cli_auth.login.start", rpc.CLIAuthLoginStartParams{
			Agent: session.AgentTypeClaude, CLIProfileParam: rpc.CLIProfileParam{ProfileID: &profileID},
		}), &started); err != nil {
			t.Fatal(err)
		}
		message, data := env.removeRefusal(work.ID)
		if data.Reason != rpc.CLIProfileRemoveRefusedSigningIn || !strings.Contains(message, "this claude profile") {
			t.Errorf("refusal %q (%+v), want signing_in for this profile", message, data)
		}
		env.mustCallCLIProfile("cli_auth.login.cancel", rpc.CLIAuthLoginCancelParams{LoginID: started.Login.ID})
		kept()
	})

	for _, tt := range []struct {
		name   string
		params rpc.CLIProfileRemoveParams
		reason string
	}{
		{"default profile", rpc.CLIProfileRemoveParams{Agent: session.AgentTypeClaude}, "default profile cannot be removed"},
		{"missing profile", rpc.CLIProfileRemoveParams{Agent: session.AgentTypeClaude, ProfileID: "0190d4a0-0000-7000-8000-000000000000"}, "profile not found"},
		{"path", rpc.CLIProfileRemoveParams{Agent: session.AgentTypeClaude, ProfileID: "../../escape"}, "profile not found"},
		{"unknown CLI", rpc.CLIProfileRemoveParams{Agent: "gemini", ProfileID: work.ID}, "unknown agent"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resp := env.call("cli_profile.remove", tt.params)
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, tt.reason) {
				t.Fatalf("got %+v, want invalid params saying %q", resp.Error, tt.reason)
			}
		})
	}
	if env.pushedCLIProfiles() {
		t.Error("a refused removal was pushed")
	}
}
