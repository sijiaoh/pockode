package relay

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// errAny is a sentinel error used in tests to indicate any non-nil error is acceptable.
var errAny = errors.New("any error")

func TestClient_Register(t *testing.T) {
	tests := []struct {
		name       string
		response   *StoredConfig
		statusCode int
		wantErr    error
	}{
		{
			name: "successful registration",
			response: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayToken:  "test_token_abc123",
				RelayServer: "cloud.pockode.com",
			},
			statusCode: http.StatusCreated,
			wantErr:    nil,
		},
		{
			name:       "forbidden returns upgrade required",
			response:   nil,
			statusCode: http.StatusForbidden,
			wantErr:    ErrUpgradeRequired,
		},
		{
			name:       "server error",
			response:   nil,
			statusCode: http.StatusInternalServerError,
			wantErr:    errAny,
		},
		{
			name:       "not found",
			response:   nil,
			statusCode: http.StatusNotFound,
			wantErr:    errAny,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost {
					t.Errorf("Method = %v, want POST", r.Method)
				}
				if r.URL.Path != "/api/relay/register" {
					t.Errorf("Path = %v, want /api/relay/register", r.URL.Path)
				}

				w.WriteHeader(tt.statusCode)
				if tt.response != nil {
					json.NewEncoder(w).Encode(tt.response)
				}
			}))
			defer server.Close()

			client := NewClient(server.URL)
			cfg, err := client.Register(context.Background(), nil)

			if tt.wantErr == nil {
				if err != nil {
					t.Errorf("Register() error = %v, want nil", err)
					return
				}
			} else if tt.wantErr == errAny {
				if err == nil {
					t.Errorf("Register() error = nil, want non-nil")
					return
				}
			} else {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("Register() error = %v, want %v", err, tt.wantErr)
					return
				}
			}

			if tt.wantErr != nil {
				return
			}

			if cfg.Subdomain != tt.response.Subdomain {
				t.Errorf("Subdomain = %v, want %v", cfg.Subdomain, tt.response.Subdomain)
			}
			if cfg.RelayToken != tt.response.RelayToken {
				t.Errorf("RelayToken = %v, want %v", cfg.RelayToken, tt.response.RelayToken)
			}
			if cfg.RelayServer != tt.response.RelayServer {
				t.Errorf("RelayServer = %v, want %v", cfg.RelayServer, tt.response.RelayServer)
			}
		})
	}
}

func TestClient_GetAnnouncement(t *testing.T) {
	tests := []struct {
		name        string
		message     string
		statusCode  int
		wantMessage string
	}{
		{
			name:        "successful with message",
			message:     "Update available",
			statusCode:  http.StatusOK,
			wantMessage: "Update available",
		},
		{
			name:        "successful with empty message",
			message:     "",
			statusCode:  http.StatusOK,
			wantMessage: "",
		},
		{
			name:        "server error returns empty",
			message:     "",
			statusCode:  http.StatusInternalServerError,
			wantMessage: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet {
					t.Errorf("Method = %v, want GET", r.Method)
				}
				if r.URL.Path != "/api/announcement" {
					t.Errorf("Path = %v, want /api/announcement", r.URL.Path)
				}

				w.WriteHeader(tt.statusCode)
				if tt.statusCode == http.StatusOK {
					json.NewEncoder(w).Encode(map[string]string{"message": tt.message})
				}
			}))
			defer server.Close()

			client := NewClient(server.URL)
			msg := client.GetAnnouncement(context.Background())

			if msg != tt.wantMessage {
				t.Errorf("Message = %v, want %v", msg, tt.wantMessage)
			}
		})
	}
}

func TestClient_RegisterContextCancelled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Slow response to test context cancellation
		<-r.Context().Done()
	}))
	defer server.Close()

	client := NewClient(server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	_, err := client.Register(ctx, nil)
	if err == nil {
		t.Error("Register() with cancelled context should return error")
	}
}

func TestClient_Refresh(t *testing.T) {
	tests := []struct {
		name       string
		response   *StoredConfig
		statusCode int
		wantErr    error
	}{
		{
			name: "successful refresh",
			response: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayToken:  "test_token_abc123",
				RelayServer: "cloud.pockode.com",
			},
			statusCode: http.StatusOK,
			wantErr:    nil,
		},
		{
			name:       "forbidden returns upgrade required",
			response:   nil,
			statusCode: http.StatusForbidden,
			wantErr:    ErrUpgradeRequired,
		},
		{
			name:       "unauthorized returns invalid token",
			response:   nil,
			statusCode: http.StatusUnauthorized,
			wantErr:    ErrInvalidToken,
		},
		{
			name:       "server error",
			response:   nil,
			statusCode: http.StatusInternalServerError,
			wantErr:    errAny,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost {
					t.Errorf("Method = %v, want POST", r.Method)
				}
				if r.URL.Path != "/api/relay/refresh" {
					t.Errorf("Path = %v, want /api/relay/refresh", r.URL.Path)
				}

				w.WriteHeader(tt.statusCode)
				if tt.response != nil {
					json.NewEncoder(w).Encode(tt.response)
				}
			}))
			defer server.Close()

			client := NewClient(server.URL)
			cfg, err := client.Refresh(context.Background(), "test_token", nil)

			if tt.wantErr == nil {
				if err != nil {
					t.Errorf("Refresh() error = %v, want nil", err)
					return
				}
			} else if tt.wantErr == errAny {
				if err == nil {
					t.Errorf("Refresh() error = nil, want non-nil")
					return
				}
			} else {
				if !errors.Is(err, tt.wantErr) {
					t.Errorf("Refresh() error = %v, want %v", err, tt.wantErr)
					return
				}
			}

			if tt.wantErr != nil {
				return
			}

			if cfg.Subdomain != tt.response.Subdomain {
				t.Errorf("Subdomain = %v, want %v", cfg.Subdomain, tt.response.Subdomain)
			}
		})
	}
}

// A guest's request bodies are exactly what they were before accounts existed,
// so the cloud cannot tell a guest from a Pockode that predates them; an
// attached relay adds the machine token and the instance, nothing else.
func TestClientRequestBodies(t *testing.T) {
	attach := &Attachment{
		MachineToken: "machine-token",
		Instance:     Instance{Kind: InstanceNode, Name: "app", Path: "/home/alice/app"},
	}
	attachFields := `"machine_token":"machine-token","instance":{"kind":"node","name":"app","path":"/home/alice/app"}`

	tests := []struct {
		name string
		call func(*Client) error
		want string
	}{
		{
			name: "guest register",
			call: func(c *Client) error { _, err := c.Register(context.Background(), nil); return err },
			want: `{"client_version":"v1.2.3"}`,
		},
		{
			name: "guest refresh",
			call: func(c *Client) error { _, err := c.Refresh(context.Background(), "relay-token", nil); return err },
			want: `{"relay_token":"relay-token","client_version":"v1.2.3"}`,
		},
		{
			name: "attached register",
			call: func(c *Client) error { _, err := c.Register(context.Background(), attach); return err },
			want: `{"client_version":"v1.2.3",` + attachFields + `}`,
		},
		{
			name: "attached refresh",
			call: func(c *Client) error { _, err := c.Refresh(context.Background(), "relay-token", attach); return err },
			want: `{"relay_token":"relay-token","client_version":"v1.2.3",` + attachFields + `}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []byte
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got, _ = io.ReadAll(r.Body)
				if r.URL.Path == "/api/relay/register" {
					w.WriteHeader(http.StatusCreated)
				}
				w.Write([]byte(`{}`))
			}))
			defer server.Close()

			if err := tt.call(NewClientWithVersion(server.URL, "v1.2.3")); err != nil {
				t.Fatalf("request failed: %v", err)
			}
			if string(got) != tt.want {
				t.Errorf("body = %s\nwant   %s", got, tt.want)
			}
		})
	}
}
