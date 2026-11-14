package cliprofile

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/pockode/server/session"
)

func TestOverview(t *testing.T) {
	s := NewStore(t.TempDir())
	work := mustAdd(t, s, codex, "Work")
	if err := s.SetCurrent(codex, work.ID); err != nil {
		t.Fatal(err)
	}

	o, err := s.Overview([]session.AgentType{claude, codex})
	if err != nil {
		t.Fatal(err)
	}
	if len(o.CLIs) != 2 || o.CLIs[0].Agent != claude || o.CLIs[1].Agent != codex {
		t.Fatalf("CLIs = %+v, want claude then codex", o.CLIs)
	}
	if c := o.CLIs[0]; c.CurrentProfileID != "" || c.Profiles == nil || len(c.Profiles) != 0 {
		t.Errorf("claude = %+v, want the default profile current and an empty list", c)
	}
	if c := o.CLIs[1]; c.CurrentProfileID != work.ID || len(c.Profiles) != 1 || c.Profiles[0] != work {
		t.Errorf("codex = %+v, want Work, current", c)
	}
}

// A client explains a machine that cannot use profiles from the overview, and
// is still shown what was chosen: the list is shared with processes that can.
func TestOverviewWhereProfilesAreUnavailable(t *testing.T) {
	t.Run("no symlinks", func(t *testing.T) {
		s := NewStore(t.TempDir())
		s.availabilityOnce.Do(func() { s.availability = Availability{Reason: "turn on Developer Mode"} })
		work := mustAdd(t, s, claude, "Work")
		if err := s.SetCurrent(claude, work.ID); err != nil {
			t.Fatal(err)
		}

		o, err := s.Overview([]session.AgentType{claude})
		if err != nil {
			t.Fatal(err)
		}
		assertWire(t, o, `{"available":false,"unavailable_reason":"turn on Developer Mode","clis":[{"agent":"claude","current_profile_id":"`+work.ID+`","profiles":[{"id":"`+work.ID+`","name":"Work"}]}]}`)
	})

	t.Run("no configuration directory", func(t *testing.T) {
		var s *Store
		o, err := s.Overview([]session.AgentType{claude})
		if err != nil {
			t.Fatal(err)
		}
		assertWire(t, o, `{"available":false,"unavailable_reason":"`+ErrNoStore.Error()+`","clis":[{"agent":"claude","profiles":[]}]}`)

		if _, err := s.Add(claude, "Work"); !errors.Is(err, ErrNoStore) {
			t.Errorf("Add = %v, want ErrNoStore", err)
		}
		if err := s.SetCurrent(claude, ""); !errors.Is(err, ErrNoStore) {
			t.Errorf("SetCurrent = %v, want ErrNoStore", err)
		}
	})
}

func assertWire(t *testing.T, v any, want string) {
	t.Helper()
	got, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Errorf("wire form:\n got %s\nwant %s", got, want)
	}
}
