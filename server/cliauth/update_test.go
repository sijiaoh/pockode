package cliauth_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/cliauth/cliauthtest"
	"github.com/pockode/server/session"
)

// While a CLI is being updated its files are being replaced, so nothing runs
// it: a status read says so instead, and a sign-in or a sign-out is refused.
func TestBeginUpdate_HoldsTheCLI(t *testing.T) {
	s := newLoginService(t, cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedOut}})

	wait, end, err := s.BeginUpdate(session.AgentTypeClaude, "update-1")
	if err != nil {
		t.Fatalf("BeginUpdate: %v", err)
	}
	if err := wait(context.Background()); err != nil {
		t.Fatalf("wait: %v", err)
	}

	statuses, err := s.Statuses(context.Background(), session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Statuses: %v", err)
	}
	if got := statuses[0]; got.State != cliauth.StateUpdating || got.UpdateID != "update-1" || got.Agent != session.AgentTypeClaude {
		t.Errorf("status during update = %+v, want updating naming update-1", got)
	}
	if _, err := s.StartLogin(session.AgentTypeClaude, ""); !errors.Is(err, cliauth.ErrUpdating) {
		t.Errorf("sign-in during update: got %v, want ErrUpdating", err)
	}
	if _, err := s.Logout(context.Background(), session.AgentTypeClaude); !errors.Is(err, cliauth.ErrUpdating) {
		t.Errorf("sign-out during update: got %v, want ErrUpdating", err)
	}
	if _, _, err := s.BeginUpdate(session.AgentTypeClaude, "update-2"); !errors.Is(err, cliauth.ErrUpdating) {
		t.Errorf("second update: got %v, want ErrUpdating", err)
	}

	end()
	statuses, err = s.Statuses(context.Background(), session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Statuses: %v", err)
	}
	if got := statuses[0]; got.State != cliauth.StateSignedOut {
		t.Errorf("status after update = %+v, want signed out", got)
	}
	if _, err := s.StartLogin(session.AgentTypeClaude, ""); err != nil {
		t.Errorf("sign-in after update: %v", err)
	}
}

// A running sign-in's process is the binary an update would replace.
func TestBeginUpdate_RefusedDuringSignIn(t *testing.T) {
	s := newLoginService(t, cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedOut}})
	startWaiting(t, s)

	if _, _, err := s.BeginUpdate(session.AgentTypeClaude, "update-1"); err == nil || !strings.Contains(err.Error(), "sign-in") {
		t.Errorf("update during sign-in: got %v, want a refusal naming the sign-in", err)
	}
	if _, _, err := s.BeginUpdate("gemini", "update-1"); !errors.Is(err, cliauth.ErrUnknownAgent) {
		t.Errorf("unknown agent: got %v, want ErrUnknownAgent", err)
	}
}

// A status read already running when an update begins finishes before the
// update runs the CLI; one that comes after answers at once.
func TestBeginUpdate_WaitsForARunningRead(t *testing.T) {
	p := blockingProvider{
		Provider: cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}}),
		entered:  make(chan struct{}),
		release:  make(chan struct{}),
	}
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, p)
	t.Cleanup(s.Close)

	go s.Statuses(context.Background(), session.AgentTypeClaude)
	<-p.entered

	wait, end, err := s.BeginUpdate(session.AgentTypeClaude, "update-1")
	if err != nil {
		t.Fatalf("BeginUpdate: %v", err)
	}
	defer end()
	waited := make(chan error, 1)
	go func() { waited <- wait(context.Background()) }()

	statuses, err := s.Statuses(context.Background(), session.AgentTypeClaude)
	if err != nil {
		t.Fatalf("Statuses: %v", err)
	}
	if got := statuses[0]; got.State != cliauth.StateUpdating {
		t.Errorf("read after the update began = %+v, want updating", got)
	}
	select {
	case err := <-waited:
		t.Fatalf("wait returned (%v) while a read was still running", err)
	case <-time.After(50 * time.Millisecond):
	}

	close(p.release)
	select {
	case err := <-waited:
		if err != nil {
			t.Errorf("wait: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("wait did not return once the read finished")
	}
}

// The test binary stands in for a CLI whose `--version` says it has started,
// by creating "started" in the directory fakeVersionGateEnv names, and does
// not answer until "answer" exists there.
const fakeVersionGateEnv = "POCKODE_FAKE_VERSION_GATE"

func TestMain(m *testing.M) {
	if dir := os.Getenv(fakeVersionGateEnv); dir != "" {
		if err := os.WriteFile(filepath.Join(dir, "started"), nil, 0o600); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for {
			if _, err := os.Stat(filepath.Join(dir, "answer")); err == nil {
				fmt.Println("1.2.3 (Fake CLI)")
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	os.Exit(m.Run())
}

// slowVersionProvider is a CLI whose --version is the test binary above.
type slowVersionProvider struct {
	*cliauthtest.Provider
}

func (slowVersionProvider) Binary() string { return os.Args[0] }

// An update replaces the CLI's files, so it must not begin under a --version
// that a status read started: its wait lasts until that has finished too.
func TestBeginUpdate_WaitsForARunningVersion(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(fakeVersionGateEnv, dir)
	s := cliauth.NewService(slog.Default())
	s.Register(session.AgentTypeClaude, slowVersionProvider{cliauthtest.New(cliauthtest.State{Status: cliauth.Status{State: cliauth.StateSignedIn}})})
	t.Cleanup(s.Close)

	read := make(chan cliauth.Status, 1)
	go func() {
		statuses, _ := s.Statuses(context.Background(), session.AgentTypeClaude)
		read <- statuses[0]
	}()
	// --version runs only under the lock, so once it has started the read
	// holds the lock.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("--version never started")
		}
		time.Sleep(10 * time.Millisecond)
	}

	wait, end, err := s.BeginUpdate(session.AgentTypeClaude, "update-1")
	if err != nil {
		t.Fatalf("BeginUpdate: %v", err)
	}
	defer end()
	waited := make(chan error, 1)
	go func() { waited <- wait(context.Background()) }()
	select {
	case err := <-waited:
		t.Fatalf("wait returned (%v) while --version was still running", err)
	case <-time.After(200 * time.Millisecond):
	}

	if err := os.WriteFile(filepath.Join(dir, "answer"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-waited:
		if err != nil {
			t.Errorf("wait: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("wait did not return once --version finished")
	}
	if got := <-read; got.Version != "1.2.3" {
		t.Errorf("read = %+v, want version 1.2.3", got)
	}
}
