package cliupdate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// Installer is a CLI's official install script, one for each platform family;
// the one for the platform the server runs on is the one that runs.
type Installer struct {
	Unix, Windows Script
}

// Script is one official install script and how to run it unattended.
type Script struct {
	// URL is where the script is downloaded from. It is the CLI package's
	// constant, never anything a client or a project can set: what it serves
	// runs as the server's user.
	URL string
	// Shell is the command line the script runs under, its path appended.
	Shell []string
	// Args, when set, are the script's arguments for the CLI's release
	// channel.
	Args func(channel string) []string
	// Env ("KEY=value") is added to the script's environment: what keeps it
	// from asking anything.
	Env []string
	// Downloaders are the commands the script downloads the CLI with, at
	// least one of which has to be on PATH; empty is a script that needs none.
	Downloaders []string
}

// PowerShell runs a .ps1 script as a file: without the user's profile, the
// execution policy (which refuses an unsigned downloaded script) or prompts.
// It is Windows PowerShell 5.1, the one every supported Windows has.
var PowerShell = []string{"powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"}

// CurlOrWget is what the official Unix install scripts download with.
var CurlOrWget = []string{"curl", "wget"}

// maxScriptSize caps what is read of an install script. The largest today,
// Codex's install.ps1, is about 70 KiB.
const maxScriptSize = 1 << 20

// scriptClient downloads install scripts. Redirects are followed — every
// script URL today redirects to its CLI's download host — but never off
// HTTPS: what is downloaded runs as the server's user.
var scriptClient = &http.Client{CheckRedirect: checkScriptRedirect}

func checkScriptRedirect(req *http.Request, via []*http.Request) error {
	if via[0].URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("refusing to follow a redirect off HTTPS, to %s", req.URL.Redacted())
	}
	// The default client's own limit.
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	return nil
}

// utf8BOM marks a .ps1 file as UTF-8: Windows PowerShell 5.1 reads a script
// without one in the ANSI code page, which garbles any non-ASCII character
// and can turn one into a quote that ends a string early.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// StartInstall installs agentType, a CLI this server cannot find, or returns
// the install already running for it. The install is an Update of KindInstall:
// it is followed, dismissed and ended exactly as an update is.
//
// It runs the CLI's official install script (CLI.Installer): it needs no
// Node.js, installs into the user's own directory, and leaves the CLI updating
// itself the native way. It runs where updates run (see NewService), as the
// server's own user, with stdin closed.
//
// It is refused, with no record left behind, when the CLI is found already
// (ErrAlreadyInstalled), what the script needs to run is not
// (ErrInstallerToolNotFound), or the CLI is busy (ErrBusy): being updated,
// being updated or installed by another Pockode on the machine, or signed in
// to.
func (s *Service) StartInstall(agentType session.AgentType) (Update, error) {
	cli, ok := s.clis[agentType]
	if !ok {
		return Update{}, fmt.Errorf("%w: %q", ErrUnknownAgent, agentType)
	}
	script := cli.Installer.script()
	precheck := func() error {
		if path, err := agent.BinaryPath(cli.Binary); err == nil {
			return fmt.Errorf("%s %w at %s", agentType, ErrAlreadyInstalled, path)
		}
		return script.precheck(agentType)
	}
	return s.start(agentType, KindInstall, precheck,
		func(ctx context.Context, u *Update, wait func(context.Context) error) (string, *Failure) {
			return s.runInstall(ctx, u, cli, script, wait)
		})
}

// precheck refuses an install whose script could not even start: the shell it
// runs under, or every downloader it can use, is missing.
func (sc Script) precheck(agentType session.AgentType) error {
	if sc.URL == "" || len(sc.Shell) == 0 {
		return fmt.Errorf("%s has no official installer for this platform", agentType)
	}
	const fix = "on the PATH of the process running pockode; install it, then restart pockode"
	if _, err := agent.BinaryPath(sc.Shell[0]); err != nil {
		return fmt.Errorf("%w: %s's official installer (%s) runs with %s, which is not %s", ErrInstallerToolNotFound, agentType, sc.URL, sc.Shell[0], fix)
	}
	if len(sc.Downloaders) == 0 {
		return nil
	}
	for _, d := range sc.Downloaders {
		if _, err := agent.BinaryPath(d); err == nil {
			return nil
		}
	}
	return fmt.Errorf("%w: %s's official installer (%s) downloads with %s, and neither is %s", ErrInstallerToolNotFound, agentType, sc.URL, strings.Join(sc.Downloaders, " or "), fix)
}

// runInstall is runUpdate for an install: it runs the script once the gate
// lets it, and returns the version installed and the failure unless it
// succeeded.
func (s *Service) runInstall(ctx context.Context, u *Update, cli CLI, script Script, wait func(context.Context) error) (to string, failure *Failure) {
	if err := wait(ctx); err != nil {
		return "", s.contextFailure(ctx, KindInstall)
	}
	s.checking[u.Agent].Wait()

	// The script resolves the channel itself; the release read here is only
	// what the client shows while it runs.
	channel := cli.channel()
	target, err := s.registry.latest(ctx, cli.Package, channel)
	if err != nil && ctx.Err() == nil {
		s.log.Warn("could not read latest AI CLI release before installing", "cli", u.Agent, "error", err)
	}
	s.updateRecord(u, func(u *Update) { u.TargetVersion = target })

	to, failure = s.install(ctx, cli, script, channel)
	if failure != nil && failure.Reason == FailureTimeout {
		to, _ = agent.Version(s.baseCtx, s.log, cli.Binary)
	}
	return to, failure
}

// install downloads the script, runs it and finds the CLI it installed.
//
// The script is downloaded here and run as a file, not piped into its shell as
// the CLIs' instructions do: a download failing halfway through a pipe hands
// the shell a truncated script, or none, which it runs without complaint; and
// a piped script's commands read the rest of the script as their stdin.
func (s *Service) install(ctx context.Context, cli CLI, script Script, channel string) (to string, failure *Failure) {
	name := "the official installer (" + script.URL + ")"
	dir, err := os.MkdirTemp("", "pockode-install-")
	if err != nil {
		return "", &Failure{Reason: FailureOther, Detail: fmt.Sprintf("could not make a directory to download %s into: %v", name, err)}
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil {
			s.log.Warn("could not remove downloaded install script", "dir", dir, "error", err)
		}
	}()

	file, err := downloadScript(ctx, script.URL, dir)
	switch {
	case ctx.Err() != nil:
		return "", s.contextFailure(ctx, KindInstall)
	case err != nil:
		return "", &Failure{Reason: FailureDownloadFailed, Detail: fmt.Sprintf("could not download %s: %v", name, err)}
	}

	args := slices.Concat(script.Shell[1:], []string{file})
	if script.Args != nil {
		args = append(args, script.Args(channel)...)
	}
	res, err := agent.RunEnv(ctx, s.log, script.Shell[0], s.updateDir, script.Env, args...)
	switch {
	case ctx.Err() != nil:
		return "", s.contextFailure(ctx, KindInstall)
	case err != nil:
		return "", &Failure{Reason: FailureOther, Detail: fmt.Sprintf("could not run %s: %v", name, err)}
	}
	if res.ExitCode != 0 {
		detail := fmt.Sprintf("%s exited with status %d", name, res.ExitCode)
		if tail := commandOutput(res); tail != "" {
			detail += ":\n" + tail
		}
		return "", &Failure{Reason: FailureCommandFailed, Detail: detail}
	}

	// The script has finished, so finding what it installed is not bounded by
	// what remains of its budget. Nothing caches where a CLI is: this lookup,
	// and every check and session after it, searches afresh — PATH, then the
	// directory the official installer uses.
	to, err = agent.Version(s.baseCtx, s.log, cli.Binary)
	var notFound *agent.BinaryNotFoundError
	switch {
	case errors.As(err, &notFound):
		detail := fmt.Sprintf("%s finished, but %s is still not found. %v", name, cli.Binary, err)
		if tail := commandOutput(res); tail != "" {
			detail += "\nThe end of what the installer printed, which may say where it put " + cli.Binary + ":\n" + tail
		}
		return "", &Failure{Reason: FailureNotOnPath, Detail: detail}
	case err != nil:
		return "", &Failure{Reason: FailureOther, Detail: fmt.Sprintf("%s finished, but the version of %s could not be read: %v", name, cli.Binary, err)}
	}
	return to, nil
}

// downloadScript saves the script at src into dir, under the name its URL
// ends in: PowerShell runs a file with -File only when it ends in .ps1.
func downloadScript(ctx context.Context, src, dir string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return "", err
	}
	resp, err := scriptClient.Do(req)
	if err != nil {
		// A *url.Error repeats the URL the caller's detail already names.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			return "", urlErr.Err
		}
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errors.New(resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxScriptSize+1))
	if err != nil {
		return "", err
	}
	if len(body) > maxScriptSize {
		return "", fmt.Errorf("the script is larger than %d bytes", maxScriptSize)
	}
	ext := path.Ext(req.URL.Path)
	if strings.EqualFold(ext, ".ps1") && !bytes.HasPrefix(body, utf8BOM) {
		body = append(slices.Clip(utf8BOM), body...)
	}
	file := filepath.Join(dir, "install"+ext)
	// A plain write: the file lives only as long as this install, in a
	// directory MkdirTemp made for it alone.
	if err := os.WriteFile(file, body, 0o600); err != nil {
		return "", err
	}
	return file, nil
}
