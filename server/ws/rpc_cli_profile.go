package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// handleCLIProfileSubscribe follows the profile lists. Unlike the sign-in
// states, the lists are Pockode's own, so what this server changes in them it
// can push; see watch.CLIProfileWatcher for what it cannot.
func (h *rpcMethodHandler) handleCLIProfileSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	id, ok := h.subscriptionID(ctx, conn, req)
	if !ok {
		return
	}

	profiles, err := h.cliProfileWatcher.Subscribe(id, h.state.getNotifier())
	if err != nil {
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to AI CLI profiles")
		return
	}
	h.state.subscriptions.Track(id, h.cliProfileWatcher)

	if err := conn.Reply(ctx, req.ID, rpc.CLIProfileSubscribeResult{Profiles: profiles}); err != nil {
		h.log.Error("failed to send cli profile subscribe response", "error", err)
	}
	h.cliProfileWatcher.Resend()
}

// handleCLIProfileInspect reads every profile as its directory has it now: the
// sign-in state, read as cli_auth.status reads it (concurrently, never cached),
// and the entries it fails to share. Neither is pushed, for the reason
// cli_auth.status gives.
func (h *rpcMethodHandler) handleCLIProfileInspect(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIProfileInspectParams
	if req.Params != nil {
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
			return
		}
	}

	statuses, err := h.cliAuth.EveryProfileStatuses(ctx, params.Agent)
	if err != nil {
		h.replyCLIAuthError(ctx, conn, req.ID, err)
		return
	}
	result := rpc.CLIProfileInspectResult{Profiles: make([]rpc.CLIProfileInspection, len(statuses))}
	for i, status := range statuses {
		result.Profiles[i] = h.inspectCLIProfile(status)
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send cli profile inspect response", "error", err)
	}
}

func (h *rpcMethodHandler) inspectCLIProfile(status cliauth.Status) rpc.CLIProfileInspection {
	inspection := rpc.CLIProfileInspection{Status: status}
	// The default profile is the directory the others link into: it has
	// nothing to conflict with.
	if status.ProfileID == "" {
		return inspection
	}
	conflicts, err := h.cliProfiles.Conflicts(status.Agent, status.ProfileID)
	if err != nil {
		h.log.Warn("failed to read AI CLI profile conflicts", "agent", status.Agent, "profile", status.ProfileID, "error", err)
		inspection.ConflictsError = err.Error()
		return inspection
	}
	inspection.Conflicts = conflicts
	return inspection
}

func (h *rpcMethodHandler) handleCLIProfileAdd(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIProfileAddParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if !h.requireCLIProfileAgent(ctx, conn, req.ID, params.Agent) {
		return
	}

	profile, err := h.cliProfiles.Add(params.Agent, params.Name)
	if err != nil {
		h.replyCLIProfileError(ctx, conn, req.ID, err)
		return
	}
	h.cliProfileWatcher.Changed()
	h.log.Info("added AI CLI profile", "agent", params.Agent, "profile", profile.ID)

	if err := conn.Reply(ctx, req.ID, rpc.CLIProfileAddResult{Profile: profile}); err != nil {
		h.log.Error("failed to send cli profile add response", "error", err)
	}
}

func (h *rpcMethodHandler) handleCLIProfileRename(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIProfileRenameParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if !h.requireCLIProfileAgent(ctx, conn, req.ID, params.Agent) {
		return
	}
	if params.ProfileID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: profile_id is required; the default profile has no name to change")
		return
	}

	if err := h.cliProfiles.Rename(params.Agent, params.ProfileID, params.Name); err != nil {
		h.replyCLIProfileError(ctx, conn, req.ID, err)
		return
	}
	h.cliProfileWatcher.Changed()

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send cli profile rename response", "error", err)
	}
}

// handleCLIProfileSwitch changes the current profile and nothing else: every
// session reads it again on its next message and moves over by itself
// (docs/code/agent-integration.md#a-session-follows-the-current-profile).
//
// It is not refused where profiles cannot be used (Availability): the list is
// shared with every Pockode process of the OS user, and one that can use them
// follows the choice. Here the CLIs keep running as the default profile, which
// the subscription's availability lets a client explain.
func (h *rpcMethodHandler) handleCLIProfileSwitch(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIProfileSwitchParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if !h.requireCLIProfileAgent(ctx, conn, req.ID, params.Agent) {
		return
	}
	if params.ProfileID == nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, `invalid params: profile_id is required ("" for the default profile)`)
		return
	}

	if err := h.cliAuth.SwitchProfile(params.Agent, *params.ProfileID); err != nil {
		h.replyCLIProfileError(ctx, conn, req.ID, err)
		return
	}
	h.cliProfileWatcher.Changed()
	h.log.Info("switched AI CLI profile", "agent", params.Agent, "profile", *params.ProfileID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send cli profile switch response", "error", err)
	}
}

// requireCLIProfileAgent checks that a change names a CLI whose profiles are
// listed — the CLIs cli_auth.* knows — and replies when it does not.
func (h *rpcMethodHandler) requireCLIProfileAgent(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, agent session.AgentType) bool {
	if agent == "" {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, "invalid params: agent is required")
		return false
	}
	if !slices.Contains(h.cliAuth.Agents(), agent) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, fmt.Errorf("%w: %q", cliauth.ErrUnknownAgent, agent).Error())
		return false
	}
	return true
}

// replyCLIProfileError words a refused change for the user: the name and the
// profile ID are theirs to fix. ErrNoStore is not — nothing the client sends
// can give the machine a configuration directory.
func (h *rpcMethodHandler) replyCLIProfileError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error) {
	h.replyReasonError(ctx, conn, id, err,
		cliprofile.ErrInvalidName,
		cliprofile.ErrNameTaken,
		cliprofile.ErrNotFound,
		cliauth.ErrProfileRemoving,
	)
}

// profileReleaser is worktree.Manager's ReleaseProfile.
type profileReleaser interface {
	ReleaseProfile(ctx context.Context, agentType session.AgentType, profileID string) ([]worktree.ProfileUser, error)
}

// profileInUseError is a profile some sessions of this server are mid-turn on.
type profileInUseError struct {
	agent session.AgentType
	users []worktree.ProfileUser
}

func (e *profileInUseError) Error() string {
	return fmt.Sprintf("%d session(s) are still mid-turn on this %s profile; try again once their turns are over", len(e.users), e.agent)
}

// handleCLIProfileRemove signs a profile out and removes it, after this
// server's CLIs running as it have stopped; see cliauth.Service.RemoveProfile
// for the order and why. A refusal changes nothing and pushes nothing.
//
// CLIs other Pockode processes started as the profile — another cluster node
// — cannot be seen from here (docs/code/cli-profiles.md#switching-and-removing).
func (h *rpcMethodHandler) handleCLIProfileRemove(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIProfileRemoveParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if !h.requireCLIProfileAgent(ctx, conn, req.ID, params.Agent) {
		return
	}

	err := h.cliAuth.RemoveProfile(ctx, params.Agent, params.ProfileID, func(ctx context.Context) error {
		busy, err := h.profileReleaser.ReleaseProfile(ctx, params.Agent, params.ProfileID)
		if err != nil {
			return err
		}
		if len(busy) > 0 {
			return &profileInUseError{agent: params.Agent, users: busy}
		}
		return nil
	})
	// The list changed even if the directory could not be deleted.
	if err == nil || errors.Is(err, cliprofile.ErrDirectoryLeft) {
		h.cliProfileWatcher.Changed()
	}
	if err != nil {
		h.replyCLIProfileRemoveError(ctx, conn, req.ID, err)
		return
	}
	h.log.Info("removed AI CLI profile", "agent", params.Agent, "profile", params.ProfileID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send cli profile remove response", "error", err)
	}
}

func (h *rpcMethodHandler) replyCLIProfileRemoveError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error) {
	data := rpc.CLIProfileRemoveRefusedData{Reason: cliProfileRemoveRefusal(err)}
	if data.Reason == "" {
		h.replyReasonError(ctx, conn, id, err,
			cliauth.ErrUnknownAgent,
			cliauth.ErrRemoveDefault,
			cliprofile.ErrNotFound,
		)
		return
	}
	var inUse *profileInUseError
	if errors.As(err, &inUse) {
		for _, u := range inUse.users {
			data.Sessions = append(data.Sessions, rpc.CLIProfileUser{Worktree: u.Worktree, SessionID: u.SessionID})
		}
	}
	h.replyErrorData(ctx, conn, id, rpc.CodeCLIProfileRemoveRefused, err.Error(), data)
}

// cliProfileRemoveRefusal is the reason of a removal refused for a state the
// user can change, or "" for any other error.
func cliProfileRemoveRefusal(err error) string {
	var inUse *profileInUseError
	switch {
	case errors.Is(err, cliauth.ErrRemoveCurrent),
		// Made current by another Pockode process after the removal checked.
		errors.Is(err, process.ErrProfileCurrent):
		return rpc.CLIProfileRemoveRefusedCurrent
	case errors.As(err, &inUse):
		return rpc.CLIProfileRemoveRefusedInUse
	case errors.Is(err, cliauth.ErrLoginInProgress):
		return rpc.CLIProfileRemoveRefusedSigningIn
	case errors.Is(err, cliauth.ErrUpdating):
		return rpc.CLIProfileRemoveRefusedUpdating
	case errors.Is(err, cliauth.ErrProfileRemoving):
		return rpc.CLIProfileRemoveRefusedRemoving
	case errors.Is(err, cliauth.ErrSignOutFailed):
		return rpc.CLIProfileRemoveRefusedSignOutFailed
	case errors.Is(err, cliauth.ErrReleaseTimedOut):
		return rpc.CLIProfileRemoveRefusedStillExiting
	}
	return ""
}
