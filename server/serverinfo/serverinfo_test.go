package serverinfo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pockode/server/internal/fspermtest"
)

func TestWriteAndDelete(t *testing.T) {
	dir := t.TempDir()

	if err := Write(dir, 9870, "http://localhost:9870", "https://test.cloud.pockode.com", "test-token"); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, filename))
	if err != nil {
		t.Fatalf("failed to read server.json: %v", err)
	}

	var info Info
	if err := json.Unmarshal(data, &info); err != nil {
		t.Fatalf("failed to parse server.json: %v", err)
	}

	if info.Port != 9870 {
		t.Errorf("Port = %d, want 9870", info.Port)
	}
	if info.PID != os.Getpid() {
		t.Errorf("PID = %d, want %d", info.PID, os.Getpid())
	}
	if info.StartedAt == "" {
		t.Error("StartedAt is empty")
	}
	if _, err := time.Parse(time.RFC3339, info.StartedAt); err != nil {
		t.Errorf("StartedAt is not valid RFC3339: %v", err)
	}
	if info.LocalURL != "http://localhost:9870" {
		t.Errorf("LocalURL = %q, want %q", info.LocalURL, "http://localhost:9870")
	}
	if info.RemoteURL != "https://test.cloud.pockode.com" {
		t.Errorf("RemoteURL = %q, want %q", info.RemoteURL, "https://test.cloud.pockode.com")
	}
	if info.Token != "test-token" {
		t.Errorf("Token = %q, want %q", info.Token, "test-token")
	}

	if err := Delete(dir); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, filename)); !os.IsNotExist(err) {
		t.Error("server.json still exists after Delete")
	}
}

func TestDeleteNonExistent(t *testing.T) {
	dir := t.TempDir()

	if err := Delete(dir); err != nil {
		t.Errorf("Delete on non-existent file should return nil, got: %v", err)
	}
}

func TestWriteCreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "dir")

	if err := Write(dir, 8080, "http://localhost:8080", "", ""); err != nil {
		t.Fatalf("Write failed to create directory: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, filename)); err != nil {
		t.Errorf("server.json not created: %v", err)
	}
}

// server.json carries the MCP local API token, so Write has to leave the file
// and its directory out of reach of other local users. On Windows only the
// directory's ACL delivers that; the 0600 there is inert.
func TestWriteRestrictsTokenFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", ".pockode")

	if err := Write(dir, 9870, "http://localhost:9870", "", "secret-token"); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	fspermtest.RequireOwnerOnly(t, dir)
	fspermtest.RequireOwnerOnly(t, filepath.Join(dir, filename))
}

// A world-readable server.json and a world-readable directory can both be left
// behind by an installation that predates the restriction; starting the server
// again has to close them rather than write into them as they are.
func TestWriteRestrictsWhatAnEarlierRunLeftOpen(t *testing.T) {
	dir := filepath.Join(t.TempDir(), ".pockode")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, filename), []byte("{}"), 0644); err != nil {
		t.Fatalf("seed stale file: %v", err)
	}

	if err := Write(dir, 9870, "", "", "secret-token"); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	fspermtest.RequireOwnerOnly(t, dir)
	fspermtest.RequireOwnerOnly(t, filepath.Join(dir, filename))
}

func TestRead(t *testing.T) {
	dir := t.TempDir()

	// Write first
	if err := Write(dir, 9870, "http://localhost:9870", "", ""); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	// Read it back
	info, err := Read(dir)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if info == nil {
		t.Fatal("Read returned nil info")
	}
	if info.Port != 9870 {
		t.Errorf("Port = %d, want 9870", info.Port)
	}
	if info.PID != os.Getpid() {
		t.Errorf("PID = %d, want %d", info.PID, os.Getpid())
	}
	if info.LocalURL != "http://localhost:9870" {
		t.Errorf("LocalURL = %q, want %q", info.LocalURL, "http://localhost:9870")
	}
	if info.RemoteURL != "" {
		t.Errorf("RemoteURL = %q, want empty", info.RemoteURL)
	}
}

func TestReadNonExistent(t *testing.T) {
	dir := t.TempDir()

	info, err := Read(dir)
	if err != nil {
		t.Errorf("Read on non-existent file should return nil error, got: %v", err)
	}
	if info != nil {
		t.Errorf("Read on non-existent file should return nil info, got: %+v", info)
	}
}

func TestReadInvalidJSON(t *testing.T) {
	dir := t.TempDir()

	// Write invalid JSON
	if err := os.WriteFile(filepath.Join(dir, filename), []byte("not json"), 0644); err != nil {
		t.Fatalf("failed to write invalid JSON: %v", err)
	}

	info, err := Read(dir)
	if err == nil {
		t.Error("Read on invalid JSON should return error")
	}
	if info != nil {
		t.Errorf("Read on invalid JSON should return nil info, got: %+v", info)
	}
}

func TestWriteOmitsEmptyURLs(t *testing.T) {
	dir := t.TempDir()

	if err := Write(dir, 9870, "", "", ""); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, filename))
	if err != nil {
		t.Fatalf("failed to read server.json: %v", err)
	}

	// Verify omitempty works: empty URL fields should not appear in JSON
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("failed to parse server.json: %v", err)
	}

	if _, exists := raw["local_url"]; exists {
		t.Error("local_url should be omitted when empty")
	}
	if _, exists := raw["remote_url"]; exists {
		t.Error("remote_url should be omitted when empty")
	}
}

// Refresh before Publish must not write: server.json is how a cluster finds a
// server, and it may act on the file the moment it appears. Publish then reads
// the URL itself, so a change that came first is not lost.
func TestPublisherRefreshWaitsForPublish(t *testing.T) {
	dir := t.TempDir()
	remoteURL := "https://old.cloud.pockode.com"
	p := NewPublisher(dir, 9870, "http://localhost:9870", "token", func() string { return remoteURL })

	remoteURL = "https://new.cloud.pockode.com"
	if err := p.Refresh(); err != nil {
		t.Fatalf("Refresh failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, filename)); !os.IsNotExist(err) {
		t.Fatalf("server.json exists before Publish (stat error: %v)", err)
	}

	if err := p.Publish(); err != nil {
		t.Fatalf("Publish failed: %v", err)
	}
	info, err := Read(dir)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	if info.RemoteURL != remoteURL {
		t.Errorf("RemoteURL = %q, want %q", info.RemoteURL, remoteURL)
	}
}

// A remote URL that changes mid-run replaces the published one and nothing
// else: the cluster reports started_at as the node's start time.
func TestPublisherRefreshRewritesTheRemoteURL(t *testing.T) {
	dir := t.TempDir()
	remoteURL := "https://old.cloud.pockode.com"
	p := NewPublisher(dir, 9870, "http://localhost:9870", "token", func() string { return remoteURL })
	// started_at has one-second resolution, so a write that restamped it would
	// almost always go unnoticed against the real clock.
	const startedAt = "2000-01-01T00:00:00Z"
	p.info.StartedAt = startedAt
	if err := p.Publish(); err != nil {
		t.Fatalf("Publish failed: %v", err)
	}
	before, err := Read(dir)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}

	remoteURL = "https://new.cloud.pockode.com"
	if err := p.Refresh(); err != nil {
		t.Fatalf("Refresh failed: %v", err)
	}

	after, err := Read(dir)
	if err != nil {
		t.Fatalf("Read failed: %v", err)
	}
	want := *before
	want.StartedAt = startedAt
	want.RemoteURL = remoteURL
	if *after != want {
		t.Errorf("server.json = %+v, want %+v", *after, want)
	}
}
