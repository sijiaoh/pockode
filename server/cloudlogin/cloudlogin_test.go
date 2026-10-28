package cloudlogin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/cloudcred"
)

const (
	issuedToken  = "issued-machine-token"
	linkedToken  = "linked-machine-token"
	revokedToken = "revoked-machine-token"
	testUserCode = "BCDFGHJK"
	testLinkURI  = "https://cloud.example/link#" + testUserCode
)

// pollAnswer is one answer of the fake cloud's token endpoint: an RFC 8628
// error code, "" for the machine token, or a status to answer with no body.
type pollAnswer struct {
	code   string
	status int
}

// fakeCloud answers the machine-link endpoints the way the cloud's account
// contract describes, polling through a script of answers.
type fakeCloud struct {
	*httptest.Server
	t *testing.T

	callsMu    sync.Mutex
	polls      []pollAnswer
	authorized *machineIdentity
	bearers    map[string][]string // path → Authorization tokens seen
}

func newFakeCloud(t *testing.T, polls ...pollAnswer) *fakeCloud {
	c := &fakeCloud{t: t, polls: polls, bearers: map[string][]string{}}
	c.Server = httptest.NewServer(http.HandlerFunc(c.serve))
	t.Cleanup(c.Close)
	return c
}

func (c *fakeCloud) serve(w http.ResponseWriter, r *http.Request) {
	c.callsMu.Lock()
	defer c.callsMu.Unlock()

	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	c.bearers[r.URL.Path] = append(c.bearers[r.URL.Path], token)

	switch r.Method + " " + r.URL.Path {
	case "POST /api/device/authorize":
		var id machineIdentity
		if err := json.NewDecoder(r.Body).Decode(&id); err != nil {
			c.t.Errorf("decode authorize: %v", err)
		}
		c.authorized = &id
		writeJSON(w, http.StatusOK, deviceAuthorization{
			DeviceCode: "device-code", UserCode: testUserCode,
			VerificationURIComplete: testLinkURI, Interval: 5, ExpiresIn: 600,
		})
	case "POST /api/device/token":
		var req struct {
			DeviceCode string `json:"device_code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DeviceCode != "device-code" {
			c.t.Errorf("token request = %+v, %v; want the issued device code", req, err)
		}
		if len(c.polls) == 0 {
			c.t.Error("polled past the end of the script")
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": codeExpiredToken})
			return
		}
		a := c.polls[0]
		c.polls = c.polls[1:]
		switch {
		case a.status != 0:
			w.WriteHeader(a.status)
		case a.code != "":
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": a.code})
		default:
			writeJSON(w, http.StatusOK, map[string]string{"machine_token": issuedToken})
		}
	case "GET /api/machine":
		if token != linkedToken {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		writeJSON(w, http.StatusOK, linkedMachine{Email: "alice@example.com", Name: "alice@devbox"})
	case "POST /api/machine/revoke":
		if token != linkedToken {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		c.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (c *fakeCloud) seen(path string) []string {
	c.callsMu.Lock()
	defer c.callsMu.Unlock()
	return c.bearers[path]
}

// presented reports whether token reached any endpoint of this cloud.
func (c *fakeCloud) presented(token string) bool {
	c.callsMu.Lock()
	defer c.callsMu.Unlock()
	for _, tokens := range c.bearers {
		if slices.Contains(tokens, token) {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// newTestLinker returns a linker whose waits return at once, recording each
// interval it was asked to wait.
func newTestLinker(t *testing.T) (*Linker, *bytes.Buffer, *[]time.Duration) {
	var out bytes.Buffer
	var waits []time.Duration
	l := NewLinker(cloudcred.NewStore(t.TempDir()), &out)
	l.wait = func(ctx context.Context, d time.Duration) error {
		waits = append(waits, d)
		return ctx.Err()
	}
	return l, &out, &waits
}

func save(t *testing.T, l *Linker, cloudURL, token string) {
	t.Helper()
	if err := l.store.Save(&cloudcred.Credential{CloudURL: cloudURL, MachineToken: token}); err != nil {
		t.Fatalf("Save: %v", err)
	}
}

func assertCredential(t *testing.T, l *Linker, want *cloudcred.Credential) {
	t.Helper()
	got, err := l.store.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if (got == nil) != (want == nil) || (got != nil && *got != *want) {
		t.Errorf("credential = %+v, want %+v", got, want)
	}
}

// The device flow end to end: the link is shown, polling follows interval and
// slow_down, rides out a cloud that is briefly down, and the token is stored
// for the cloud this process was pointed at.
func TestLoginLinksThroughDeviceFlow(t *testing.T) {
	cloud := newFakeCloud(t,
		pollAnswer{code: codeAuthorizationPending},
		pollAnswer{code: codeSlowDown},
		pollAnswer{status: http.StatusBadGateway},
		pollAnswer{code: codeAuthorizationPending},
		pollAnswer{},
	)
	l, out, waits := newTestLinker(t)

	if err := l.Login(context.Background(), cloud.URL); err != nil {
		t.Fatalf("Login: %v", err)
	}

	assertCredential(t, l, &cloudcred.Credential{CloudURL: cloud.URL, MachineToken: issuedToken})
	if want := []time.Duration{5 * time.Second, 5 * time.Second, 10 * time.Second, 10 * time.Second, 10 * time.Second}; !slices.Equal(*waits, want) {
		t.Errorf("waits = %v, want %v", *waits, want)
	}
	if id := cloud.authorized; id == nil || id.Hostname == "" || id.OSUser == "" || id.OS == "" {
		t.Errorf("authorize body = %+v, want hostname, os_user and os", id)
	}
	for _, want := range []string{testLinkURI, "BCDF-GHJK", "Scan to link"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if n := strings.Count(out.String(), "Cannot reach the cloud"); n != 1 {
		t.Errorf("reported the outage %d times, want once:\n%s", n, out)
	}
}

func TestLoginStopsWhenTheCodeIsNotApproved(t *testing.T) {
	for _, tt := range []struct {
		name    string
		answer  pollAnswer
		wantErr string
	}{
		{"expired", pollAnswer{code: codeExpiredToken}, "expired"},
		{"denied", pollAnswer{code: codeAccessDenied}, "declined"},
		{"refused", pollAnswer{status: http.StatusBadRequest}, "linking failed"},
		// The cloud hands a token out once, so an answer that loses it cannot
		// be polled past.
		{"unreadable token", pollAnswer{status: http.StatusOK}, "linking failed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cloud := newFakeCloud(t, pollAnswer{code: codeAuthorizationPending}, tt.answer)
			l, _, _ := newTestLinker(t)

			err := l.Login(context.Background(), cloud.URL)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("Login = %v, want an error mentioning %q", err, tt.wantErr)
			}
			assertCredential(t, l, nil)
		})
	}
}

// The code's lifetime (expires_in) bounds the wait even while the cloud keeps
// answering pending, so a forgotten login does not poll forever.
func TestLoginGivesUpWhenTheCodeLifetimeEnds(t *testing.T) {
	cloud := newFakeCloud(t)
	l, _, _ := newTestLinker(t)
	l.wait = func(ctx context.Context, d time.Duration) error {
		deadline, ok := ctx.Deadline()
		if left := time.Until(deadline); !ok || left > 600*time.Second || left < 590*time.Second {
			t.Errorf("waiting with deadline %v (set %v), want the code's 600 s lifetime", left, ok)
		}
		return context.DeadlineExceeded
	}

	if err := l.Login(context.Background(), cloud.URL); err != errExpired {
		t.Fatalf("Login = %v, want %v", err, errExpired)
	}
	assertCredential(t, l, nil)
}

func TestLoginWithAnExistingCredential(t *testing.T) {
	for _, tt := range []struct {
		name string
		// token is the stored credential's; sameCloud is whether it names
		// this cloud.
		token     string
		sameCloud bool
		// wantChecked is whether the stored token reached this cloud at all.
		wantChecked bool
		wantLinked  bool
		wantOutput  string
	}{
		{"valid", linkedToken, true, true, false, "already linked to alice@example.com as alice@devbox"},
		{"revoked", revokedToken, true, true, true, "no longer valid"},
		{"other cloud", linkedToken, false, false, true, "linking it to"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cloud := newFakeCloud(t, pollAnswer{})
			l, out, _ := newTestLinker(t)
			stored := &cloudcred.Credential{CloudURL: "https://other.example", MachineToken: tt.token}
			if tt.sameCloud {
				stored.CloudURL = cloud.URL
			}
			save(t, l, stored.CloudURL, stored.MachineToken)

			if err := l.Login(context.Background(), cloud.URL); err != nil {
				t.Fatalf("Login: %v", err)
			}

			if checked := cloud.presented(tt.token); checked != tt.wantChecked {
				t.Errorf("stored token shown to this cloud = %v, want %v", checked, tt.wantChecked)
			}
			want := stored
			if tt.wantLinked {
				want = &cloudcred.Credential{CloudURL: cloud.URL, MachineToken: issuedToken}
			}
			assertCredential(t, l, want)
			if !strings.Contains(out.String(), tt.wantOutput) {
				t.Errorf("output lacks %q:\n%s", tt.wantOutput, out)
			}
		})
	}
}

// Logging out always removes the credential; only whether the user is told to
// finish on the web depends on the cloud having heard about it.
func TestLogout(t *testing.T) {
	cloud := newFakeCloud(t)
	unreachable := httptest.NewServer(http.NotFoundHandler())
	unreachable.Close()

	for _, tt := range []struct {
		name     string
		cloudURL string
		token    string
		wantWeb  bool
	}{
		{"revoked", cloud.URL, linkedToken, false},
		{"already unlinked", cloud.URL, revokedToken, false},
		{"cloud unreachable", unreachable.URL, linkedToken, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l, out, _ := newTestLinker(t)
			save(t, l, tt.cloudURL, tt.token)

			if err := l.Logout(context.Background()); err != nil {
				t.Fatalf("Logout: %v", err)
			}

			assertCredential(t, l, nil)
			if askedWeb := strings.Contains(out.String(), "on the web"); askedWeb != tt.wantWeb {
				t.Errorf("told to unlink on the web = %v, want %v:\n%s", askedWeb, tt.wantWeb, out)
			}
		})
	}
	if got := cloud.seen("/api/machine/revoke"); !slices.Equal(got, []string{linkedToken, revokedToken}) {
		t.Errorf("revoke bearers = %v, want the stored tokens", got)
	}
}
