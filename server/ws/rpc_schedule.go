package ws

import (
	"context"
	"errors"
	"fmt"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/schedule"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// replyScheduleError classifies schedule errors into JSON-RPC error codes.
func (h *rpcMethodHandler) replyScheduleError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error, fallbackMsg string) {
	if errors.Is(err, schedule.ErrNotFound) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, "schedule not found")
	} else if errors.Is(err, schedule.ErrInvalidSchedule) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, err.Error())
	} else {
		h.replyInternalError(ctx, conn, id, fallbackMsg, err)
	}
}

// checkScheduleWorktree refuses a worktree that does not exist when the
// schedule is saved. Stored anyway, it would only surface at the next firing,
// as a failed run nobody was watching for. A worktree deleted later still
// fails that way — the check is for the mistake made here.
func (h *rpcMethodHandler) checkScheduleWorktree(name string) error {
	if name == "" {
		return nil
	}
	_, err := h.worktreeManager.Registry().Resolve(name)
	switch {
	case errors.Is(err, worktree.ErrNotGitRepo):
		return fmt.Errorf("%w: worktree %q: the project is not a git repository, so runs can only be made in the main worktree", schedule.ErrInvalidSchedule, name)
	case errors.Is(err, worktree.ErrWorktreeNotFound):
		return fmt.Errorf("%w: worktree %q does not exist", schedule.ErrInvalidSchedule, name)
	}
	return err
}

func (h *rpcMethodHandler) handleScheduleCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.ScheduleCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := h.checkScheduleWorktree(params.Worktree); err != nil {
		h.replyScheduleError(ctx, conn, req.ID, err, "failed to check the worktree")
		return
	}

	enabled := params.Enabled == nil || *params.Enabled
	sched, err := h.scheduleStore.Create(ctx, schedule.Schedule{
		Title:       params.Title,
		Prompt:      params.Prompt,
		AgentRoleID: params.AgentRoleID,
		Cron:        params.Cron,
		TimeZone:    params.TimeZone,
		Enabled:     enabled,
		Worktree:    params.Worktree,
	})
	if err != nil {
		h.replyScheduleError(ctx, conn, req.ID, err, "failed to create schedule")
		return
	}

	h.log.Info("schedule created", "scheduleId", sched.ID, "title", sched.Title)

	if err := conn.Reply(ctx, req.ID, sched); err != nil {
		h.log.Error("failed to send schedule create response", "error", err)
	}
}

func (h *rpcMethodHandler) handleScheduleUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.ScheduleUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Worktree != nil {
		if err := h.checkScheduleWorktree(*params.Worktree); err != nil {
			h.replyScheduleError(ctx, conn, req.ID, err, "failed to check the worktree")
			return
		}
	}

	fields := schedule.UpdateFields{
		Title:       params.Title,
		Prompt:      params.Prompt,
		AgentRoleID: params.AgentRoleID,
		Cron:        params.Cron,
		TimeZone:    params.TimeZone,
		Enabled:     params.Enabled,
		Worktree:    params.Worktree,
	}
	if _, err := h.scheduleStore.Update(ctx, params.ID, fields); err != nil {
		h.replyScheduleError(ctx, conn, req.ID, err, "failed to update schedule")
		return
	}

	h.log.Info("schedule updated", "scheduleId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send schedule update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleScheduleDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.ScheduleDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// The schedule's runs are kept: each is a work with its own session and
	// history, and deleting the schedule is not a request to delete them.
	if err := h.scheduleStore.Delete(ctx, params.ID); err != nil {
		h.replyScheduleError(ctx, conn, req.ID, err, "failed to delete schedule")
		return
	}

	h.log.Info("schedule deleted", "scheduleId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send schedule delete response", "error", err)
	}
}

// handleScheduleRun makes and starts a run now, and replies with it as
// work.start replies with the work it started.
func (h *rpcMethodHandler) handleScheduleRun(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.ScheduleRunParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	run, err := h.scheduler.RunNow(ctx, params.ID)
	if err != nil {
		switch {
		case errors.Is(err, schedule.ErrNotFound):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "schedule not found")
		case errors.Is(err, work.ErrRunActive), errors.Is(err, work.ErrInvalidWork):
			// A run still going, or a job the work store refuses to make or
			// start: the user's to resolve, so the message is theirs to read.
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		default:
			// Surfaced verbatim, as work.start does, so the user sees why the
			// agent did not start. The scheduler has already recorded it on the
			// schedule as its last failure.
			h.replyInternalError(ctx, conn, req.ID, "failed to run schedule", err, "scheduleId", params.ID)
		}
		return
	}

	h.log.Info("schedule run by hand", "scheduleId", params.ID, "workId", run.ID)

	if err := conn.Reply(ctx, req.ID, rpc.NewWorkDetailItem(run)); err != nil {
		h.log.Error("failed to send schedule run response", "error", err)
	}
}

func (h *rpcMethodHandler) handleScheduleListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	id, ok := h.subscriptionID(ctx, conn, req)
	if !ok {
		return
	}

	items, err := h.scheduleListWatcher.Subscribe(id, h.state.getNotifier())
	if err != nil {
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to schedule list")
		return
	}
	h.state.trackSubscription(id, h.scheduleListWatcher)
	h.log.Debug("subscribed", "watcher", "schedule list", "watchId", id)

	if err := conn.Reply(ctx, req.ID, rpc.ScheduleListSubscribeResult{Items: items}); err != nil {
		h.log.Error("failed to send schedule list subscribe response", "error", err)
	}
}

func (h *rpcMethodHandler) handleScheduleDetailSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.ScheduleDetailSubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.ScheduleID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "schedule_id is required")
		return
	}

	detail, err := h.scheduleDetailWatcher.Subscribe(params.ID, params.ScheduleID, h.state.getNotifier())
	if err != nil {
		if h.replySubscriptionIDError(ctx, conn, req.ID, err) {
			return
		}
		h.replyScheduleError(ctx, conn, req.ID, err, "failed to subscribe to schedule detail")
		return
	}
	h.state.trackSubscription(params.ID, h.scheduleDetailWatcher)
	h.log.Debug("subscribed", "watcher", "schedule detail", "watchId", params.ID, "scheduleId", params.ScheduleID)

	result := rpc.ScheduleDetailSubscribeResult{
		Schedule: detail.Schedule,
		Runs:     detail.Runs,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send schedule detail subscribe response", "error", err)
	}
}

// handleScheduleDetailRuns serves a page of older runs against an open detail
// subscription, refused the way every list page is (replyListPageError).
func (h *rpcMethodHandler) handleScheduleDetailRuns(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.ScheduleDetailRunsParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	page, err := h.scheduleDetailWatcher.Runs(params.ID, params.Cursor, params.Limit)
	if err != nil {
		h.replyListPageError(ctx, conn, req.ID, err, "failed to read the schedule's runs")
		return
	}

	if err := conn.Reply(ctx, req.ID, page); err != nil {
		h.log.Error("failed to send schedule detail runs response", "error", err)
	}
}
