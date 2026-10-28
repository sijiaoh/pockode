package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/pockode/server/cloudcred"
)

// fakeAccountCloud answers register and refresh the way the cloud's account
// contract describes, and records the machine token ("" for a guest request)
// of each request it does not turn away for an outage or the size cap.
type fakeAccountCloud struct {
	*httptest.Server
	presentedMu sync.Mutex
	presented   []string
	// down makes every request fail with 503, as a cloud in an outage does.
	down atomic.Bool
}

const (
	validMachineToken   = "valid-machine-token"
	revokedMachineToken = "revoked-machine-token"
)

var accountTestRelay = StoredConfig{Subdomain: "sub", RelayToken: "relay-token", RelayServer: "cloud.pockode.com"}

func newFakeAccountCloud(t *testing.T) *fakeAccountCloud {
	c := &fakeAccountCloud{}
	c.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c.down.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		// The cap a cloud that predates accounts puts on these bodies.
		if r.ContentLength > 4*1024 {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		var req struct {
			RelayToken   string    `json:"relay_token"`
			MachineToken *string   `json:"machine_token"`
			Instance     *Instance `json:"instance"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if (req.MachineToken == nil) != (req.Instance == nil) {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		token := ""
		if req.MachineToken != nil {
			token = *req.MachineToken
		}
		c.presentedMu.Lock()
		c.presented = append(c.presented, token)
		c.presentedMu.Unlock()

		if r.URL.Path == "/api/relay/refresh" && req.RelayToken != accountTestRelay.RelayToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if req.Instance != nil && strings.ContainsRune(req.Instance.Path, '\n') {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		resp := Registration{StoredConfig: accountTestRelay}
		switch token {
		case "":
		case validMachineToken:
			resp.Email = "alice@example.com"
		default:
			resp.Error = "invalid_machine_token"
		}
		if r.URL.Path == "/api/relay/register" {
			w.WriteHeader(http.StatusCreated)
		}
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(c.Close)
	return c
}

// takePresented returns the tokens presented since the last call.
func (c *fakeAccountCloud) takePresented() []string {
	c.presentedMu.Lock()
	defer c.presentedMu.Unlock()
	got := c.presented
	c.presented = nil
	return got
}

func newAccountTestManager(t *testing.T, cloud *fakeAccountCloud, creds *cloudcred.Store, workDir string) *Manager {
	t.Helper()
	return NewManager(Config{
		CloudURL:         cloud.URL,
		DataDir:          t.TempDir(),
		CloudCredentials: creds,
		Instance:         NewInstance(InstanceServer, workDir),
	}, 0, 0, testLogger())
}

// Startup attaches the relay when the machine is linked to an account of this
// cloud, and in every other case brings the relay up exactly as a guest would:
// no link, a link to another cloud, a revoked link, an instance the cloud will
// not list, a credential file that cannot be read.
func TestCredentialsAttachToAccount(t *testing.T) {
	tests := []struct {
		name          string
		cred          func(cloudURL string) *cloudcred.Credential // nil: no cloud.json
		unreadable    bool
		workDir       string
		wantPresented []string
		wantAccount   Account
	}{
		{
			name:          "guest",
			wantPresented: []string{""},
		},
		{
			name: "linked",
			cred: func(u string) *cloudcred.Credential {
				return &cloudcred.Credential{CloudURL: u, MachineToken: validMachineToken}
			},
			wantPresented: []string{validMachineToken},
			wantAccount:   Account{Email: "alice@example.com"},
		},
		{
			name: "linked to another cloud",
			cred: func(string) *cloudcred.Credential {
				return &cloudcred.Credential{CloudURL: "https://cloud.pockode.com", MachineToken: validMachineToken}
			},
			wantPresented: []string{""},
		},
		{
			name: "revoked",
			cred: func(u string) *cloudcred.Credential {
				return &cloudcred.Credential{CloudURL: u, MachineToken: revokedMachineToken}
			},
			wantPresented: []string{revokedMachineToken},
			wantAccount:   Account{Error: "invalid_machine_token"},
		},
		{
			name: "instance refused",
			cred: func(u string) *cloudcred.Credential {
				return &cloudcred.Credential{CloudURL: u, MachineToken: validMachineToken}
			},
			workDir:       "/home/alice/a\nb",
			wantPresented: []string{validMachineToken, ""},
		},
		{
			name: "instance over an old cloud's body cap",
			cred: func(u string) *cloudcred.Credential {
				return &cloudcred.Credential{CloudURL: u, MachineToken: validMachineToken}
			},
			workDir:       "/home/alice/" + strings.Repeat("a", 4096),
			wantPresented: []string{""},
		},
		{
			name:          "unreadable",
			unreadable:    true,
			wantPresented: []string{""},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cloud := newFakeAccountCloud(t)
			configDir := t.TempDir()
			creds := cloudcred.NewStore(configDir)
			if tt.cred != nil {
				if err := creds.Save(tt.cred(cloud.URL)); err != nil {
					t.Fatalf("save credential: %v", err)
				}
			}
			if tt.unreadable {
				// A directory where the file should be fails every read, on
				// every platform.
				if err := os.MkdirAll(filepath.Join(configDir, "pockode", "cloud.json"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			workDir := tt.workDir
			if workDir == "" {
				workDir = "/home/alice/app"
			}

			m := newAccountTestManager(t, cloud, creds, workDir)
			cfg, err := m.credentials(context.Background())
			if err != nil {
				t.Fatalf("credentials: %v", err)
			}
			if *cfg != accountTestRelay {
				t.Errorf("credentials = %+v, want %+v", *cfg, accountTestRelay)
			}
			if got := cloud.takePresented(); !slices.Equal(got, tt.wantPresented) {
				t.Errorf("presented tokens = %q, want %q", got, tt.wantPresented)
			}
			if got := m.Account(); got != tt.wantAccount {
				t.Errorf("Account() = %+v, want %+v", got, tt.wantAccount)
			}

			// Whatever startup made of cloud.json is settled: the watcher has
			// nothing to refresh until the file changes.
			if err := m.syncCloudCredentials(context.Background()); err != nil {
				t.Fatalf("syncCloudCredentials: %v", err)
			}
			if got := cloud.takePresented(); len(got) != 0 {
				t.Errorf("watcher refreshed an unchanged cloud.json, presenting %q", got)
			}
		})
	}
}

// A running relay follows `pockode login` and `pockode logout` with a refresh,
// which keeps its subdomain.
func TestSyncCloudCredentialsFollowsLoginAndLogout(t *testing.T) {
	cloud := newFakeAccountCloud(t)
	creds := cloudcred.NewStore(t.TempDir())
	m := newAccountTestManager(t, cloud, creds, "/home/alice/app")
	if _, err := m.credentials(context.Background()); err != nil {
		t.Fatalf("credentials: %v", err)
	}
	cloud.takePresented()

	steps := []struct {
		name          string
		change        func() error
		wantPresented []string
		wantAccount   Account
	}{
		{
			name: "login",
			change: func() error {
				return creds.Save(&cloudcred.Credential{CloudURL: cloud.URL, MachineToken: validMachineToken})
			},
			wantPresented: []string{validMachineToken},
			wantAccount:   Account{Email: "alice@example.com"},
		},
		{
			name:          "logout",
			change:        creds.Delete,
			wantPresented: []string{""},
		},
	}
	for _, step := range steps {
		if err := step.change(); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		if err := m.syncCloudCredentials(context.Background()); err != nil {
			t.Fatalf("%s: syncCloudCredentials: %v", step.name, err)
		}
		if got := cloud.takePresented(); !slices.Equal(got, step.wantPresented) {
			t.Errorf("%s: presented tokens = %q, want %q", step.name, got, step.wantPresented)
		}
		if got := m.Account(); got != step.wantAccount {
			t.Errorf("%s: Account() = %+v, want %+v", step.name, got, step.wantAccount)
		}
		if saved, err := m.store.Load(); err != nil || *saved != accountTestRelay {
			t.Errorf("%s: stored relay = %+v, %v; want %+v", step.name, saved, err, accountTestRelay)
		}
	}
}

// A relay token the cloud has forgotten is the reconnect loop's to replace, by
// registering anew; the watcher asks once and then stops asking every poll.
func TestSyncCloudCredentialsLeavesAForgottenRelayToTheReconnectLoop(t *testing.T) {
	cloud := newFakeAccountCloud(t)
	creds := cloudcred.NewStore(t.TempDir())
	m := newAccountTestManager(t, cloud, creds, "/home/alice/app")
	forgotten := accountTestRelay
	forgotten.RelayToken = "forgotten-relay-token"
	if err := m.store.Save(&forgotten); err != nil {
		t.Fatal(err)
	}
	if err := creds.Save(&cloudcred.Credential{CloudURL: cloud.URL, MachineToken: validMachineToken}); err != nil {
		t.Fatal(err)
	}

	for i, want := range [][]string{{validMachineToken}, nil} {
		if err := m.syncCloudCredentials(context.Background()); err != nil {
			t.Fatalf("poll %d: syncCloudCredentials: %v", i+1, err)
		}
		if got := cloud.takePresented(); !slices.Equal(got, want) {
			t.Errorf("poll %d: presented tokens = %q, want %q", i+1, got, want)
		}
	}
}

// A login made while the cloud is down is not lost: the watcher keeps
// refreshing until the cloud answers, and only then counts it settled.
func TestSyncCloudCredentialsRetriesAFailedRefresh(t *testing.T) {
	cloud := newFakeAccountCloud(t)
	creds := cloudcred.NewStore(t.TempDir())
	m := newAccountTestManager(t, cloud, creds, "/home/alice/app")
	if _, err := m.credentials(context.Background()); err != nil {
		t.Fatalf("credentials: %v", err)
	}
	cloud.takePresented()
	if err := creds.Save(&cloudcred.Credential{CloudURL: cloud.URL, MachineToken: validMachineToken}); err != nil {
		t.Fatal(err)
	}

	cloud.down.Store(true)
	if err := m.syncCloudCredentials(context.Background()); err == nil {
		t.Fatal("syncCloudCredentials succeeded against a cloud that is down")
	}

	cloud.down.Store(false)
	for i, want := range [][]string{{validMachineToken}, nil} {
		if err := m.syncCloudCredentials(context.Background()); err != nil {
			t.Fatalf("poll %d after the outage: syncCloudCredentials: %v", i+1, err)
		}
		if got := cloud.takePresented(); !slices.Equal(got, want) {
			t.Errorf("poll %d after the outage: presented tokens = %q, want %q", i+1, got, want)
		}
	}
	if got, want := m.Account(), (Account{Email: "alice@example.com"}); got != want {
		t.Errorf("Account() = %+v, want %+v", got, want)
	}
}
