package ws

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/attachments"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
)

// sessionViewTestEnv is a server over a git repository, so worktrees can really be
// created and really be removed.
func sessionViewTestEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := setupGitRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test"), 0644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "initial")
	return newWorkDirTestEnv(t, dir)
}

// createWorktree adds a worktree over the wire, as the UI does.
func createWorktree(t *testing.T, env *testEnv, name string) {
	t.Helper()
	if resp := env.call("worktree.create", rpc.WorktreeCreateParams{Name: name, Branch: name + "-branch"}); resp.Error != nil {
		t.Fatalf("worktree.create %q: %s", name, resp.Error.Message)
	}
}

// seedSession leaves a session behind in the named worktree — a title, a
// transcript and an attachment the transcript refers to — and returns the
// attachment's id. Written through the worktree's own store rather than over
// the wire because the conversation being reconstructed afterwards is the point,
// not how it got there.
func seedSession(t *testing.T, env *testEnv, worktreeName, sessionID, title string) string {
	t.Helper()
	wt, err := env.worktreeManager.Get(worktreeName)
	if err != nil {
		t.Fatalf("get worktree %q: %v", worktreeName, err)
	}
	defer env.worktreeManager.Release(wt)

	if _, err := wt.SessionStore.Create(bgCtx, sessionID, session.CreateSpec{}); err != nil {
		t.Fatalf("create session %q: %v", sessionID, err)
	}
	if err := wt.SessionStore.Update(bgCtx, sessionID, title); err != nil {
		t.Fatalf("title session %q: %v", sessionID, err)
	}
	for _, text := range []string{"what happened here", "this"} {
		if _, err := wt.SessionStore.AppendToHistory(bgCtx, sessionID,
			map[string]any{"type": "text", "content": text}); err != nil {
			t.Fatalf("append to history: %v", err)
		}
	}
	id, err := attachments.NewStore(wt.DataDir, sessionID).Put(pngPixel, "")
	if err != nil {
		t.Fatalf("store attachment: %v", err)
	}
	return id
}

func sessionViewWorktrees(t *testing.T, env *testEnv) []rpc.SessionViewWorktree {
	t.Helper()
	resp := env.call("session_view.worktrees", nil)
	if resp.Error != nil {
		t.Fatalf("session_view.worktrees: %s", resp.Error.Message)
	}
	var result rpc.SessionViewWorktreesResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal session_view.worktrees: %v", err)
	}
	return result.Worktrees
}

func findSessionViewWorktree(worktrees []rpc.SessionViewWorktree, name string) (rpc.SessionViewWorktree, bool) {
	for _, wt := range worktrees {
		if wt.Worktree == name {
			return wt, true
		}
	}
	return rpc.SessionViewWorktree{}, false
}

// The work a conversation produced outlives the worktree it ran in: the
// worktree is cleaned up when the work is done, and before this the
// conversation went with it.
func TestSessionView_SessionDataSurvivesItsWorktree(t *testing.T) {
	env := sessionViewTestEnv(t)
	createWorktree(t, env, "feature")
	attachmentID := seedSession(t, env, "feature", "sess-kept", "What the agent did")

	if resp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"}); resp.Error != nil {
		t.Fatalf("worktree.delete: %s", resp.Error.Message)
	}

	source, found := findSessionViewWorktree(sessionViewWorktrees(t, env), "feature")
	if !found {
		t.Fatal("a deleted worktree with sessions is not offered as a place to read from")
	}
	if source.Exists {
		t.Error("the worktree was deleted but is reported as existing")
	}
	if source.SessionCount != 1 {
		t.Errorf("session_count = %d, want 1", source.SessionCount)
	}

	listResp := env.call("session_view.list", rpc.SessionViewListParams{Worktree: "feature"})
	if listResp.Error != nil {
		t.Fatalf("session_view.list: %s", listResp.Error.Message)
	}
	var list rpc.SessionViewListResult
	if err := json.Unmarshal(listResp.Result, &list); err != nil {
		t.Fatalf("unmarshal session_view.list: %v", err)
	}
	if len(list.Sessions) != 1 || list.Sessions[0].ID != "sess-kept" {
		t.Fatalf("sessions = %+v, want the one the deleted worktree held", list.Sessions)
	}
	if list.Sessions[0].Title != "What the agent did" {
		t.Errorf("title = %q, want the stored one", list.Sessions[0].Title)
	}

	getResp := env.call("session_view.get", rpc.SessionViewGetParams{Worktree: "feature", SessionID: "sess-kept"})
	if getResp.Error != nil {
		t.Fatalf("session_view.get: %s", getResp.Error.Message)
	}

	historyResp := env.call("session_view.history", rpc.SessionViewHistoryParams{Worktree: "feature", SessionID: "sess-kept"})
	if historyResp.Error != nil {
		t.Fatalf("session_view.history: %s", historyResp.Error.Message)
	}
	var history rpc.SessionViewHistoryResult
	if err := json.Unmarshal(historyResp.Result, &history); err != nil {
		t.Fatalf("unmarshal session_view.history: %v", err)
	}
	if len(history.History) != 2 {
		t.Errorf("history = %d records, want the 2 that were written", len(history.History))
	}

	attachResp := env.call("session_view.attachment", rpc.SessionViewAttachmentParams{
		Worktree: "feature", SessionID: "sess-kept", ID: attachmentID,
	})
	if attachResp.Error != nil {
		t.Fatalf("session_view.attachment: %s", attachResp.Error.Message)
	}
	var attachment rpc.SessionViewAttachmentResult
	if err := json.Unmarshal(attachResp.Result, &attachment); err != nil {
		t.Fatalf("unmarshal session_view.attachment: %v", err)
	}
	if attachment.File == nil || attachment.File.MIME != "image/png" {
		t.Fatalf("attachment = %+v, want the image the session kept", attachment.File)
	}
	decoded, err := base64.StdEncoding.DecodeString(attachment.File.Content)
	if err != nil {
		t.Fatalf("decode attachment: %v", err)
	}
	if string(decoded) != string(pngPixel) {
		t.Error("the attachment came back as different bytes than were stored")
	}
}

// Session data is keyed by worktree name and nothing moves it, so a worktree
// recreated under a deleted one's name finds the old sessions waiting. That is
// the intended behaviour and not an accident: the two eras are the same branch
// under the same name, and the alternative is renaming somebody's data behind
// their back.
func TestSessionView_RecreatedWorktreeInheritsItsSessions(t *testing.T) {
	env := sessionViewTestEnv(t)
	createWorktree(t, env, "feature")
	seedSession(t, env, "feature", "sess-before", "From the first feature branch")

	if resp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"}); resp.Error != nil {
		t.Fatalf("worktree.delete: %s", resp.Error.Message)
	}
	createWorktree(t, env, "feature")

	source, found := findSessionViewWorktree(sessionViewWorktrees(t, env), "feature")
	if !found {
		t.Fatal("the recreated worktree's sessions are not readable")
	}
	if !source.Exists {
		t.Error("the worktree was recreated but is still reported as deleted")
	}

	// Readable through the worktree itself, not only through session_view: it
	// exists again, so it is an ordinary worktree holding an ordinary session.
	wt, err := env.worktreeManager.Get("feature")
	if err != nil {
		t.Fatalf("get the recreated worktree: %v", err)
	}
	defer env.worktreeManager.Release(wt)
	if _, found, err := wt.SessionStore.Get("sess-before"); err != nil || !found {
		t.Errorf("the recreated worktree does not hold the old session (found=%v, err=%v)", found, err)
	}
}

// Reading another worktree's sessions never becomes talking to them. Enforced
// on the server: a client that simply keeps sending must be refused, whichever
// of the two ways it tries.
func TestSessionView_DeletedWorktreeSessionsCannotBeTalkedTo(t *testing.T) {
	env := sessionViewTestEnv(t)
	createWorktree(t, env, "feature")
	seedSession(t, env, "feature", "sess-kept", "Finished conversation")

	// From the worktree the connection is still bound to when it is deleted
	// under it.
	if resp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: "feature"}); resp.Error != nil {
		t.Fatalf("worktree.switch: %s", resp.Error.Message)
	}
	if resp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"}); resp.Error != nil {
		t.Fatalf("worktree.delete: %s", resp.Error.Message)
	}
	resp := env.call("chat.message", rpc.MessageParams{SessionID: "sess-kept", Content: "are you still there"})
	if resp.Error == nil {
		t.Fatal("a message was accepted for a worktree that no longer exists")
	}
	if !strings.Contains(resp.Error.Message, "deleted") {
		t.Errorf("error = %q, want one that says the worktree is gone", resp.Error.Message)
	}

	// And from another worktree, naming the kept session directly: session
	// ids are project-wide, so this is the way in that the read paths open up.
	if resp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: ""}); resp.Error != nil {
		t.Fatalf("worktree.switch back to main: %s", resp.Error.Message)
	}
	resp = env.call("chat.message", rpc.MessageParams{SessionID: "sess-kept", Content: "are you still there"})
	if resp.Error == nil {
		t.Fatal("another worktree's session accepted a message")
	}
	if !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("error = %q, want session not found", resp.Error.Message)
	}
}

// The worktree name picks a directory, and it arrives straight off the wire
// rather than from the registry — so it is checked before it becomes a path
// (filepath.IsLocal, as worktree.Manager.SessionDataDir does).
func TestSessionView_RefusesAWorktreeNameThatIsAPath(t *testing.T) {
	env := sessionViewTestEnv(t)

	for _, name := range []string{"../escape", "/etc", "../../../etc"} {
		resp := env.call("session_view.list", rpc.SessionViewListParams{Worktree: name})
		if resp.Error == nil {
			t.Errorf("worktree %q was accepted as a directory name", name)
		}
	}
}

// The sidebar's "hide task sessions" filter holds over another worktree's
// sessions too, and the server is what applies it for the reason
// SessionListSubscribeParams gives: a client cannot, without the whole work list.
func TestSessionView_SessionListExcludesWorkSessions(t *testing.T) {
	env := sessionViewTestEnv(t)
	createWorktree(t, env, "feature")
	seedSession(t, env, "feature", "sess-plain", "A plain chat")
	seedSession(t, env, "feature", "sess-of-work", "A work's session")

	w := createWorktreeWork(t, env, "feature", "The work")
	if _, err := env.workStore.Start(bgCtx, w.ID, "sess-of-work"); err != nil {
		t.Fatalf("start work: %v", err)
	}

	resp := env.call("session_view.list", rpc.SessionViewListParams{
		Worktree: "feature", ExcludeWorkSessions: true,
	})
	if resp.Error != nil {
		t.Fatalf("session_view.list: %s", resp.Error.Message)
	}
	var list rpc.SessionViewListResult
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatalf("unmarshal session_view.list: %v", err)
	}
	if len(list.Sessions) != 1 || list.Sessions[0].ID != "sess-plain" {
		t.Fatalf("sessions = %+v, want only the plain chat", list.Sessions)
	}

	// Unfiltered, the work's session is there and says which work it runs.
	resp = env.call("session_view.list", rpc.SessionViewListParams{Worktree: "feature"})
	if resp.Error != nil {
		t.Fatalf("session_view.list: %s", resp.Error.Message)
	}
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatalf("unmarshal session_view.list: %v", err)
	}
	if len(list.Sessions) != 2 {
		t.Fatalf("sessions = %+v, want both", list.Sessions)
	}
	for _, row := range list.Sessions {
		if row.ID == "sess-of-work" && row.WorkID != w.ID {
			t.Errorf("work_id = %q, want %q", row.WorkID, w.ID)
		}
	}
}

// sessionViewSessionIDs is what the read view still offers for one worktree.
func sessionViewSessionIDs(t *testing.T, env *testEnv, worktree string) []string {
	t.Helper()
	resp := env.call("session_view.list", rpc.SessionViewListParams{Worktree: worktree})
	if resp.Error != nil {
		t.Fatalf("session_view.list: %s", resp.Error.Message)
	}
	var list rpc.SessionViewListResult
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatalf("unmarshal session_view.list: %v", err)
	}
	ids := make([]string, len(list.Sessions))
	for i, row := range list.Sessions {
		ids[i] = row.ID
	}
	return ids
}

// A session whose worktree is gone can never be continued, but it still has to
// be possible to throw away — otherwise what a worktree's deletion deliberately
// keeps is kept for good. session.delete cannot reach it: that one acts on the
// bound worktree, and nothing can bind to a worktree that no longer exists.
func TestSessionView_DeleteRemovesASessionOfADeletedWorktree(t *testing.T) {
	env := sessionViewTestEnv(t)
	createWorktree(t, env, "feature")
	seedSession(t, env, "feature", "sess-1", "The first")
	seedSession(t, env, "feature", "sess-2", "The second")
	if resp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"}); resp.Error != nil {
		t.Fatalf("worktree.delete: %s", resp.Error.Message)
	}

	resp := env.call("session_view.delete", rpc.SessionViewDeleteParams{Worktree: "feature", SessionID: "sess-1"})
	if resp.Error != nil {
		t.Fatalf("session_view.delete: %s", resp.Error.Message)
	}

	if got := sessionViewSessionIDs(t, env, "feature"); len(got) != 1 || got[0] != "sess-2" {
		t.Fatalf("sessions after the delete = %v, want only sess-2", got)
	}
	if resp := env.call("session_view.get", rpc.SessionViewGetParams{
		Worktree: "feature", SessionID: "sess-1",
	}); resp.Error == nil {
		t.Error("the deleted session is still readable")
	}
	if source, found := findSessionViewWorktree(sessionViewWorktrees(t, env), "feature"); !found {
		t.Error("the worktree stopped being offered while it still has a session")
	} else if source.SessionCount != 1 {
		t.Errorf("session_count = %d, want 1", source.SessionCount)
	}

	// The last one takes the worktree out of the list, and its stored data with
	// it: there is nothing left there to come back to.
	if resp := env.call("session_view.delete", rpc.SessionViewDeleteParams{
		Worktree: "feature", SessionID: "sess-2",
	}); resp.Error != nil {
		t.Fatalf("session_view.delete: %s", resp.Error.Message)
	}
	if _, found := findSessionViewWorktree(sessionViewWorktrees(t, env), "feature"); found {
		t.Error("a deleted worktree with no sessions left is still offered as a place to read from")
	}
	if _, err := os.Stat(filepath.Join(env.dataDir, "worktrees", "feature")); !os.IsNotExist(err) {
		t.Errorf("the emptied data directory is still there: %v", err)
	}
}

// The session id is checked against the worktree it names before anything is
// removed, for the reason every other method here checks it: it picks a
// directory, and a client that got it wrong is told so rather than told nothing.
func TestSessionView_DeleteRefusesASessionThatIsNotThere(t *testing.T) {
	env := sessionViewTestEnv(t)
	createWorktree(t, env, "feature")
	seedSession(t, env, "feature", "sess-1", "The only one")

	for _, params := range []rpc.SessionViewDeleteParams{
		{Worktree: "feature", SessionID: "sess-missing"},
		{Worktree: "feature", SessionID: ""},
		{Worktree: "../escape", SessionID: "sess-1"},
		{Worktree: "", SessionID: "sess-1"}, // stored under feature, not the main worktree
	} {
		if resp := env.call("session_view.delete", params); resp.Error == nil {
			t.Errorf("session_view.delete %+v was accepted", params)
		}
	}

	if got := sessionViewSessionIDs(t, env, "feature"); len(got) != 1 {
		t.Errorf("sessions = %v, want the one that was there", got)
	}
}
