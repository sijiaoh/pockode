package serverinfo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
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
