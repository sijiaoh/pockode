package cliupdate

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// StartInstall installs agentType, a CLI this server cannot find, or returns
// the install already running for it. The install is an Update of KindInstall:
// it is followed, dismissed and ended exactly as an update is.
//
// It installs from npm, `npm install --global <package>@<channel>`, whichever
// way the CLI is usually installed: both CLIs publish every release there, npm
// is the one installer both share, and the install then updates itself the npm
// way. It runs where updates run (see NewService), as the server's own user.
//
// It is refused, with no record left behind, when the CLI is found already
// (ErrAlreadyInstalled), npm is not (ErrInstallerNotFound), or the CLI is busy
// (ErrBusy): being updated, being updated or installed by another Pockode on
// the machine, or signed in to.
func (s *Service) StartInstall(agentType session.AgentType) (Update, error) {
	cli, ok := s.clis[agentType]
	if !ok {
		return Update{}, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	precheck := func() error {
		if path, err := agent.BinaryPath(cli.Binary); err == nil {
			return fmt.Errorf("%s %w at %s", agentType, ErrAlreadyInstalled, path)
		}
		if _, err := agent.BinaryPath(s.installer); err != nil {
			return fmt.Errorf("%w: installing %s needs npm on the PATH of the process running pockode; install Node.js, which includes npm, then restart pockode", ErrInstallerNotFound, agentType)
		}
		return nil
	}
	return s.start(agentType, KindInstall, precheck,
		func(ctx context.Context, u *Update, wait func(context.Context) error) (string, *Failure) {
			return s.runInstall(ctx, u, cli, wait)
		})
}

// runInstall is runUpdate for an install: it runs npm once the gate lets it,
// and returns the version installed and the failure unless it succeeded.
func (s *Service) runInstall(ctx context.Context, u *Update, cli CLI, wait func(context.Context) error) (to string, failure *Failure) {
	if err := wait(ctx); err != nil {
		return "", s.contextFailure(ctx, KindInstall)
	}
	s.checking[u.Agent].Wait()

	// npm resolves the channel itself; the release read here is only what the
	// client shows while it runs.
	channel := cli.channel()
	target, err := s.registry.latest(ctx, cli.Package, channel)
	if err != nil && ctx.Err() == nil {
		s.log.Warn("could not read latest AI CLI release before installing", "cli", u.Agent, "error", err)
	}
	s.updateRecord(u, func(u *Update) { u.TargetVersion = target })

	to, failure = s.install(ctx, cli, channel)
	if failure != nil && failure.Reason == FailureTimeout {
		to, _ = agent.Version(s.baseCtx, s.log, cli.Binary)
	}
	return to, failure
}

// npmPermissionDenied is the code npm's error block names when it cannot write
// its global prefix: EACCES on Linux and macOS, EPERM on Windows. npm 7–9 print
// "npm ERR! code EACCES", npm 10 "npm error code EACCES".
var npmPermissionDenied = regexp.MustCompile(`(?m)\bcode (?:EACCES|EPERM)\b`)

// install runs npm and finds the CLI it installed.
func (s *Service) install(ctx context.Context, cli CLI, channel string) (to string, failure *Failure) {
	args := []string{"install", "--global", "--no-fund", "--no-audit", cli.Package + "@" + channel}
	command := "`npm " + strings.Join(args, " ") + "`"
	res, err := agent.Run(ctx, s.log, s.installer, s.updateDir, args...)
	switch {
	case ctx.Err() != nil:
		return "", s.contextFailure(ctx, KindInstall)
	case err != nil:
		return "", &Failure{Reason: FailureOther, Detail: fmt.Sprintf("could not run %s: %v", command, err)}
	}
	if res.ExitCode != 0 {
		reason := FailureCommandFailed
		if npmPermissionDenied.MatchString(res.Stdout + "\n" + res.Stderr) {
			reason = FailurePermissionDenied
		}
		detail := fmt.Sprintf("%s exited with status %d", command, res.ExitCode)
		if tail := commandOutput(res); tail != "" {
			detail += ":\n" + tail
		}
		return "", &Failure{Reason: reason, Detail: detail}
	}

	// npm has finished, so finding what it installed is not bounded by what
	// remains of its budget. Nothing caches where a CLI is: this lookup, and
	// every check and session after it, searches the PATH afresh.
	to, err = agent.Version(s.baseCtx, s.log, cli.Binary)
	var notFound *agent.BinaryNotFoundError
	switch {
	case errors.As(err, &notFound):
		return "", &Failure{Reason: FailureNotOnPath, Detail: s.notOnPathDetail(cli, command, err)}
	case err != nil:
		return "", &Failure{Reason: FailureOther, Detail: fmt.Sprintf("%s finished, but the version of %s could not be read: %v", command, cli.Binary, err)}
	}
	return to, nil
}

// notOnPathDetail explains an install npm finished that the server still
// cannot find, naming where npm put it when npm says.
func (s *Service) notOnPathDetail(cli CLI, command string, notFound error) string {
	detail := fmt.Sprintf("%s finished, but %s is still not found.", command, cli.Binary)
	ctx, cancel := context.WithTimeout(s.baseCtx, probeTimeout)
	defer cancel()
	res, err := agent.Run(ctx, s.log, s.installer, s.updateDir, "prefix", "--global")
	if err == nil && res.ExitCode == 0 {
		if prefix := strings.TrimSpace(res.Stdout); prefix != "" {
			detail += fmt.Sprintf(" npm's global prefix is %s, and the directory npm puts commands in (its bin directory, or the prefix itself on Windows) is not on this server's PATH.", prefix)
		}
	}
	return detail + " " + notFound.Error()
}
