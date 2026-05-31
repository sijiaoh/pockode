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

	if err := Write(dir, 9870); err != nil {
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

	if err := Write(dir, 8080); err != nil {
		t.Fatalf("Write failed to create directory: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir, filename)); err != nil {
		t.Errorf("server.json not created: %v", err)
	}
}
