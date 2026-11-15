package cliprofile

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

// A withdrawn profile is current nowhere on this server while it stays
// chosen, so a refused removal can put it back as it was.
func TestWithdrawnCurrentResolvesToDefault(t *testing.T) {
	s := NewStore(t.TempDir(), t.TempDir())
	p := mustAdd(t, s, claude, "Work")
	if err := s.SetCurrent(claude, p.ID); err != nil {
		t.Fatal(err)
	}
	// Where profiles cannot be used, the current one resolves to the default
	// anyway (Resolve).
	chosen := ""
	if s.Availability().Available {
		chosen = p.ID
	}

	restore, ok := s.Withdraw(claude, p.ID)
	if !ok {
		t.Fatal("Withdraw refused a profile nobody is removing")
	}
	if _, ok := s.Withdraw(claude, p.ID); ok {
		t.Error("a second Withdraw of the same profile was accepted")
	}
	if id, err := s.Resolve(claude, SelectCurrent()); err != nil || id != "" {
		t.Errorf("Resolve while withdrawn = %q, %v; want the default profile", id, err)
	}
	if id, err := s.Resolve(claude, Select(p.ID)); err != nil || id != p.ID {
		t.Errorf("Resolve of the profile by name = %q, %v; want it, as a sign-out asks for", id, err)
	}
	if l, err := s.Load(claude); err != nil || l.Current != p.ID {
		t.Errorf("stored choice while withdrawn = %q, %v; want it untouched", l.Current, err)
	}

	restore()
	if id, err := s.Resolve(claude, SelectCurrent()); err != nil || id != chosen {
		t.Errorf("Resolve once restored = %q, %v; want %q", id, err, chosen)
	}
}

// A one-shot run holds the profile it starts as until it is released, and a
// removal waits for that; one starting while the profile is withdrawn, or
// after another process removed it under its feet, starts as the default
// profile rather than fail or recreate the directory.
func TestLaunchOneShot(t *testing.T) {
	p := newPreparing(t, claude)
	if err := p.store.SetCurrent(p.agent, p.id); err != nil {
		t.Fatal(err)
	}

	l, release, err := p.store.LaunchOneShot(p.agent)
	if err != nil || l.ProfileID != p.id {
		t.Fatalf("LaunchOneShot = %q, %v; want the current profile", l.ProfileID, err)
	}
	restore, _ := p.store.Withdraw(p.agent, p.id)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := p.store.WaitUnheld(ctx, p.agent, p.id); !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("WaitUnheld with the run still held = %v, want DeadlineExceeded", err)
	}
	if l, release, err := p.store.LaunchOneShot(p.agent); err != nil || l.ProfileID != "" {
		t.Errorf("LaunchOneShot while withdrawn = %q, %v; want the default profile", l.ProfileID, err)
	} else {
		release()
	}
	go release()
	if err := p.store.WaitUnheld(context.Background(), p.agent, p.id); err != nil {
		t.Errorf("WaitUnheld once released: %v", err)
	}
	restore()

	otherProcess := NewStore(filepath.Dir(filepath.Dir(p.store.baseDir)), t.TempDir())
	testHookLinked = func() {
		testHookLinked = nil
		if err := otherProcess.Remove(p.agent, p.id); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { testHookLinked = nil })
	l, release, err = p.store.LaunchOneShot(p.agent)
	if err != nil || l.ProfileID != "" {
		t.Fatalf("LaunchOneShot racing a removal = %q, %v; want the default profile", l.ProfileID, err)
	}
	release()
}
