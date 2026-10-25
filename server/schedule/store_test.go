package schedule

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/work"
)

var bgCtx = context.Background()

type testEnv struct {
	dataDir string
	roles   *agentrole.FileStore
	store   *FileStore
	clock   time.Time
	jobRole agentrole.AgentRole
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	env := &testEnv{dataDir: t.TempDir(), clock: time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)}
	roles, err := agentrole.NewFileStore(env.dataDir)
	if err != nil {
		t.Fatalf("agentrole.NewFileStore: %v", err)
	}
	env.roles = roles
	all, _ := roles.List()
	for _, r := range all {
		if r.WorkType == work.WorkTypeJob {
			env.jobRole = r
		}
	}
	if env.jobRole.ID == "" {
		t.Fatal("default roles have no job role")
	}
	env.store = env.open(t)
	return env
}

// open loads a store over the environment's data dir, as a server start does.
func (env *testEnv) open(t *testing.T) *FileStore {
	t.Helper()
	s, err := NewFileStore(env.dataDir, env.roles)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	s.now = func() time.Time { return env.clock }
	return s
}

func (env *testEnv) valid() Schedule {
	return Schedule{
		Title:       "Nightly triage",
		Prompt:      "Triage new issues",
		AgentRoleID: env.jobRole.ID,
		Cron:        "0 9 * * *",
		TimeZone:    "UTC",
		Enabled:     true,
	}
}

func (env *testEnv) create(t *testing.T, s Schedule) Schedule {
	t.Helper()
	created, err := env.store.Create(bgCtx, s)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return created
}

func at(t time.Time) *time.Time { return &t }

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

type recorder struct {
	eventsMu sync.Mutex
	events   []ChangeEvent
}

func (r *recorder) OnScheduleChange(e ChangeEvent) {
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	r.events = append(r.events, e)
}

func (r *recorder) ops() []Operation {
	r.eventsMu.Lock()
	defer r.eventsMu.Unlock()
	var ops []Operation
	for _, e := range r.events {
		ops = append(ops, e.Op)
	}
	return ops
}

func TestCreate_ComputesNextRunAndPersists(t *testing.T) {
	env := newTestEnv(t)
	in := env.valid()
	in.Cron = "  0 9 * * *  "
	in.Worktree = "feature"

	s := env.create(t, in)

	if s.ID == "" || s.CreatedAt.IsZero() {
		t.Errorf("created = %+v, want an id and a creation time", s)
	}
	if s.Cron != "0 9 * * *" {
		t.Errorf("cron = %q, want it trimmed", s.Cron)
	}
	if want := at(time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)); !sameTime(s.NextRunAt, want) {
		t.Errorf("next run = %v, want %v", s.NextRunAt, want)
	}

	got, found, err := env.open(t).Get(s.ID)
	if err != nil || !found {
		t.Fatalf("Get after reload: found=%v err=%v", found, err)
	}
	if got.Title != in.Title || got.Prompt != in.Prompt || got.Worktree != "feature" || !sameTime(got.NextRunAt, s.NextRunAt) {
		t.Errorf("reloaded = %+v, want %+v", got, s)
	}
}

func TestCreate_DisabledHasNoNextRun(t *testing.T) {
	env := newTestEnv(t)
	in := env.valid()
	in.Enabled = false

	if s := env.create(t, in); s.NextRunAt != nil {
		t.Errorf("next run = %v, want nil", s.NextRunAt)
	}
}

func TestCreate_Rejects(t *testing.T) {
	env := newTestEnv(t)
	taskRole, err := env.roles.Create(bgCtx, agentrole.AgentRole{Name: "Coder", WorkType: work.WorkTypeTask})
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		mutate  func(*Schedule)
		wantMsg string
	}{
		{"no title", func(s *Schedule) { s.Title = " " }, "title is required"},
		{"no prompt", func(s *Schedule) { s.Prompt = "" }, "prompt is required"},
		{"no role", func(s *Schedule) { s.AgentRoleID = "" }, "agent_role_id is required"},
		{"unknown role", func(s *Schedule) { s.AgentRoleID = "missing" }, "agent role not found"},
		{"role that does not take jobs", func(s *Schedule) { s.AgentRoleID = taskRole.ID }, "only takes task work, not job"},
		{"bad cron", func(s *Schedule) { s.Cron = "every day" }, "must have 5 fields"},
		{"cron that never runs", func(s *Schedule) { s.Cron = "0 0 31 4 *" }, "never runs"},
		{"no time zone", func(s *Schedule) { s.TimeZone = "" }, "time_zone is required"},
		{"the server's zone in disguise", func(s *Schedule) { s.TimeZone = "Local" }, "not an IANA name"},
		{"unknown time zone", func(s *Schedule) { s.TimeZone = "Mars/Olympus_Mons" }, "unknown time zone \"Mars/Olympus_Mons\""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := env.valid()
			tt.mutate(&in)
			_, err := env.store.Create(bgCtx, in)
			if !errors.Is(err, ErrInvalidSchedule) {
				t.Fatalf("err = %v, want ErrInvalidSchedule", err)
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("err = %q, want it to contain %q", err, tt.wantMsg)
			}
		})
	}

	if list, _ := env.store.List(); len(list) != 0 {
		t.Errorf("list = %d schedules, want none", len(list))
	}
}

func TestUpdate(t *testing.T) {
	env := newTestEnv(t)
	s := env.create(t, env.valid())
	nineAM := at(time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC))

	str := func(v string) *string { return &v }
	off, on := false, true

	tests := []struct {
		name     string
		fields   UpdateFields
		wantNext *time.Time
	}{
		{"settings other than timing keep the next run", UpdateFields{Title: str("Renamed"), Prompt: str("New"), Worktree: str("wt")}, nineAM},
		{"a new cron moves it", UpdateFields{Cron: str("30 8 * * *")}, at(time.Date(2026, 1, 1, 8, 30, 0, 0, time.UTC))},
		{"disabling clears it", UpdateFields{Enabled: &off}, nil},
		{"enabling computes it from now", UpdateFields{Enabled: &on}, at(time.Date(2026, 1, 1, 8, 30, 0, 0, time.UTC))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env.clock = env.clock.Add(time.Minute)
			got, err := env.store.Update(bgCtx, s.ID, tt.fields)
			if err != nil {
				t.Fatalf("Update: %v", err)
			}
			if !sameTime(got.NextRunAt, tt.wantNext) {
				t.Errorf("next run = %v, want %v", got.NextRunAt, tt.wantNext)
			}
			if !got.UpdatedAt.Equal(env.clock) {
				t.Errorf("updated at = %v, want %v", got.UpdatedAt, env.clock)
			}
		})
	}

	got, _, _ := env.store.Get(s.ID)
	if got.Title != "Renamed" || got.Prompt != "New" || got.Worktree != "wt" || got.Cron != "30 8 * * *" {
		t.Errorf("schedule = %+v, want every update applied", got)
	}
}

// The period is read on the schedule's own wall clock, daylight saving time
// included, whatever zone the server is in. How a skipped or repeated wall time
// fires is Cron.Next's (TestCron_Next_DST).
func TestCreate_ReadsThePeriodInTheSchedulesZone(t *testing.T) {
	env := newTestEnv(t)
	tests := []struct {
		zone  string
		clock time.Time
		want  time.Time
	}{
		// 17:00 in Tokyo: today's 09:00 has passed.
		{"Asia/Tokyo", time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC), time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)},
		// 09:00 on the morning New York springs forward is EDT, not EST.
		{"America/New_York", time.Date(2026, 3, 7, 15, 0, 0, 0, time.UTC), time.Date(2026, 3, 8, 13, 0, 0, 0, time.UTC)},
	}
	for _, tt := range tests {
		t.Run(tt.zone, func(t *testing.T) {
			env.clock = tt.clock
			in := env.valid()
			in.TimeZone = tt.zone

			s := env.create(t, in)

			if s.TimeZone != tt.zone {
				t.Errorf("time zone = %q, want %q", s.TimeZone, tt.zone)
			}
			if !sameTime(s.NextRunAt, &tt.want) {
				t.Errorf("next run = %v, want %v", s.NextRunAt, tt.want)
			}
		})
	}
}

// Editing the period keeps the schedule's zone; it moves only when a new one
// is sent, and the next run moves with it.
func TestUpdate_ZoneMovesOnlyWhenSent(t *testing.T) {
	env := newTestEnv(t) // 2026-01-01 08:00 UTC
	in := env.valid()
	in.TimeZone = "Asia/Tokyo"
	s := env.create(t, in)

	cron := "0 18 * * *"
	got, err := env.store.Update(bgCtx, s.ID, UpdateFields{Cron: &cron})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if want := at(time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)); got.TimeZone != "Asia/Tokyo" || !sameTime(got.NextRunAt, want) {
		t.Errorf("after a new cron: zone %q, next run %v; want Asia/Tokyo, %v", got.TimeZone, got.NextRunAt, want)
	}

	zone := "Europe/London"
	got, err = env.store.Update(bgCtx, s.ID, UpdateFields{TimeZone: &zone})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if want := at(time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC)); got.TimeZone != zone || !sameTime(got.NextRunAt, want) {
		t.Errorf("after a new zone: zone %q, next run %v; want %s, %v", got.TimeZone, got.NextRunAt, zone, want)
	}

	bad := "Europe/Atlantis"
	if _, err := env.store.Update(bgCtx, s.ID, UpdateFields{TimeZone: &bad}); !errors.Is(err, ErrInvalidSchedule) {
		t.Errorf("update to an unknown zone: err = %v, want ErrInvalidSchedule", err)
	}
	if got, _, _ := env.store.Get(s.ID); got.TimeZone != zone {
		t.Errorf("zone after a refused update = %q, want %q", got.TimeZone, zone)
	}
}

func TestUpdate_InvalidLeavesScheduleUntouched(t *testing.T) {
	env := newTestEnv(t)
	s := env.create(t, env.valid())
	title, bad := "Renamed", "61 * * * *"

	_, err := env.store.Update(bgCtx, s.ID, UpdateFields{Title: &title, Cron: &bad})
	if !errors.Is(err, ErrInvalidSchedule) {
		t.Fatalf("err = %v, want ErrInvalidSchedule", err)
	}
	if got, _, _ := env.store.Get(s.ID); got.Title != s.Title || got.Cron != s.Cron {
		t.Errorf("schedule = %+v, want it unchanged", got)
	}
}

func TestUpdate_RoleIsJudgedOnlyWhenItChanges(t *testing.T) {
	env := newTestEnv(t)
	s := env.create(t, env.valid())

	// The role stops taking jobs after it was assigned.
	task := work.WorkTypeTask
	if err := env.roles.Update(bgCtx, env.jobRole.ID, agentrole.UpdateFields{WorkType: &task}); err != nil {
		t.Fatal(err)
	}

	title, sameRole := "Renamed", env.jobRole.ID
	if _, err := env.store.Update(bgCtx, s.ID, UpdateFields{Title: &title, AgentRoleID: &sameRole}); err != nil {
		t.Errorf("update keeping the role: %v", err)
	}

	other, err := env.roles.Create(bgCtx, agentrole.AgentRole{Name: "Other", WorkType: work.WorkTypeTask})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.store.Update(bgCtx, s.ID, UpdateFields{AgentRoleID: &other.ID}); !errors.Is(err, ErrInvalidSchedule) {
		t.Errorf("update to a role that takes no jobs: err = %v, want ErrInvalidSchedule", err)
	}
}

func TestUpdateAndDelete_NotFound(t *testing.T) {
	env := newTestEnv(t)
	if _, err := env.store.Update(bgCtx, "missing", UpdateFields{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("Update: err = %v, want ErrNotFound", err)
	}
	if err := env.store.Delete(bgCtx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Delete: err = %v, want ErrNotFound", err)
	}
	if _, err := env.store.RecordRun(bgCtx, "missing", "w"); !errors.Is(err, ErrNotFound) {
		t.Errorf("RecordRun: err = %v, want ErrNotFound", err)
	}
}

func TestDelete_LeavesItsRunsAlone(t *testing.T) {
	env := newTestEnv(t)
	works, err := work.NewFileStore(env.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	s := env.create(t, env.valid())
	run, err := works.CreateJob(bgCtx, work.Work{ScheduleID: s.ID, AgentRoleID: s.AgentRoleID, Title: s.Title, Body: s.Prompt})
	if err != nil {
		t.Fatal(err)
	}

	if err := env.store.Delete(bgCtx, s.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, found, _ := env.open(t).Get(s.ID); found {
		t.Error("schedule still there after reload")
	}
	runs, err := works.ListBySchedule(s.ID)
	if err != nil || len(runs) != 1 || runs[0].ID != run.ID {
		t.Errorf("runs = %v (err %v), want the one run kept", runs, err)
	}
}

func TestRecordRunAndSkip(t *testing.T) {
	env := newTestEnv(t)
	s := env.create(t, env.valid())

	env.clock = time.Date(2026, 1, 1, 9, 0, 3, 0, time.UTC)
	ran, err := env.store.RecordRun(bgCtx, s.ID, "work-1")
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	tomorrow := at(time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC))
	if !sameTime(ran.LastRunAt, at(env.clock)) || ran.LastRunWorkID != "work-1" || !sameTime(ran.NextRunAt, tomorrow) {
		t.Errorf("after run = %+v, want last run now as work-1 and next run tomorrow", ran)
	}
	if !ran.UpdatedAt.Equal(s.UpdatedAt) {
		t.Errorf("updated at moved to %v; bookkeeping is not an edit", ran.UpdatedAt)
	}

	env.clock = time.Date(2026, 1, 2, 9, 0, 1, 0, time.UTC)
	skipped, err := env.store.RecordSkip(bgCtx, s.ID)
	if err != nil {
		t.Fatalf("RecordSkip: %v", err)
	}
	if !sameTime(skipped.LastSkippedAt, at(env.clock)) || skipped.LastRunWorkID != "work-1" ||
		!sameTime(skipped.NextRunAt, at(time.Date(2026, 1, 3, 9, 0, 0, 0, time.UTC))) {
		t.Errorf("after skip = %+v, want skip recorded, last run kept, next run the day after", skipped)
	}

	if _, err := env.store.RecordRun(bgCtx, s.ID, ""); !errors.Is(err, ErrInvalidSchedule) {
		t.Errorf("RecordRun without a work: err = %v, want ErrInvalidSchedule", err)
	}
}

func TestRecordFailure_ClearedByTheNextRun(t *testing.T) {
	env := newTestEnv(t)
	s := env.create(t, env.valid())

	env.clock = time.Date(2026, 1, 1, 9, 0, 1, 0, time.UTC)
	failed, err := env.store.RecordFailure(bgCtx, s.ID, "work-1", "worktree not found")
	if err != nil {
		t.Fatalf("RecordFailure: %v", err)
	}
	want := RunFailure{At: env.clock, WorkID: "work-1", Error: "worktree not found"}
	if failed.LastFailure == nil || *failed.LastFailure != want {
		t.Errorf("failure = %+v, want %+v", failed.LastFailure, want)
	}
	if failed.LastRunWorkID != "" || !sameTime(failed.NextRunAt, at(time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC))) {
		t.Errorf("after failure = %+v, want no run recorded and next run tomorrow", failed)
	}

	ran, err := env.store.RecordRun(bgCtx, s.ID, "work-2")
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	if ran.LastFailure != nil {
		t.Errorf("failure = %+v after a run started, want it cleared", ran.LastFailure)
	}
}

func TestRecordRun_ByHandOnADisabledSchedule(t *testing.T) {
	env := newTestEnv(t)
	in := env.valid()
	in.Enabled = false
	s := env.create(t, in)

	ran, err := env.store.RecordRun(bgCtx, s.ID, "work-1")
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	if ran.LastRunWorkID != "work-1" || ran.NextRunAt != nil {
		t.Errorf("after run = %+v, want the run recorded and still no next run", ran)
	}
}

func TestSkipMissedRuns(t *testing.T) {
	env := newTestEnv(t)
	missed := env.create(t, env.valid())
	laterIn := env.valid()
	laterIn.Cron = "0 9 1 6 *"
	later := env.create(t, laterIn)
	disabledIn := env.valid()
	disabledIn.Enabled = false
	disabled := env.create(t, disabledIn)

	// The server was down across several of missed's firings.
	env.clock = time.Date(2026, 1, 4, 12, 0, 0, 0, time.UTC)
	store := env.open(t)
	rec := &recorder{}
	store.AddOnChangeListener(rec)

	if err := store.SkipMissedRuns(bgCtx); err != nil {
		t.Fatalf("SkipMissedRuns: %v", err)
	}

	got, _, _ := store.Get(missed.ID)
	if want := at(time.Date(2026, 1, 5, 9, 0, 0, 0, time.UTC)); !sameTime(got.NextRunAt, want) {
		t.Errorf("missed next run = %v, want %v", got.NextRunAt, want)
	}
	if got.LastRunAt != nil || got.LastSkippedAt != nil {
		t.Errorf("missed = %+v, want no run or skip recorded for firings that never happened", got)
	}
	if got, _, _ := store.Get(later.ID); !sameTime(got.NextRunAt, later.NextRunAt) {
		t.Errorf("future next run = %v, want it left at %v", got.NextRunAt, later.NextRunAt)
	}
	if got, _, _ := store.Get(disabled.ID); got.NextRunAt != nil {
		t.Errorf("disabled next run = %v, want nil", got.NextRunAt)
	}
	if ops := rec.ops(); len(ops) != 1 || ops[0] != OperationUpdate {
		t.Errorf("events = %v, want one update for the missed schedule", ops)
	}

	if got, _, _ := env.open(t).Get(missed.ID); !sameTime(got.NextRunAt, at(time.Date(2026, 1, 5, 9, 0, 0, 0, time.UTC))) {
		t.Errorf("reloaded next run = %v, want it persisted", got.NextRunAt)
	}
}

func TestChangeNotifications(t *testing.T) {
	env := newTestEnv(t)
	rec := &recorder{}
	env.store.AddOnChangeListener(rec)

	s := env.create(t, env.valid())
	title := "Renamed"
	if _, err := env.store.Update(bgCtx, s.ID, UpdateFields{Title: &title}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.store.RecordRun(bgCtx, s.ID, "w"); err != nil {
		t.Fatal(err)
	}
	if _, err := env.store.RecordSkip(bgCtx, s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.store.Update(bgCtx, s.ID, UpdateFields{Cron: new(string)}); err == nil {
		t.Fatal("empty cron accepted")
	}
	if err := env.store.Delete(bgCtx, s.ID); err != nil {
		t.Fatal(err)
	}

	want := []Operation{OperationCreate, OperationUpdate, OperationUpdate, OperationUpdate, OperationDelete}
	got := rec.ops()
	if len(got) != len(want) {
		t.Fatalf("events = %v, want %v (a refused update notifies nobody)", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("events = %v, want %v", got, want)
			break
		}
	}
	rec.eventsMu.Lock()
	defer rec.eventsMu.Unlock()
	if last := rec.events[len(rec.events)-1]; last.Schedule.ID != s.ID {
		t.Errorf("delete event names %q, want %q", last.Schedule.ID, s.ID)
	}
}
