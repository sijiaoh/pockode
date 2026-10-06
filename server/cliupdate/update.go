package cliupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
	"github.com/pockode/server/session"
)

// UpdateTimeout bounds an update command. `claude update` took 33s and
// `codex update` 22s from npm (measured, Claude Code 2.1.280 → 2.1.285, codex
// 0.158.0 → 0.159.2): the download is most of it, so the budget is for a slow
// connection, not a slow CLI.
const UpdateTimeout = 10 * time.Minute

// Phase is where an update stands.
type Phase string

const (
	PhaseRunning   Phase = "running"
	PhaseSucceeded Phase = "succeeded"
	PhaseFailed    Phase = "failed"
)

// FailureReason says why an update failed, in the words the client picks its
// copy by. Detail beside it carries what the CLI said.
type FailureReason string

const (
	// FailureNotInstalled is a CLI this server cannot find.
	FailureNotInstalled FailureReason = "not_installed"
	// FailureCommandFailed is the CLI's update command exiting non-zero:
	// usually an install directory the server's user cannot write (an npm
	// prefix owned by root), no network, or a file a running process holds on
	// Windows. Detail is the end of what it printed, which says which.
	FailureCommandFailed FailureReason = "command_failed"
	// FailureNotApplied is an update command that said it succeeded while the
	// CLI Pockode runs is still older than the latest release — it updated an
	// installation other than the one first on this server's PATH, or its
	// package manager has nothing newer yet.
	FailureNotApplied FailureReason = "not_applied"
	// FailureTimeout is an update that ran past UpdateTimeout; its process
	// tree was killed.
	FailureTimeout FailureReason = "timeout"
	// FailureOther is anything else; Detail says what.
	FailureOther FailureReason = "other"
)

// Update is one run of a CLI's update command, as a client sees it.
type Update struct {
	ID    string            `json:"id"`
	Agent session.AgentType `json:"agent"`
	// Revision grows with every change to any update. A command's reply and a
	// change notification travel separately and can arrive in either order, so
	// a client keeps whichever copy of an update has the higher revision. Only
	// copies with the same ID compare: revisions restart with the server.
	Revision int64 `json:"revision"`
	Phase    Phase `json:"phase"`
	// FromVersion is the version before the update, once read.
	FromVersion string `json:"from_version,omitempty"`
	// TargetVersion is the latest release as read when the update started,
	// once read. The CLI decides what it installs; this is what it should be.
	TargetVersion string `json:"target_version,omitempty"`
	// ToVersion is the version read after the update, when it could be — on a
	// failure too, where it shows what a partial update left. It equals
	// FromVersion when there was nothing newer to install.
	ToVersion string `json:"to_version,omitempty"`
	// BinaryPath is the executable Pockode runs for the CLI, the install the
	// update has to reach. Empty when the CLI is not found.
	BinaryPath string     `json:"binary_path,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	// Failure is set with PhaseFailed.
	Failure *Failure `json:"failure,omitempty"`
}

type Failure struct {
	Reason FailureReason `json:"reason"`
	// Detail is the CLI's own words, or Pockode's when it was Pockode that
	// found the update wanting.
	Detail string `json:"detail,omitempty"`
}

// Listener hears that a CLI's update changed. It is called outside any lock
// and must not block; Update reads what it now is.
type Listener interface {
	OnUpdateChange(agentType session.AgentType)
}

// AddListener registers l to hear about every update change. Not safe for use
// once updates may be running.
func (s *Service) AddListener(l Listener) {
	s.listeners = append(s.listeners, l)
}

// StartUpdate starts agentType's update command, or returns the update already
// running for it, so two screens pressing Update land in the same one.
//
// It is refused, with no record left behind, when the CLI cannot take an
// update now: another Pockode on the machine is updating it (ErrUpdatingElsewhere),
// or the Gate refuses — a sign-in to it is running.
//
// The update belongs to the server, not to the request or the connection that
// started it: it goes on through a reload or a dropped socket, and
// cli_update.subscribe finds it again. It cannot be cancelled: killing a
// package manager halfway through replacing the CLI's files is more likely to
// leave a broken install than to leave the old one.
func (s *Service) StartUpdate(agentType session.AgentType) (Update, error) {
	cli, ok := s.clis[agentType]
	if !ok {
		return Update{}, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	update, started, err := s.startUpdate(agentType, cli)
	if err != nil || !started {
		return update, err
	}
	s.log.Info("AI CLI update started", "cli", agentType, "updateId", update.ID, "binary", update.BinaryPath)
	s.notify(agentType)
	return update, nil
}

// startUpdate is StartUpdate under updatesMu. started is false when the update
// returned is one already running.
func (s *Service) startUpdate(agentType session.AgentType, cli CLI) (update Update, started bool, err error) {
	s.updatesMu.Lock()
	defer s.updatesMu.Unlock()
	if s.closed {
		return Update{}, false, ErrShuttingDown
	}
	if u := s.runningUpdate(agentType); u != nil {
		return *u, false, nil
	}
	if s.updateDir == "" {
		return Update{}, false, fmt.Errorf("no home directory to run the update in: %w", s.updateDirErr)
	}

	unlockMachine, err := s.lockMachine(agentType)
	if err != nil {
		return Update{}, false, err
	}
	u := &Update{
		ID:        uuid.NewString(),
		Agent:     agentType,
		Phase:     PhaseRunning,
		StartedAt: time.Now(),
	}
	wait, endGate := func(context.Context) error { return nil }, func() {}
	if s.gate != nil {
		wait, endGate, err = s.gate.BeginUpdate(agentType, u.ID)
		if err != nil {
			unlockMachine()
			return Update{}, false, err
		}
	}
	// A path that cannot be resolved is left out: the update fails as not
	// installed, which says so.
	u.BinaryPath, _ = agent.BinaryPath(cli.Binary)
	s.revision++
	u.Revision = s.revision
	s.updates[agentType] = u
	update = *u
	ctx, cancel := context.WithTimeout(s.baseCtx, s.updateTimeout)
	// Under updatesMu, which Close takes before waiting: an update that got
	// past the closed check is always one Close waits for.
	s.updateWG.Go(func() {
		defer cancel()
		to, failure := s.runUpdate(ctx, u, cli, wait)
		// Released before the end is recorded: a client that hears the update
		// ended and reads the sign-in status, or starts another, finds the CLI
		// free.
		endGate()
		unlockMachine()
		s.end(u, to, failure)
	})
	return update, true, nil
}

// lockMachine takes agentType's machine-wide update lock, which is refused at
// once — not waited for — when another Pockode holds it.
func (s *Service) lockMachine(agentType session.AgentType) (unlock func(), err error) {
	if s.lockDir == "" {
		return nil, fmt.Errorf("no directory for the machine-wide update lock: %w", s.lockDirErr)
	}
	if err := os.MkdirAll(s.lockDir, 0o700); err != nil {
		return nil, fmt.Errorf("create the directory for the machine-wide update lock: %w", err)
	}
	unlock, err = filestore.TryLock(filepath.Join(s.lockDir, "cli-update-"+string(agentType)+".lock"))
	if errors.Is(err, filestore.ErrLocked) {
		return nil, fmt.Errorf("%s %w", agentType, ErrUpdatingElsewhere)
	}
	return unlock, err
}

// runUpdate runs u's command once the gate lets it, and returns what it
// left: the version afterwards, when read, and the failure unless it succeeded.
func (s *Service) runUpdate(ctx context.Context, u *Update, cli CLI, wait func(context.Context) error) (to string, failure *Failure) {
	agentType := u.Agent

	// A status read or a sign-out already running finishes first, and so does
	// a check: each may be running the CLI. A check is bounded by its own
	// --version budget, so this needs no ctx.
	if err := wait(ctx); err != nil {
		return "", s.contextFailure(ctx)
	}
	s.checking[agentType].Wait()

	// The latest release is only what the result is judged against, so failing
	// to read it does not stop the update; the CLI's word is taken instead.
	var from, target string
	var fromErr, targetErr error
	var reads sync.WaitGroup
	reads.Go(func() { from, fromErr = agent.Version(ctx, s.log, cli.Binary) })
	reads.Go(func() { target, targetErr = s.registry.latest(ctx, cli.Package, cli.channel()) })
	reads.Wait()
	if targetErr != nil && ctx.Err() == nil {
		s.log.Warn("could not read latest AI CLI release before updating", "cli", agentType, "error", targetErr)
	}
	s.updateRecord(u, func(u *Update) {
		u.FromVersion = from
		u.TargetVersion = target
	})

	to, failure = s.update(ctx, cli, from, target, fromErr)
	// What an update cut short left behind is the first thing to know, however
	// far it got — unless the server is going away, which cannot wait for it.
	if failure != nil && failure.Reason == FailureTimeout {
		to, _ = agent.Version(s.baseCtx, s.log, cli.Binary)
	}
	if failure != nil && failure.Reason == FailureNotApplied && to == from {
		s.updatesMu.Lock()
		s.notApplied[agentType] = notApplied{release: release{latest: target, installed: to}, at: time.Now()}
		s.updatesMu.Unlock()
	}
	return to, failure
}

// end records how u ended: with to, the version read afterwards when there is
// one, and failure unless it succeeded.
func (s *Service) end(u *Update, to string, failure *Failure) {
	s.updateRecord(u, func(u *Update) {
		now := time.Now()
		u.EndedAt = &now
		u.ToVersion = to
		if failure != nil {
			u.Phase = PhaseFailed
			failure.Detail = redact(failure.Detail)
			u.Failure = failure
			return
		}
		u.Phase = PhaseSucceeded
	})

	if failure != nil {
		s.log.Warn("AI CLI update failed", "cli", u.Agent, "updateId", u.ID, "reason", failure.Reason, "detail", failure.Detail)
		return
	}
	s.log.Info("AI CLI update ended", "cli", u.Agent, "updateId", u.ID, "from", u.FromVersion, "to", to)
}

// update runs the CLI's update command and reads what it left behind: the
// version afterwards, whenever it could be read, and the failure unless it
// succeeded. from and fromErr are the version read before; target is the
// latest release, or empty when it could not be read.
func (s *Service) update(ctx context.Context, cli CLI, from, target string, fromErr error) (to string, failure *Failure) {
	var notFound *agent.BinaryNotFoundError
	if errors.As(fromErr, &notFound) {
		return "", &Failure{Reason: FailureNotInstalled, Detail: fromErr.Error()}
	}
	if ctx.Err() != nil {
		return "", s.contextFailure(ctx)
	}

	if err := s.checkUpdateCommand(ctx, cli); err != nil {
		if ctx.Err() != nil {
			return "", s.contextFailure(ctx)
		}
		return "", &Failure{Reason: FailureOther, Detail: err.Error()}
	}

	res, err := agent.Run(ctx, s.log, cli.Binary, s.updateDir, "update")
	switch {
	case ctx.Err() != nil:
		return "", s.contextFailure(ctx)
	case errors.As(err, &notFound):
		return "", &Failure{Reason: FailureNotInstalled, Detail: err.Error()}
	case err != nil:
		return "", &Failure{Reason: FailureOther, Detail: err.Error()}
	}

	// The update has run to its end, so reading what it left is not bounded
	// by what remains of its budget.
	to, toErr := agent.Version(s.baseCtx, s.log, cli.Binary)
	if res.ExitCode != 0 {
		detail := fmt.Sprintf("`%s update` exited with status %d", cli.Binary, res.ExitCode)
		if tail := commandOutput(res); tail != "" {
			detail += ":\n" + tail
		}
		return to, &Failure{Reason: FailureCommandFailed, Detail: detail}
	}
	if toErr != nil {
		return "", &Failure{Reason: FailureOther, Detail: fmt.Sprintf("`%s update` finished, but the version afterwards could not be read: %v", cli.Binary, toErr)}
	}
	if target != "" {
		cmp, err := agent.CompareVersions(target, to)
		if err != nil {
			return to, &Failure{Reason: FailureOther, Detail: fmt.Sprintf("`%s update` finished, but its result could not be judged: %v", cli.Binary, err)}
		}
		if cmp > 0 {
			detail := fmt.Sprintf("`%s update` said it finished, but the %s this server runs is still %s and the latest release is %s.", cli.Binary, cli.Binary, to, target)
			if tail := commandOutput(res); tail != "" {
				detail += "\n" + tail
			}
			return to, &Failure{Reason: FailureNotApplied, Detail: detail}
		}
	}
	return to, nil
}

// updateUsage is the first line `<cli> update --help` prints when the CLI has
// the command: "Usage: claude update|upgrade [options]", "Usage: codex update
// [OPTIONS]".
var updateUsage = regexp.MustCompile(`(?m)^Usage: \S+ update\b`)

// probeTimeout bounds `<cli> update --help`, which prints a constant.
const probeTimeout = 10 * time.Second

// checkUpdateCommand makes sure the CLI has an `update` command before it is
// run. One without it takes `update` for a prompt — Codex's argument parser
// does — and could start a turn instead of an update.
func (s *Service) checkUpdateCommand(ctx context.Context, cli CLI) error {
	timedOut := fmt.Errorf("`%s update --help` did not finish in time (limit %s)", cli.Binary, probeTimeout)
	ctx, cancel := context.WithTimeoutCause(ctx, probeTimeout, timedOut)
	defer cancel()
	res, err := agent.Run(ctx, s.log, cli.Binary, s.updateDir, "update", "--help")
	// The update's own deadline may be the one that ran out; the caller reports
	// that one.
	if err != nil && errors.Is(context.Cause(ctx), timedOut) {
		return fmt.Errorf("could not check that %s has an update command: %w", cli.Binary, timedOut)
	}
	if err != nil {
		return fmt.Errorf("could not check that %s has an update command: %w", cli.Binary, err)
	}
	if res.ExitCode != 0 {
		err := fmt.Errorf("could not check that %s has an update command: `%s update --help` exited with status %d", cli.Binary, cli.Binary, res.ExitCode)
		if tail := commandOutput(res); tail != "" {
			err = fmt.Errorf("%w:\n%s", err, tail)
		}
		return err
	}
	if !updateUsage.MatchString(res.Stdout) {
		return fmt.Errorf("this version of %s has no `update` command; update it from a terminal the way it was installed", cli.Binary)
	}
	return nil
}

// contextFailure is the failure of an update whose context ended: its budget
// ran out, or the server is shutting down.
func (s *Service) contextFailure(ctx context.Context) *Failure {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &Failure{Reason: FailureTimeout, Detail: fmt.Sprintf("the update did not finish in time (limit %s)", s.updateTimeout)}
	}
	if errors.Is(context.Cause(ctx), ErrShuttingDown) {
		return &Failure{Reason: FailureOther, Detail: "the server shut down while the update was running; check the CLI's version before relying on it"}
	}
	return &Failure{Reason: FailureOther, Detail: ctx.Err().Error()}
}

// How much of a failing update's output is kept. npm's error block, the
// longest seen, names its reason within its last dozen lines, on stderr; the
// stdout lines before it say what the CLI was doing (Claude prints its warning
// about an unwritable npm prefix there).
const (
	stderrTailLines = 20
	stdoutTailLines = 10
)

// maxOutputTail caps the kept output in bytes, whatever its line count.
const maxOutputTail = 4 << 10

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

// secretPatterns match the credentials an update's output can carry: npm
// prints its registry URL, which may hold user info, and echoes .npmrc lines
// and request headers — as text, as JSON, or as Node's inspected objects —
// when it fails verbosely.
var secretPatterns = []struct {
	pattern *regexp.Regexp
	replace string
}{
	// user:password@ in any URL, up to the last @ before the host: a password
	// may hold one.
	{regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)[^\s/]*@`), "${1}[redacted]@"},
	// .npmrc's _authToken, _auth and _password, quoted or not.
	{regexp.MustCompile(`(?i)(_(?:authToken|auth|password)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)`), "${1}[redacted]"},
	// An Authorization header, its scheme included, in any of those forms.
	{regexp.MustCompile(`(?i)(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s"',]+`), "${1}[redacted]"},
	// npm and GitHub tokens standing on their own.
	{regexp.MustCompile(`\b(?:npm_[A-Za-z0-9]{36}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]+)\b`), "[redacted]"},
}

// redact removes credentials from what an update printed before it is kept:
// the detail goes to every client and into the log.
func redact(s string) string {
	for _, p := range secretPatterns {
		s = p.pattern.ReplaceAllString(s, p.replace)
	}
	return s
}

// commandOutput is what a failing update command printed, for its failure's
// detail: the end of stdout, then the end of stderr, which is where both CLIs
// say why.
func commandOutput(res agent.RunResult) string {
	var parts []string
	for _, tail := range []string{outputTail(res.Stdout, stdoutTailLines), outputTail(res.Stderr, stderrTailLines)} {
		if tail != "" {
			parts = append(parts, tail)
		}
	}
	return strings.Join(parts, "\n")
}

// outputTail is the last n non-blank lines of out, without terminal escapes
// and credentials, and at most maxOutputTail bytes. Credentials are removed
// before anything is cut, so that none is cut into a shape redact no longer
// recognizes; the cut then drops whole lines from the front.
func outputTail(out string, n int) string {
	var lines []string
	for line := range strings.SplitSeq(redact(ansiEscape.ReplaceAllString(out, "")), "\n") {
		if line = strings.TrimRight(line, " \t\r"); strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	lines = lines[max(0, len(lines)-n):]
	size := len(lines) - 1
	for _, line := range lines {
		size += len(line)
	}
	for len(lines) > 1 && size > maxOutputTail {
		size -= len(lines[0]) + 1
		lines = lines[1:]
	}
	tail := strings.Join(lines, "\n")
	if len(tail) > maxOutputTail {
		// One line longer than the cap: keep its end, on a rune boundary.
		cut := len(tail) - maxOutputTail
		for cut < len(tail) && !utf8.RuneStart(tail[cut]) {
			cut++
		}
		tail = "…" + tail[cut:]
	}
	return tail
}

// Update is agentType's latest update — the running one, or the last to end —
// or nil when it has had none since the server started. The last one is kept
// so that a client that was away when it ended still learns how.
func (s *Service) Update(agentType session.AgentType) (*Update, error) {
	if _, ok := s.clis[agentType]; !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	s.updatesMu.Lock()
	defer s.updatesMu.Unlock()
	u := s.updates[agentType]
	if u == nil {
		return nil, nil
	}
	update := *u
	return &update, nil
}

// Dismiss drops the update with id, which has ended, so that no client shows
// it any more: its CLI's latest update is then none. A running update cannot
// be dismissed.
func (s *Service) Dismiss(id string) error {
	s.updatesMu.Lock()
	var agentType session.AgentType
	for t, u := range s.updates {
		if u.ID == id {
			agentType = t
		}
	}
	switch u := s.updates[agentType]; {
	case agentType == "":
		s.updatesMu.Unlock()
		return ErrUpdateNotFound
	case u.Phase == PhaseRunning:
		s.updatesMu.Unlock()
		return ErrUpdateRunning
	}
	delete(s.updates, agentType)
	s.updatesMu.Unlock()

	s.notify(agentType)
	return nil
}

// Close ends every running update and waits for its CLI's process tree to be
// gone.
func (s *Service) Close() {
	s.updatesMu.Lock()
	s.closed = true
	s.updatesMu.Unlock()
	s.cancelBase(ErrShuttingDown)
	s.updateWG.Wait()
}

// runningUpdate is agentType's update if one is running. Callers hold
// updatesMu.
func (s *Service) runningUpdate(agentType session.AgentType) *Update {
	if u := s.updates[agentType]; u != nil && u.Phase == PhaseRunning {
		return u
	}
	return nil
}

func (s *Service) updateRecord(u *Update, change func(*Update)) {
	s.updatesMu.Lock()
	change(u)
	s.revision++
	u.Revision = s.revision
	agentType := u.Agent
	s.updatesMu.Unlock()
	s.notify(agentType)
}

func (s *Service) notify(agentType session.AgentType) {
	for _, l := range s.listeners {
		l.OnUpdateChange(agentType)
	}
}
