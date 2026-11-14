package cliprofile

import (
	"errors"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pockode/server/session"
)

func mustLaunch(t *testing.T, s *Store, agent session.AgentType, sel Selector) Launch {
	t.Helper()
	l, err := s.Launch(agent, sel)
	if err != nil {
		t.Fatalf("Launch(%s): %v", agent, err)
	}
	return l
}

// The default profile is the CLI as it would run without Pockode: nothing is
// added, whether it is current or named.
func TestLaunchDefaultAddsNothing(t *testing.T) {
	s := NewStore(t.TempDir())
	mustAdd(t, s, claude, "Work")

	for name, sel := range map[string]Selector{"current": SelectCurrent(), "named": Select("")} {
		if got := mustLaunch(t, s, claude, sel); got.ProfileID != "" || got.Env != nil || got.Args != nil {
			t.Errorf("%s default profile: Launch = %+v, want nothing added", name, got)
		}
	}
}

func TestLaunchProfile(t *testing.T) {
	tests := []struct {
		agent    session.AgentType
		wantEnv  func(dir string) []string
		wantArgs []string
	}{
		{claude, func(dir string) []string {
			return []string{"CLAUDE_CONFIG_DIR=" + dir, "CLAUDE_SECURESTORAGE_CONFIG_DIR=" + dir}
		}, nil},
		{session.AgentTypeCodex, func(dir string) []string {
			return []string{"CODEX_HOME=" + dir}
		}, []string{"-c", "cli_auth_credentials_store=file"}},
	}
	for _, tt := range tests {
		t.Run(string(tt.agent), func(t *testing.T) {
			p := newPreparing(t, tt.agent)
			if err := p.store.SetCurrent(tt.agent, p.id); err != nil {
				t.Fatal(err)
			}

			for name, sel := range map[string]Selector{"current": SelectCurrent(), "named": Select(p.id)} {
				got := mustLaunch(t, p.store, tt.agent, sel)
				if got.ProfileID != p.id || !slices.Equal(got.Env, tt.wantEnv(p.dir)) || !slices.Equal(got.Args, tt.wantArgs) {
					t.Errorf("%s: Launch = %+v, want profile %s with env %q and args %q", name, got, p.id, tt.wantEnv(p.dir), tt.wantArgs)
				}
			}
			// Prepared, not only named: the CLI is about to start in it.
			if _, err := os.Stat(p.dir); err != nil {
				t.Errorf("profile directory not prepared: %v", err)
			}
		})
	}
}

// Where profiles cannot be made, the current one falls back to the default —
// it may have been chosen by a process that could — but one named is refused
// rather than quietly run as the default.
func TestLaunchWithoutSymlinks(t *testing.T) {
	s := NewStore(t.TempDir())
	s.availabilityOnce.Do(func() { s.availability = Availability{Reason: "no symlinks here"} })
	p := mustAdd(t, s, claude, "Work")
	if err := s.SetCurrent(claude, p.ID); err != nil {
		t.Fatal(err)
	}

	if got := mustLaunch(t, s, claude, SelectCurrent()); got.ProfileID != "" || got.Env != nil {
		t.Errorf("current profile: Launch = %+v, want the default profile", got)
	}
	if _, err := s.Launch(claude, Select(p.ID)); !errors.Is(err, ErrSymlinksUnavailable) {
		t.Errorf("named profile: Launch = %v, want ErrSymlinksUnavailable", err)
	}
}

// Pockode without a configuration directory runs every CLI as its default
// profile, and cannot run one as another.
func TestLaunchNilStore(t *testing.T) {
	var s *Store
	if got := mustLaunch(t, s, claude, SelectCurrent()); got.ProfileID != "" || got.Env != nil {
		t.Errorf("current profile: Launch = %+v, want the default profile", got)
	}
	if _, err := s.Launch(claude, Select(uuid.Must(uuid.NewV7()).String())); !errors.Is(err, ErrSymlinksUnavailable) {
		t.Errorf("named profile: Launch = %v, want ErrSymlinksUnavailable", err)
	}
}

// On Windows an npm-installed CLI is a .cmd wrapper, and an argument with a
// double quote cannot be passed through cmd.exe to it (agent/cmdline.go):
// every start of the profile would be refused.
func TestLaunchArgsHaveNoQuotes(t *testing.T) {
	for agent, l := range layouts {
		for _, arg := range l.launchArgs {
			if strings.Contains(arg, `"`) {
				t.Errorf("%s launch argument %q has a double quote", agent, arg)
			}
		}
	}
}

func TestLaunchUnknownProfile(t *testing.T) {
	s := NewStore(t.TempDir())
	s.availabilityOnce.Do(func() { s.availability = Availability{Available: true} })

	if _, err := s.Launch(claude, Select(uuid.Must(uuid.NewV7()).String())); !errors.Is(err, ErrNotFound) {
		t.Errorf("Launch = %v, want ErrNotFound", err)
	}
}
