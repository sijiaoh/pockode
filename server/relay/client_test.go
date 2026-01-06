package relay

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClient_Register(t *testing.T) {
	tests := []struct {
		name       string
		response   *StoredConfig
		statusCode int
		wantErr    bool
	}{
		{
			name: "successful registration",
			response: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayToken:  "test_token_abc123",
				RelayServer: "cloud.pockode.com",
			},
			statusCode: http.StatusCreated,
			wantErr:    false,
		},
		{
			name:       "server error",
			response:   nil,
			statusCode: http.StatusInternalServerError,
			wantErr:    true,
		},
		{
			name:       "not found",
			response:   nil,
			statusCode: http.StatusNotFound,
			wantErr:    true,
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
			cfg, err := client.Register(context.Background())

			if (err != nil) != tt.wantErr {
				t.Errorf("Register() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if tt.wantErr {
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

func TestClient_RegisterContextCancelled(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Slow response to test context cancellation
		<-r.Context().Done()
	}))
	defer server.Close()

	client := NewClient(server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately

	_, err := client.Register(ctx)
	if err == nil {
		t.Error("Register() with cancelled context should return error")
	}
}
