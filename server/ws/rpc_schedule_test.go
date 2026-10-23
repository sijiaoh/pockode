package ws

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/schedule"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

type scheduleListChanged struct {
	ID         string                `json:"id"`
	Operation  string                `json:"operation"`
	Schedule   *rpc.ScheduleListItem `json:"schedule"`
	ScheduleID string                `json:"scheduleId"`
}

type scheduleDetailChanged struct {
	ID         string              `json:"id"`
	Schedule   schedule.Schedule   `json:"schedule"`
	Runs       rpc.ScheduleRunPage `json:"runs"`
	ServerZone schedule.Zone       `json:"server_zone"`
}

func createSchedule(t *testing.T, env *testEnv, params rpc.ScheduleCreateParams) schedule.Schedule {
	t.Helper()
	if params.Title == "" {
		params.Title = "Nightly report"
	}
	if params.Prompt == "" {
		params.Prompt = "Summarise yesterday's commits."
	}
	if params.AgentRoleID == "" {
		params.AgentRoleID = env.testRoleID
	}
	if params.Cron == "" {
		params.Cron = "0 3 * * *"
	}
	resp := env.call("schedule.create", params)
	if resp.Error != nil {
		t.Fatalf("schedule.create: %s", resp.Error.Message)
	}
	var sched schedule.Schedule
	if err := json.Unmarshal(resp.Result, &sched); err != nil {
		t.Fatalf("unmarshal schedule: %v", err)
	}
	return sched
}

func subscribeScheduleDetail(t *testing.T, env *testEnv, scheduleID string) (string, rpc.ScheduleDetailSubscribeResult) {
	t.Helper()
	subID := env.nextSubID()
	resp := env.call("schedule.detail.subscribe", rpc.ScheduleDetailSubscribeParams{ID: subID, ScheduleID: scheduleID})
	if resp.Error != nil {
		t.Fatalf("schedule.detail.subscribe: %s", resp.Error.Message)
	}
	var result rpc.ScheduleDetailSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal schedule detail: %v", err)
	}
	return subID, result
}

func awaitScheduleDetail(t *testing.T, env *testEnv, ok func(scheduleDetailChanged) bool) scheduleDetailChanged {
	t.Helper()
	for {
		var params scheduleDetailChanged
		if err := json.Unmarshal(env.awaitNotification("schedule.detail.changed").Params, &params); err != nil {
			t.Fatalf("unmarshal schedule.detail.changed: %v", err)
		}
		if ok(params) {
			return params
		}
	}
}

func awaitScheduleList(t *testing.T, env *testEnv, operation string) scheduleListChanged {
	t.Helper()
	return awaitScheduleListWhere(t, env, func(c scheduleListChanged) bool { return c.Operation == operation })
}

func awaitScheduleListWhere(t *testing.T, env *testEnv, ok func(scheduleListChanged) bool) scheduleListChanged {
	t.Helper()
	for {
		var params scheduleListChanged
		if err := json.Unmarshal(env.awaitNotification("schedule.list.changed").Params, &params); err != nil {
			t.Fatalf("unmarshal schedule.list.changed: %v", err)
		}
		if ok(params) {
			return params
		}
	}
}

func subscribeScheduleList(t *testing.T, env *testEnv) rpc.ScheduleListSubscribeResult {
	t.Helper()
	resp := env.call("schedule.list.subscribe", rpc.SubscribeParams{ID: env.nextSubID()})
	if resp.Error != nil {
		t.Fatalf("schedule.list.subscribe: %s", resp.Error.Message)
	}
	var result rpc.ScheduleListSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal schedule list: %v", err)
	}
	return result
}

func runSchedule(t *testing.T, env *testEnv, scheduleID string) rpc.WorkDetailItem {
	t.Helper()
	resp := env.call("schedule.run", rpc.ScheduleRunParams{ID: scheduleID})
	if resp.Error != nil {
		t.Fatalf("schedule.run: %s", resp.Error.Message)
	}
	var run rpc.WorkDetailItem
	if err := json.Unmarshal(resp.Result, &run); err != nil {
		t.Fatalf("unmarshal run: %v", err)
	}
	return run
}

func TestHandler_ScheduleCreate_EnabledByDefault(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	sched := createSchedule(t, env, rpc.ScheduleCreateParams{Cron: " 0 3 * * * "})
	if !sched.Enabled || sched.NextRunAt == nil {
		t.Errorf("enabled = %v, next_run_at = %v; want an enabled schedule with its next firing", sched.Enabled, sched.NextRunAt)
	}
	if sched.Cron != "0 3 * * *" {
		t.Errorf("cron = %q, want it trimmed", sched.Cron)
	}

	disabled := false
	off := createSchedule(t, env, rpc.ScheduleCreateParams{Enabled: &disabled})
	if off.Enabled || off.NextRunAt != nil {
		t.Errorf("enabled = %v, next_run_at = %v; want a disabled schedule with no next firing", off.Enabled, off.NextRunAt)
	}

	resp := env.call("schedule.list.subscribe", rpc.SubscribeParams{ID: env.nextSubID()})
	if resp.Error != nil {
		t.Fatalf("schedule.list.subscribe: %s", resp.Error.Message)
	}
	var list rpc.ScheduleListSubscribeResult
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatalf("unmarshal schedule list: %v", err)
	}
	if len(list.Items) != 2 || list.Items[0].ID != sched.ID || list.Items[1].ID != off.ID {
		t.Errorf("list = %+v, want both schedules", list.Items)
	}
}

// TestHandler_Schedule_UserErrors pins which refusals are the user's: each is
// InvalidParams with a message that says what to fix.
func TestHandler_Schedule_UserErrors(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	storyRole, err := env.handler.agentRoleStore.Create(context.Background(), agentrole.AgentRole{
		Name: "PM", RolePrompt: "Plan.", WorkType: work.WorkTypeStory,
	})
	if err != nil {
		t.Fatalf("create story role: %v", err)
	}
	sched := createSchedule(t, env, rpc.ScheduleCreateParams{})
	badCron := "61 * * * *"
	missingWorktree := "nope"

	for _, tc := range []struct {
		name   string
		method string
		params any
		want   string
	}{
		{"unparsable cron", "schedule.create", rpc.ScheduleCreateParams{Title: "x", Prompt: "y", AgentRoleID: env.testRoleID, Cron: badCron}, "61 is out of range"},
		{"missing prompt", "schedule.create", rpc.ScheduleCreateParams{Title: "x", AgentRoleID: env.testRoleID, Cron: "* * * * *"}, "prompt"},
		{"role that takes no jobs", "schedule.create", rpc.ScheduleCreateParams{Title: "x", Prompt: "y", AgentRoleID: storyRole.ID, Cron: "* * * * *"}, "job"},
		{"update to an unparsable cron", "schedule.update", rpc.ScheduleUpdateParams{ID: sched.ID, Cron: &badCron}, "61 is out of range"},
		{"update of an unknown schedule", "schedule.update", rpc.ScheduleUpdateParams{ID: "nope"}, "schedule not found"},
		{"delete of an unknown schedule", "schedule.delete", rpc.ScheduleDeleteParams{ID: "nope"}, "schedule not found"},
		{"run of an unknown schedule", "schedule.run", rpc.ScheduleRunParams{ID: "nope"}, "schedule not found"},
		{"detail of an unknown schedule", "schedule.detail.subscribe", rpc.ScheduleDetailSubscribeParams{ID: env.nextSubID(), ScheduleID: "nope"}, "schedule not found"},
		{"detail without a schedule", "schedule.detail.subscribe", rpc.ScheduleDetailSubscribeParams{ID: env.nextSubID()}, "schedule_id is required"},
		{"worktree that does not exist", "schedule.create", rpc.ScheduleCreateParams{Title: "x", Prompt: "y", AgentRoleID: env.testRoleID, Cron: "* * * * *", Worktree: "nope"}, "worktree \"nope\""},
		{"update to a worktree that does not exist", "schedule.update", rpc.ScheduleUpdateParams{ID: sched.ID, Worktree: &missingWorktree}, "worktree \"nope\""},
		{"runs of no subscription", "schedule.detail.runs", rpc.ScheduleDetailRunsParams{ID: "nope"}, "no such subscription"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := env.call(tc.method, tc.params)
			if resp.Error == nil {
				t.Fatalf("%s: want an error", tc.method)
			}
			if resp.Error.Code != jsonrpc2.CodeInvalidParams {
				t.Errorf("code = %d, want InvalidParams", resp.Error.Code)
			}
			if !strings.Contains(resp.Error.Message, tc.want) {
				t.Errorf("message = %q, want it to mention %q", resp.Error.Message, tc.want)
			}
		})
	}

	// A refused update changes nothing.
	got, _, _ := env.scheduleStore.Get(sched.ID)
	if got.Cron != sched.Cron {
		t.Errorf("cron = %q after a refused update, want %q", got.Cron, sched.Cron)
	}
}

func TestHandler_ScheduleList_NotifiesEditsAndDeletes(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sched := createSchedule(t, env, rpc.ScheduleCreateParams{})

	subscribeScheduleList(t, env)

	title := "Weekly report"
	disabled := false
	if resp := env.call("schedule.update", rpc.ScheduleUpdateParams{ID: sched.ID, Title: &title, Enabled: &disabled}); resp.Error != nil {
		t.Fatalf("schedule.update: %s", resp.Error.Message)
	}
	updated := awaitScheduleList(t, env, "update")
	if updated.Schedule == nil || updated.Schedule.Title != title || updated.Schedule.Enabled || updated.Schedule.NextRunAt != nil {
		t.Errorf("update = %+v, want the new title, disabled, with no next firing", updated.Schedule)
	}

	if resp := env.call("schedule.delete", rpc.ScheduleDeleteParams{ID: sched.ID}); resp.Error != nil {
		t.Fatalf("schedule.delete: %s", resp.Error.Message)
	}
	deleted := awaitScheduleList(t, env, "delete")
	if deleted.ScheduleID != sched.ID || deleted.Schedule != nil {
		t.Errorf("delete = %+v, want only the id %q", deleted, sched.ID)
	}
}

// TestHandler_ScheduleRun_StartsAJobAndReportsIt covers run-now end to end: the
// reply is the started job, the detail hears of both the run and the
// bookkeeping, and a second run is refused while the first is going.
func TestHandler_ScheduleRun_StartsAJobAndReportsIt(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sched := createSchedule(t, env, rpc.ScheduleCreateParams{})
	_, initial := subscribeScheduleDetail(t, env, sched.ID)
	if len(initial.Runs.Items) != 0 || initial.Runs.HasMore {
		t.Fatalf("runs = %+v, want none", initial.Runs)
	}

	resp := env.call("schedule.run", rpc.ScheduleRunParams{ID: sched.ID})
	if resp.Error != nil {
		t.Fatalf("schedule.run: %s", resp.Error.Message)
	}
	var run rpc.WorkDetailItem
	if err := json.Unmarshal(resp.Result, &run); err != nil {
		t.Fatalf("unmarshal run: %v", err)
	}
	if run.Type != work.WorkTypeJob || run.ScheduleID != sched.ID || run.Status != work.StatusActive || run.Body != sched.Prompt {
		t.Errorf("run = %+v, want an active job of the schedule carrying its prompt", run)
	}

	detail := awaitScheduleDetail(t, env, func(d scheduleDetailChanged) bool {
		return d.Schedule.LastRunWorkID == run.ID && len(d.Runs.Items) == 1
	})
	if got := detail.Runs.Items[0]; got.ID != run.ID || got.Status != work.StatusActive || got.CreatedAt.IsZero() {
		t.Errorf("run row = %+v, want the active run with its creation time", got)
	}

	resp = env.call("schedule.run", rpc.ScheduleRunParams{ID: sched.ID})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, "still active") {
		t.Errorf("second run: error = %+v, want InvalidParams saying the previous run is still active", resp.Error)
	}

	// Deleting the schedule leaves its runs.
	if resp := env.call("schedule.delete", rpc.ScheduleDeleteParams{ID: sched.ID}); resp.Error != nil {
		t.Fatalf("schedule.delete: %s", resp.Error.Message)
	}
	if _, found, _ := env.workStore.Get(run.ID); !found {
		t.Error("the run was deleted with its schedule")
	}
}

// TestHandler_ScheduleDetail_NotifiesBookkeeping pins that the store's own
// bookkeeping — a firing skipped, a run failed — reaches the detail even though
// nobody edited the schedule.
func TestHandler_ScheduleDetail_NotifiesBookkeeping(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sched := createSchedule(t, env, rpc.ScheduleCreateParams{})
	subscribeScheduleDetail(t, env, sched.ID)
	ctx := context.Background()

	if _, err := env.scheduleStore.RecordSkip(ctx, sched.ID); err != nil {
		t.Fatalf("RecordSkip: %v", err)
	}
	awaitScheduleDetail(t, env, func(d scheduleDetailChanged) bool { return d.Schedule.LastSkippedAt != nil })

	if _, err := env.scheduleStore.RecordFailure(ctx, sched.ID, "", "create run: disk full"); err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}
	awaitScheduleDetail(t, env, func(d scheduleDetailChanged) bool {
		return d.Schedule.LastFailure != nil && d.Schedule.LastFailure.Error == "create run: disk full"
	})
}

// TestHandler_ScheduleDetail_PagesRunsNewestFirst covers the run list past one
// page: the detail carries the newest page, and schedule.detail.runs walks the
// rest without repeating or skipping a run.
func TestHandler_ScheduleDetail_PagesRunsNewestFirst(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sched := createSchedule(t, env, rpc.ScheduleCreateParams{})

	total := session.DefaultListPageSize + 5
	made := make([]string, 0, total)
	for range total {
		run, err := env.workStore.CreateJob(context.Background(), work.Work{
			ScheduleID: sched.ID, AgentRoleID: env.testRoleID, Title: sched.Title, Body: sched.Prompt,
		})
		if err != nil {
			t.Fatalf("CreateJob: %v", err)
		}
		made = append(made, run.ID)
	}

	subID, detail := subscribeScheduleDetail(t, env, sched.ID)
	if len(detail.Runs.Items) != session.DefaultListPageSize || !detail.Runs.HasMore || detail.Runs.NextCursor == "" {
		t.Fatalf("first page: %d runs, has_more %v, cursor %q; want a full page and more", len(detail.Runs.Items), detail.Runs.HasMore, detail.Runs.NextCursor)
	}

	resp := env.call("schedule.detail.runs", rpc.ScheduleDetailRunsParams{ID: subID, Cursor: detail.Runs.NextCursor})
	if resp.Error != nil {
		t.Fatalf("schedule.detail.runs: %s", resp.Error.Message)
	}
	var rest rpc.ScheduleRunPage
	if err := json.Unmarshal(resp.Result, &rest); err != nil {
		t.Fatalf("unmarshal runs page: %v", err)
	}
	if rest.HasMore || rest.NextCursor != "" {
		t.Errorf("last page: has_more %v, cursor %q; want the end", rest.HasMore, rest.NextCursor)
	}

	var got []string
	for _, item := range append(detail.Runs.Items, rest.Items...) {
		got = append(got, item.ID)
	}
	if len(got) != total {
		t.Fatalf("got %d runs across both pages, want %d", len(got), total)
	}
	for i, id := range got {
		if want := made[total-1-i]; id != want {
			t.Fatalf("run %d = %s, want %s (newest made first)", i, id, want)
		}
	}
}

// The server's zone rides on both subscriptions, because a period is the
// server's wall-clock time and the detail page is reachable without the list.
func TestHandler_ScheduleSubscriptions_CarryTheServerZone(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sched := createSchedule(t, env, rpc.ScheduleCreateParams{})
	name, offset := time.Now().Zone()
	want := schedule.Zone{Name: name, OffsetSeconds: offset}

	if got := subscribeScheduleList(t, env).ServerZone; got != want {
		t.Errorf("list server_zone = %+v, want %+v", got, want)
	}
	if _, detail := subscribeScheduleDetail(t, env, sched.ID); detail.ServerZone != want {
		t.Errorf("detail server_zone = %+v, want %+v", detail.ServerZone, want)
	}

	// A detail notification is the whole detail, so it carries the zone too.
	if _, err := env.scheduleStore.RecordSkip(context.Background(), sched.ID); err != nil {
		t.Fatalf("RecordSkip: %v", err)
	}
	changed := awaitScheduleDetail(t, env, func(d scheduleDetailChanged) bool { return d.Schedule.LastSkippedAt != nil })
	if changed.ServerZone != want {
		t.Errorf("schedule.detail.changed server_zone = %+v, want %+v", changed.ServerZone, want)
	}
}

// A list row draws its latest run, which nothing else on a client holds: the
// row arrives with the run and follows it as it moves, and is dropped with it.
func TestHandler_ScheduleList_CarriesTheLatestRun(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sched := createSchedule(t, env, rpc.ScheduleCreateParams{})
	if items := subscribeScheduleList(t, env).Items; len(items) != 1 || items[0].LastRun != nil {
		t.Fatalf("items = %+v, want the schedule with no run", items)
	}

	run := runSchedule(t, env, sched.ID)
	awaitScheduleListWhere(t, env, func(c scheduleListChanged) bool {
		return c.Schedule != nil && c.Schedule.LastRun != nil && c.Schedule.LastRun.ID == run.ID &&
			c.Schedule.LastRun.Status == work.StatusActive
	})

	if resp := env.call("work.stop", rpc.WorkStopParams{ID: run.ID}); resp.Error != nil {
		t.Fatalf("work.stop: %s", resp.Error.Message)
	}
	awaitScheduleListWhere(t, env, func(c scheduleListChanged) bool {
		return c.Schedule != nil && c.Schedule.LastRun != nil && c.Schedule.LastRun.Status == work.StatusStopped
	})

	if resp := env.call("work.delete", rpc.WorkDeleteParams{ID: run.ID}); resp.Error != nil {
		t.Fatalf("work.delete: %s", resp.Error.Message)
	}
	deleted := awaitScheduleListWhere(t, env, func(c scheduleListChanged) bool {
		return c.Schedule != nil && c.Schedule.LastRun == nil
	})
	if deleted.Schedule.LastRunWorkID != run.ID {
		t.Errorf("last_run_work_id = %q, want the deleted run still named by the record", deleted.Schedule.LastRunWorkID)
	}
	if items := subscribeScheduleList(t, env).Items; len(items) != 1 || items[0].LastRun != nil {
		t.Errorf("items after the delete = %+v, want no last_run", items)
	}
}
