package cloudlogin

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pockode/server/cloudcred"
	"github.com/pockode/server/relay"
)

// fakeRelay stands in for relay.Manager: an account settled for one token,
// and the rechecks it was asked for.
type fakeRelay struct {
	mu      sync.Mutex
	account relay.Account
	token   string
	checks  atomic.Int32
}

func (r *fakeRelay) AccountFor(machineToken string) (relay.Account, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.account, r.token == machineToken
}

func (r *fakeRelay) CheckCloudCredentials() { r.checks.Add(1) }

type countingListener struct{ n atomic.Int32 }

func (l *countingListener) OnCloudLinkChange() { l.n.Add(1) }

// testService is a Service whose every wait between polls blocks until the
// test lets one poll through with poll().
type testService struct {
	*Service
	t        *testing.T
	polls    chan struct{}
	listener *countingListener
}

func newTestService(t *testing.T, cloudURL string, r Relay) *testService {
	t.Helper()
	s := NewService(cloudURL, cloudcred.NewStore(t.TempDir()), r, slog.New(slog.DiscardHandler))
	ts := &testService{Service: s, t: t, polls: make(chan struct{}), listener: &countingListener{}}
	s.wait = func(ctx context.Context, d time.Duration) error {
		select {
		case <-ts.polls:
			return ctx.Err()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.AddListener(ts.listener)
	t.Cleanup(s.Close)
	return ts
}

func (s *testService) poll() {
	s.t.Helper()
	select {
	case s.polls <- struct{}{}:
	case <-time.After(5 * time.Second):
		s.t.Fatal("the flow never waited for another poll")
	}
}

func (s *testService) save(cloudURL, token string) {
	s.t.Helper()
	if err := s.store.Save(&cloudcred.Credential{CloudURL: cloudURL, MachineToken: token}); err != nil {
		s.t.Fatalf("Save: %v", err)
	}
}

func (s *testService) credential() *cloudcred.Credential {
	s.t.Helper()
	cred, err := s.store.Load()
	if err != nil {
		s.t.Fatalf("Load: %v", err)
	}
	return cred
}

// awaitFlow waits until the latest flow satisfies done, and returns it.
func (s *testService) awaitFlow(done func(Flow) bool) Flow {
	s.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		st, err := s.Status()
		if err != nil {
			s.t.Fatalf("Status: %v", err)
		}
		if st.Flow != nil && done(*st.Flow) {
			return *st.Flow
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("flow never got there; last %+v", st.Flow)
		}
		time.Sleep(time.Millisecond)
	}
}

func (s *testService) awaitPhase(phase FlowPhase) Flow {
	s.t.Helper()
	return s.awaitFlow(func(f Flow) bool { return f.Phase == phase })
}

func (s *testService) awaitEnd() Flow {
	s.t.Helper()
	return s.awaitFlow(func(f Flow) bool { return f.Phase.Ended() })
}

// The flow end to end: the user is shown the code and the link with the
// code's expiry, an outage while polling is shown and cleared, the token is
// saved for this process's cloud, and the relay is told at once.
func TestServiceLinks(t *testing.T) {
	cloud := newFakeCloud(t,
		pollAnswer{code: codeAuthorizationPending},
		pollAnswer{status: http.StatusBadGateway},
		pollAnswer{},
	)
	r := &fakeRelay{}
	s := newTestService(t, cloud.URL, r)

	started, err := s.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	notifiedAtStart := s.listener.n.Load()
	if started.Phase != FlowStarting {
		t.Errorf("started in %q, want %q", started.Phase, FlowStarting)
	}

	waiting := s.awaitPhase(FlowWaiting)
	if waiting.ID != started.ID || waiting.UserCode != testUserCode || waiting.VerificationURL != testLinkURI {
		t.Errorf("waiting flow = %+v, want the code and link of flow %s", waiting, started.ID)
	}
	if left := time.Until(waiting.ExpiresAt); left > 600*time.Second || left < 590*time.Second {
		t.Errorf("expires in %v, want the code's 600 s lifetime", left)
	}

	s.poll()
	s.poll()
	unreachable := s.awaitFlow(func(f Flow) bool { return f.CloudUnreachable })
	if unreachable.Revision <= waiting.Revision {
		t.Errorf("revision went from %d to %d, want it to grow", waiting.Revision, unreachable.Revision)
	}

	s.poll()
	linked := s.awaitEnd()
	if linked.Phase != FlowLinked || linked.Email != "alice@example.com" || linked.MachineName != "alice@devbox" {
		t.Errorf("ended flow = %+v, want linked as alice@example.com", linked)
	}
	if linked.UserCode != "" || linked.VerificationURL != "" || linked.CloudUnreachable {
		t.Errorf("ended flow still shows %+v, want the code, link and outage cleared", linked)
	}
	if got := s.credential(); got == nil || *got != (cloudcred.Credential{CloudURL: cloud.URL, MachineToken: issuedToken}) {
		t.Errorf("credential = %+v, want the issued token for this cloud", got)
	}
	if r.checks.Load() == 0 {
		t.Error("the relay was not asked to re-read cloud.json")
	}
	if s.listener.n.Load() <= notifiedAtStart {
		t.Error("listeners heard of no change after the start")
	}
}

// Whatever a client reads — the flow at every phase, and the status — the
// device code and the machine token never leave the process.
func TestServiceKeepsSecretsInTheProcess(t *testing.T) {
	cloud := newFakeCloud(t, pollAnswer{})
	s := newTestService(t, cloud.URL, &fakeRelay{})

	var seen []string
	record := func() {
		st, err := s.Status()
		if err != nil {
			t.Fatalf("Status: %v", err)
		}
		data, _ := json.Marshal(st)
		seen = append(seen, string(data))
	}
	f, _ := s.Start()
	data, _ := json.Marshal(f)
	seen = append(seen, string(data))
	s.awaitPhase(FlowWaiting)
	record()
	s.poll()
	s.awaitEnd()
	record()

	for _, got := range seen {
		for _, secret := range []string{"device-code", issuedToken} {
			if strings.Contains(got, secret) {
				t.Errorf("a client could read %q in %s", secret, got)
			}
		}
	}
}

func TestServiceRunsOneFlowAtATime(t *testing.T) {
	cloud := newFakeCloud(t, pollAnswer{code: codeAccessDenied})
	s := newTestService(t, cloud.URL, nil)

	first, _ := s.Start()
	second, err := s.Start()
	if err != nil || second.ID != first.ID {
		t.Fatalf("second Start = %+v, %v; want flow %s", second, err, first.ID)
	}

	s.poll()
	ended := s.awaitEnd()
	third, err := s.Start()
	if err != nil || third.ID == first.ID {
		t.Errorf("Start after the end = %+v, %v; want a new flow", third, err)
	}
	// One counter for every flow: a client keeps whichever copy has the
	// higher revision, whatever its id.
	if third.Revision <= ended.Revision {
		t.Errorf("new flow's revision %d, want above the ended flow's %d", third.Revision, ended.Revision)
	}
}

func TestServiceCancel(t *testing.T) {
	cloud := newFakeCloud(t)
	s := newTestService(t, cloud.URL, nil)
	s.save(cloud.URL, revokedToken)

	f, _ := s.Start()
	s.awaitPhase(FlowWaiting)

	if _, err := s.Cancel("another-flow"); !errors.Is(err, ErrFlowNotFound) {
		t.Errorf("Cancel of another flow = %v, want %v", err, ErrFlowNotFound)
	}
	canceled, err := s.Cancel(f.ID)
	if err != nil || canceled.Phase != FlowCanceled || canceled.UserCode != "" {
		t.Errorf("Cancel = %+v, %v; want the flow canceled with its code cleared", canceled, err)
	}
	if again, err := s.Cancel(f.ID); err != nil || again != canceled {
		t.Errorf("Cancel of the ended flow = %+v, %v; want it as it ended, %+v", again, err, canceled)
	}
	if got := s.credential(); got == nil || got.MachineToken != revokedToken {
		t.Errorf("credential = %+v, want the one the flow started over", got)
	}
}

func TestServiceFailures(t *testing.T) {
	for _, tt := range []struct {
		name       string
		answer     pollAnswer
		wantReason FailureReason
	}{
		{"declined", pollAnswer{code: codeAccessDenied}, FailureDeclined},
		{"refused", pollAnswer{status: http.StatusBadRequest}, FailureOther},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cloud := newFakeCloud(t, tt.answer)
			s := newTestService(t, cloud.URL, nil)

			s.Start()
			s.poll()
			f := s.awaitEnd()
			if f.Phase != FlowFailed || f.Failure == nil || f.Failure.Reason != tt.wantReason {
				t.Errorf("flow = %+v (failure %+v), want failed with %q", f, f.Failure, tt.wantReason)
			}
			if got := s.credential(); got != nil {
				t.Errorf("credential = %+v, want none", got)
			}
		})
	}
}

// A machine already linked to this cloud stays as it is, whether the link was
// there at the start or written by another process while the flow ran. In
// the second case the flow's own token is revoked, so the account is not left
// with a machine nothing acts for.
func TestServiceKeepsAValidLink(t *testing.T) {
	t.Run("at the start", func(t *testing.T) {
		cloud := newFakeCloud(t)
		s := newTestService(t, cloud.URL, nil)
		s.save(cloud.URL, linkedToken)

		s.Start()
		f := s.awaitEnd()
		if f.Phase != FlowAlreadyLinked || f.Email != "alice@example.com" {
			t.Errorf("flow = %+v, want already linked as alice@example.com", f)
		}
		if len(cloud.seen("/api/device/authorize")) != 0 {
			t.Error("asked the cloud for a code anyway")
		}
	})

	for _, tt := range []struct {
		name string
		// written is the token another process writes for this cloud while
		// the flow waits.
		written string
		// machineStatus and revokeStatus make the cloud fail those requests.
		machineStatus, revokeStatus int
		wantPhase                   FlowPhase
		wantToken                   string
		// wantRevoked is whether the flow tried to revoke its own token.
		wantRevoked    bool
		wantLeftBehind bool
	}{
		{"valid link written meanwhile", linkedToken, 0, 0, FlowAlreadyLinked, linkedToken, true, false},
		{"revoke fails", linkedToken, 0, http.StatusServiceUnavailable, FlowAlreadyLinked, linkedToken, true, true},
		{"invalid link written meanwhile", revokedToken, 0, 0, FlowLinked, issuedToken, false, false},
		// It may be valid, so it is kept all the same.
		{"written link cannot be checked", linkedToken, http.StatusServiceUnavailable, 0, FlowFailed, linkedToken, true, false},
		{"cannot be checked, revoke fails", linkedToken, http.StatusServiceUnavailable, http.StatusServiceUnavailable, FlowFailed, linkedToken, true, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cloud := newFakeCloud(t, pollAnswer{})
			cloud.machineStatus = tt.machineStatus
			cloud.revokeStatus = tt.revokeStatus
			s := newTestService(t, cloud.URL, nil)

			s.Start()
			s.awaitPhase(FlowWaiting)
			s.save(cloud.URL, tt.written)
			s.poll()
			f := s.awaitEnd()

			if f.Phase != tt.wantPhase || f.LeftBehind != tt.wantLeftBehind {
				t.Errorf("flow = %+v, want %q with left_behind %v", f, tt.wantPhase, tt.wantLeftBehind)
			}
			if got := s.credential(); got == nil || got.MachineToken != tt.wantToken {
				t.Errorf("credential = %+v, want token %q", got, tt.wantToken)
			}
			if revoked := slices.Contains(cloud.seen("/api/machine/revoke"), issuedToken); revoked != tt.wantRevoked {
				t.Errorf("flow's own token revoked = %v, want %v", revoked, tt.wantRevoked)
			}
		})
	}
}

func TestServiceStatus(t *testing.T) {
	const cloudURL = "https://cloud.example"
	machine, err := currentMachine()
	if err != nil {
		t.Fatalf("currentMachine: %v", err)
	}
	// The name a flow would send, so the UI can name the machine before it is
	// linked.
	machineName := machine.OSUser + "@" + machine.Hostname
	for _, tt := range []struct {
		name string
		// stored is cloud.json's cloud and token; "" cloud for no file.
		storedCloud, storedToken string
		relay                    *fakeRelay
		wantCredential           CredentialState
		wantRelay                RelayState
		wantEmail                string
		wantOtherCloud           string
	}{
		{"guest", "", "", &fakeRelay{}, CredentialNone, RelayGuest, "", ""},
		{"attached", cloudURL, linkedToken,
			&fakeRelay{token: linkedToken, account: relay.Account{Email: "alice@example.com"}},
			CredentialLinked, RelayAttached, "alice@example.com", ""},
		{"link invalid", cloudURL, revokedToken,
			&fakeRelay{token: revokedToken, account: relay.Account{Error: "invalid_machine_token"}},
			CredentialLinked, RelayLinkInvalid, "", ""},
		{"not attached", cloudURL, linkedToken,
			&fakeRelay{token: linkedToken, account: relay.Account{Error: "internal_error"}},
			CredentialLinked, RelayNotAttached, "", ""},
		// Linked by another process; the relay's watcher has yet to notice.
		{"pending", cloudURL, linkedToken, &fakeRelay{}, CredentialLinked, RelayPending, "", ""},
		// A token from another cloud is not this process's: it is a guest.
		{"other cloud", "https://other.example", linkedToken, &fakeRelay{}, CredentialOtherCloud, RelayGuest, "", "https://other.example"},
		{"relay disabled", cloudURL, linkedToken, nil, CredentialLinked, RelayDisabled, "", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var r Relay
			if tt.relay != nil {
				r = tt.relay
			}
			s := newTestService(t, cloudURL, r)
			if tt.storedCloud != "" {
				s.save(tt.storedCloud, tt.storedToken)
			}

			st, err := s.Status()
			if err != nil {
				t.Fatalf("Status: %v", err)
			}
			want := Status{
				CloudURL:      cloudURL,
				Credential:    tt.wantCredential,
				OtherCloudURL: tt.wantOtherCloud,
				Relay:         tt.wantRelay,
				Email:         tt.wantEmail,
				MachineName:   machineName,
			}
			if st != want {
				t.Errorf("Status = %+v, want %+v", st, want)
			}
		})
	}
}

// Unlinking is `pockode logout`: the file goes whatever the cloud answers, and
// a cloud that could not be told is reported.
func TestServiceUnlink(t *testing.T) {
	cloud := newFakeCloud(t)
	unreachable := httptest.NewServer(http.NotFoundHandler())
	unreachable.Close()

	for _, tt := range []struct {
		name            string
		cloudURL        string
		token           string
		wantRevokeError bool
	}{
		{"revoked", cloud.URL, linkedToken, false},
		{"cloud unreachable", unreachable.URL, linkedToken, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := &fakeRelay{}
			s := newTestService(t, cloud.URL, r)
			s.save(tt.cloudURL, tt.token)

			got, err := s.Unlink()
			if err != nil {
				t.Fatalf("Unlink: %v", err)
			}
			if !got.WasLinked || got.CloudURL != tt.cloudURL || (got.RevokeError != "") != tt.wantRevokeError {
				t.Errorf("Unlink = %+v, want linked with %s, revoke error %v", got, tt.cloudURL, tt.wantRevokeError)
			}
			if cred := s.credential(); cred != nil {
				t.Errorf("credential = %+v, want none", cred)
			}
			if r.checks.Load() == 0 {
				t.Error("the relay was not asked to re-read cloud.json")
			}
		})
	}

	t.Run("not linked", func(t *testing.T) {
		s := newTestService(t, cloud.URL, nil)
		if got, err := s.Unlink(); err != nil || got.WasLinked {
			t.Errorf("Unlink = %+v, %v; want nothing unlinked", got, err)
		}
	})
}

// Once the user has approved, the flow holds a token the cloud will not hand
// out again; a cancel then returns at once and the link is still made.
func TestServiceCancelAfterApproval(t *testing.T) {
	cloud := newFakeCloud(t, pollAnswer{})
	s := newTestService(t, cloud.URL, nil)
	release := gateRequests(t, cloud, "/api/machine")

	f, _ := s.Start()
	s.awaitPhase(FlowWaiting)
	s.poll()
	s.awaitPhase(FlowFinishing)

	got, err := s.Cancel(f.ID)
	if err != nil || got.Phase != FlowFinishing || got.UserCode != "" {
		t.Errorf("Cancel = %+v, %v; want the flow finishing, its code cleared", got, err)
	}
	release()
	if ended := s.awaitEnd(); ended.Phase != FlowLinked {
		t.Errorf("flow ended %q, want %q", ended.Phase, FlowLinked)
	}
}

// The process, not the cloud, ends a flow whose code ran out: it polls under
// a deadline at the expiry it shows the user — the code's lifetime, or a
// bound of its own when the cloud names none — and reads that deadline
// running out as the code expiring.
func TestServiceEndsAnExpiredFlow(t *testing.T) {
	for _, tt := range []struct {
		name         string
		expiresIn    int
		wantLifetime time.Duration
	}{
		{"code lifetime", 300, 5 * time.Minute},
		{"cloud names none", 0, fallbackLifetime},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cloud := newFakeCloud(t)
			cloud.expiresIn = tt.expiresIn
			s := newTestService(t, cloud.URL, nil)
			deadlines := make(chan time.Time, 1)
			s.wait = func(ctx context.Context, d time.Duration) error {
				deadline, _ := ctx.Deadline()
				deadlines <- deadline
				return context.DeadlineExceeded
			}

			f, _ := s.Start()
			ended := s.awaitEnd()
			if ended.Failure == nil || ended.Failure.Reason != FailureExpired {
				t.Errorf("flow = %+v (failure %+v), want failed as expired", ended, ended.Failure)
			}
			if left := ended.ExpiresAt.Sub(f.StartedAt); left < tt.wantLifetime || left > tt.wantLifetime+5*time.Second {
				t.Errorf("expires %v after the start, want %v", left, tt.wantLifetime)
			}
			if deadline := <-deadlines; !deadline.Equal(ended.ExpiresAt) {
				t.Errorf("polled until %v, want the expiry shown, %v", deadline, ended.ExpiresAt)
			}
		})
	}
}

func TestServiceClose(t *testing.T) {
	cloud := newFakeCloud(t)
	s := newTestService(t, cloud.URL, nil)

	s.Start()
	s.awaitPhase(FlowWaiting)
	s.Close()

	st, err := s.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if f := st.Flow; f.Phase != FlowFailed || f.Failure == nil || f.Failure.Detail != ErrShuttingDown.Error() {
		t.Errorf("flow after Close = %+v (failure %+v), want failed over the shutdown", f, f.Failure)
	}
	if _, err := s.Start(); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("Start after Close = %v, want %v", err, ErrShuttingDown)
	}
}

// Close waits for an unlink under way, so the process never exits between the
// revoke and the delete, leaving cloud.json holding a revoked token; and an
// unlink after Close is refused.
func TestServiceCloseWaitsForUnlink(t *testing.T) {
	cloud := newFakeCloud(t)
	s := newTestService(t, cloud.URL, nil)
	release := gateRequests(t, cloud, "/api/machine/revoke")
	arrived := make(chan struct{}, 1)
	cloud.gateArrived = arrived
	s.save(cloud.URL, linkedToken)

	unlinked := make(chan error, 1)
	go func() {
		_, err := s.Unlink()
		unlinked <- err
	}()
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("Unlink never asked the cloud to revoke")
	}

	closed := make(chan struct{})
	go func() {
		s.Close()
		close(closed)
	}()
	select {
	case <-closed:
		t.Fatal("Close returned while an unlink was still revoking")
	case <-time.After(100 * time.Millisecond):
		// Too little on a slow machine only lets a regression through.
	}
	release()
	<-closed
	if err := <-unlinked; err != nil {
		t.Fatalf("Unlink: %v", err)
	}
	if cred := s.credential(); cred != nil {
		t.Errorf("credential after Close = %+v, want none", cred)
	}
	if _, err := s.Unlink(); !errors.Is(err, ErrShuttingDown) {
		t.Errorf("Unlink after Close = %v, want %v", err, ErrShuttingDown)
	}
}

// gateRequests holds the fake cloud's requests for path until the returned
// release, which also runs at cleanup so a failed test does not leave the
// fake's handler, and the service closing over it, waiting forever. Call it
// after newTestService: cleanups run last first, and the release has to come
// before the service's Close.
func gateRequests(t *testing.T, cloud *fakeCloud, path string) (release func()) {
	gate := make(chan struct{})
	cloud.gatedPath, cloud.gate = path, gate
	var once sync.Once
	release = func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	return release
}

// An unlink that comes while a flow decides whether to save never deletes the
// flow's token unrevoked: it waits, and then unlinks what was saved.
func TestServiceUnlinkWaitsForAFinishingFlow(t *testing.T) {
	cloud := newFakeCloud(t, pollAnswer{})
	s := newTestService(t, cloud.URL, nil)
	release := gateRequests(t, cloud, "/api/machine")
	arrived := make(chan struct{}, 1)
	cloud.gateArrived = arrived

	// A token the cloud refuses, written meanwhile, has the flow ask about it
	// before saving: the gate holds it there.
	s.Start()
	s.awaitPhase(FlowWaiting)
	s.save(cloud.URL, revokedToken)
	s.poll()
	select {
	case <-arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the flow never asked about the token written meanwhile")
	}

	unlinked := make(chan Unlinked, 1)
	go func() {
		u, err := s.Unlink()
		if err != nil {
			t.Errorf("Unlink: %v", err)
		}
		unlinked <- u
	}()
	// Time for Unlink to reach cloud.json if nothing held it back. Too little
	// on a slow machine only lets a regression through; it never fails a
	// correct service.
	time.Sleep(100 * time.Millisecond)
	release()

	u := <-unlinked
	if f := s.awaitEnd(); f.Phase != FlowLinked {
		t.Errorf("flow ended %q, want %q", f.Phase, FlowLinked)
	}
	if !u.WasLinked || u.RevokeError != "" {
		t.Errorf("Unlink = %+v, want the link unlinked", u)
	}
	if cred := s.credential(); cred != nil {
		t.Errorf("credential = %+v, want none", cred)
	}
	if !slices.Contains(cloud.seen("/api/machine/revoke"), issuedToken) {
		t.Error("the flow's token was deleted without being revoked")
	}
}
