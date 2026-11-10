// Package cloudlinktest is a cloud that serves the start of a device flow and
// accepts every revoke, for testing what serves package cloudlogin to a
// client. How the flow goes on from there, and what is revoked, is
// cloudlogin's own tests' business.
package cloudlinktest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const (
	// DeviceCode is what the cloud hands out alongside UserCode. It must never
	// reach a client.
	DeviceCode      = "device-code-never-sent-to-a-client"
	UserCode        = "ABCD-EFGH"
	VerificationURL = "https://cloud.example/device?code=" + UserCode
	expiresIn       = 600
	// pollInterval is long enough that no test gets to a poll: a flow waits
	// for the user until it is cancelled.
	pollInterval = 3600
)

type Cloud struct {
	URL string
}

// New serves until the test ends. Start it before the service that uses it,
// so that the service is closed first.
func New(t *testing.T) *Cloud {
	t.Helper()
	c := &Cloud{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/device/authorize", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"device_code":               DeviceCode,
			"user_code":                 UserCode,
			"verification_uri_complete": VerificationURL,
			"interval":                  pollInterval,
			"expires_in":                expiresIn,
		})
	})
	mux.HandleFunc("POST /api/machine/revoke", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	c.URL = server.URL
	return c
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
