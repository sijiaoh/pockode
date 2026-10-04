// Package cliupdate tells whether each AI CLI has a newer release and updates
// it.
//
// The update itself is the CLI's own `update` command. Both CLIs know how they
// were installed — Claude Code's native build, npm, Homebrew; Codex's npm, bun,
// Homebrew — and how to update each, so Pockode does not second-guess that.
// What it adds is the check the command's exit status cannot give: the version
// Pockode runs is read again afterwards, so an update that went somewhere else
// is reported rather than taken on the CLI's word. See docs/code/cli-update.md.
package cliupdate

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// CLI is what the Service needs to know about one CLI to update it.
type CLI struct {
	// Binary is the executable the CLI is run as.
	Binary string
	// Package is the npm package the CLI is published as. Both CLIs publish
	// every release there, whichever way they are installed, with the same
	// version numbers, so its dist-tags are where the latest release is read.
	Package string
	// Channel returns the dist-tag the CLI's own update command installs from;
	// nil is "latest".
	Channel func() string
}

func (c CLI) channel() string {
	if c.Channel == nil {
		return "latest"
	}
	return c.Channel()
}

// Gate keeps an update and the CLI's other commands apart; cliauth.Service is
// the one. BeginUpdate refuses an update the CLI cannot take now (a sign-in is
// running), and otherwise holds the CLI's other commands off until end: wait
// is for those already running, and the update runs the CLI only after it.
type Gate interface {
	BeginUpdate(agentType session.AgentType, updateID string) (wait func(context.Context) error, end func(), err error)
}

// SessionCounter says how many of this server's sessions have a process of a
// CLI running. They keep the version they started with: an update reaches only
// the processes started after it.
type SessionCounter interface {
	AgentProcessCount(agentType session.AgentType) int
}

// State is where a CLI stands, as far as updating it goes.
type State string

const (
	StateUpToDate        State = "up_to_date"
	StateUpdateAvailable State = "update_available"
	// StateNotYetAvailable is a newer release the CLI's last update did not
	// install: it ended FailureNotApplied with the version unmoved less than
	// NotAppliedFor ago, and the installed and the latest version are both
	// still what they were then. Either the way the CLI is installed does not
	// have the release yet (Homebrew lags npm), or the update went to another
	// install on the machine; Pockode cannot tell which. Offering the update
	// again at once would fail the same way.
	StateNotYetAvailable State = "not_yet_available"
	// StateUpdating is a CLI with an update running; UpdateID names it. The
	// versions are not read meanwhile: the files are being replaced.
	StateUpdating     State = "updating"
	StateNotInstalled State = "not_installed"
	// StateUnavailable is a check that could not tell: the installed or the
	// latest version could not be read. Error says which, and whichever could
	// be read is still set.
	StateUnavailable State = "unavailable"
)

// Check is one CLI's answer to "is there a newer release".
type Check struct {
	Agent session.AgentType `json:"agent"`
	State State             `json:"state"`
	// Version is the version Pockode runs, when it could be read.
	Version string `json:"version,omitempty"`
	// LatestVersion is what Channel points at, when it could be read.
	LatestVersion string `json:"latest_version,omitempty"`
	// Channel is the release channel LatestVersion was read from, the one the
	// CLI's own update installs from.
	Channel string `json:"channel"`
	// Error is why, with StateUnavailable and StateNotInstalled.
	Error string `json:"error,omitempty"`
	// UpdateID is the running update, with StateUpdating.
	UpdateID string `json:"update_id,omitempty"`
	// RunningSessions is how many of this server's sessions have a process of
	// this CLI running right now. They go on with the version they started
	// with; only processes started after an update use the new one.
	RunningSessions int `json:"running_sessions"`
}

// ErrUnknownAgent is a request naming a CLI no one registered.
var ErrUnknownAgent = errors.New("unknown agent")

// Errors from the update commands.
var (
	// ErrShuttingDown is an update asked for after the server began shutting
	// down.
	ErrShuttingDown = errors.New("the server is shutting down")
	// ErrUpdatingElsewhere is an update refused because another Pockode on
	// this machine is updating the same CLI.
	ErrUpdatingElsewhere = errors.New("is being updated by another Pockode on this machine")
	ErrUpdateNotFound    = errors.New("no such update; it may have been replaced by a newer one")
	ErrUpdateRunning     = errors.New("the update is still running")
)

// Service checks and updates every registered CLI.
type Service struct {
	log      *slog.Logger
	agents   []session.AgentType // registration order, which is display order
	clis     map[session.AgentType]CLI
	registry registryClient
	sessions SessionCounter
	gate     Gate
	// updateDir is where the update commands run; see NewService. Empty when
	// the user has no home directory, which refuses every update.
	updateDir    string
	updateDirErr error
	// lockDir holds the machine-wide update locks, one file per CLI: every
	// Pockode of the OS user — other projects, other cluster nodes — updates
	// the same install, and two package managers replacing one directory at
	// once can leave neither version whole. Empty when there is no such
	// directory, which refuses every update.
	lockDir    string
	lockDirErr error

	// updatesMu guards updates, revision, notApplied, closed and every Update's
	// contents.
	updatesMu sync.Mutex
	// updates is each CLI's latest update, running or ended.
	updates  map[session.AgentType]*Update
	revision int64
	// notApplied is, per CLI, the release its last update did not install, the
	// version it stayed at, and when; see StateNotYetAvailable. It outlives the
	// update's record, which the user can dismiss.
	notApplied map[session.AgentType]notApplied
	// checking counts, per CLI, the checks running its --version. It is added
	// to only under updatesMu while no update runs, so an update that has
	// begun can wait for it to drain: the CLI must not be replaced under a
	// --version. Created by Register.
	checking map[session.AgentType]*sync.WaitGroup
	// notAppliedFor is NotAppliedFor everywhere but in tests.
	notAppliedFor time.Duration
	listeners     []Listener
	closed        bool
	// baseCtx ends every update; Close cancels it.
	baseCtx    context.Context
	cancelBase context.CancelCauseFunc
	updateWG   sync.WaitGroup
	// updateTimeout is UpdateTimeout everywhere but in tests.
	updateTimeout time.Duration
}

type release struct {
	latest, installed string
}

type notApplied struct {
	release
	at time.Time
}

// NotAppliedFor is how long an update that did not install the latest release
// keeps it from being offered again. Nothing tells Pockode when the lagging
// package manager catches up, and an update that went to a second install
// never will, so the button has to come back on its own: a few hours covers
// Homebrew's usual lag without the card offering, every time it is opened, an
// update that just failed.
const NotAppliedFor = 6 * time.Hour

// NewService builds a Service reading the latest releases from NPMRegistry.
// sessions and gate may be nil, which count no sessions and keep nothing
// apart.
//
// The update commands run in the user's home directory, not the project's: a
// global install is the user's, and a project's .npmrc must not be able to
// point it at another prefix or registry.
func NewService(log *slog.Logger, sessions SessionCounter, gate Gate) *Service {
	baseCtx, cancelBase := context.WithCancelCause(context.Background())
	home, homeErr := os.UserHomeDir()
	// The user's cache directory: the locks are per OS user, like the installs
	// they guard, and hold nothing worth keeping.
	var lockDir string
	cacheDir, lockDirErr := os.UserCacheDir()
	if lockDirErr == nil {
		lockDir = filepath.Join(cacheDir, "pockode")
	}
	return &Service{
		log:           log,
		clis:          make(map[session.AgentType]CLI),
		registry:      registryClient{baseURL: NPMRegistry, http: http.DefaultClient},
		sessions:      sessions,
		gate:          gate,
		updateDir:     home,
		updateDirErr:  homeErr,
		lockDir:       lockDir,
		lockDirErr:    lockDirErr,
		updates:       make(map[session.AgentType]*Update),
		notApplied:    make(map[session.AgentType]notApplied),
		checking:      make(map[session.AgentType]*sync.WaitGroup),
		notAppliedFor: NotAppliedFor,
		baseCtx:       baseCtx,
		cancelBase:    cancelBase,
		updateTimeout: UpdateTimeout,
	}
}

// Register adds a CLI. Checks lists CLIs in the order they were registered.
// Not safe for use once the Service is serving requests.
func (s *Service) Register(agentType session.AgentType, cli CLI) {
	if _, ok := s.clis[agentType]; !ok {
		s.agents = append(s.agents, agentType)
		s.checking[agentType] = &sync.WaitGroup{}
	}
	s.clis[agentType] = cli
}

// Checks reads every registered CLI at once, or only agentType when it is not
// empty. What could not be read is in the list as StateUnavailable or
// StateNotInstalled; the only error is ErrUnknownAgent.
//
// Nothing is cached: the installed version changes under Pockode whenever the
// CLI updates itself or someone updates it in a terminal.
func (s *Service) Checks(ctx context.Context, agentType session.AgentType) ([]Check, error) {
	agents := s.agents
	if agentType != "" {
		if _, ok := s.clis[agentType]; !ok {
			return nil, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
		}
		agents = []session.AgentType{agentType}
	}

	checks := make([]Check, len(agents))
	var wg sync.WaitGroup
	for i, t := range agents {
		wg.Go(func() { checks[i] = s.check(ctx, t) })
	}
	wg.Wait()
	return checks, nil
}

func (s *Service) check(ctx context.Context, agentType session.AgentType) Check {
	cli := s.clis[agentType]
	c := Check{Agent: agentType, Channel: cli.channel(), RunningSessions: s.runningSessions(agentType)}

	s.updatesMu.Lock()
	running := s.runningUpdate(agentType)
	if running == nil {
		s.checking[agentType].Add(1)
	}
	s.updatesMu.Unlock()
	if running != nil {
		c.State = StateUpdating
		c.UpdateID = running.ID
		return c
	}
	var versionErr, latestErr error
	var wg sync.WaitGroup
	wg.Go(func() {
		// Only --version runs the CLI, so a waiting update need not also wait
		// for the registry.
		defer s.checking[agentType].Done()
		c.Version, versionErr = agent.Version(ctx, s.log, cli.Binary)
	})
	wg.Go(func() { c.LatestVersion, latestErr = s.registry.latest(ctx, cli.Package, c.Channel) })
	wg.Wait()

	var notFound *agent.BinaryNotFoundError
	switch {
	case errors.As(versionErr, &notFound):
		c.State = StateNotInstalled
		c.Error = versionErr.Error()
		return c
	case versionErr != nil:
		s.logCheckFailure(ctx, agentType, "could not read AI CLI version", versionErr)
		c.State = StateUnavailable
		c.Error = versionErr.Error()
		return c
	case latestErr != nil:
		s.logCheckFailure(ctx, agentType, "could not read latest AI CLI release", latestErr)
		c.State = StateUnavailable
		c.Error = latestErr.Error()
		return c
	}

	cmp, err := agent.CompareVersions(c.LatestVersion, c.Version)
	if err != nil {
		s.logCheckFailure(ctx, agentType, "could not compare AI CLI versions", err)
		c.State = StateUnavailable
		c.Error = err.Error()
		return c
	}
	// Newer than the channel, as a CLI updated from another channel can be,
	// is up to date too: its own update would not go back.
	switch {
	case cmp <= 0:
		c.State = StateUpToDate
	case s.wasNotApplied(agentType, release{latest: c.LatestVersion, installed: c.Version}):
		c.State = StateNotYetAvailable
	default:
		c.State = StateUpdateAvailable
	}
	return c
}

func (s *Service) wasNotApplied(agentType session.AgentType, r release) bool {
	s.updatesMu.Lock()
	defer s.updatesMu.Unlock()
	n, ok := s.notApplied[agentType]
	return ok && n.release == r && time.Since(n.at) < s.notAppliedFor
}

func (s *Service) runningSessions(agentType session.AgentType) int {
	if s.sessions == nil {
		return 0
	}
	return s.sessions.AgentProcessCount(agentType)
}

// logCheckFailure logs a check that could not be read, unless nobody is waiting
// for it any more: a client that went away is not a failure of the CLI.
func (s *Service) logCheckFailure(ctx context.Context, agentType session.AgentType, msg string, err error) {
	if errors.Is(ctx.Err(), context.Canceled) {
		return
	}
	s.log.Warn(msg, "cli", agentType, "error", err)
}
