package mcp

import (
	"flag"
	"testing"
)

// The spawning agents write these flags into the CLI's MCP config; a proxy that
// did not know one would exit on it, and the session would come up with no
// Pockode tools at all.
func TestParseProxyArgs_TheFlagsTheAgentsWrite(t *testing.T) {
	got, err := parseProxyArgs([]string{"--data-dir", "/d", "--session-id", "s1", "--worktree", "feature-x"}, flag.ContinueOnError)
	if err != nil {
		t.Fatalf("parseProxyArgs: %v", err)
	}
	want := proxyArgs{dataDir: "/d", caller: Caller{SessionID: "s1", Worktree: "feature-x"}}
	if got != want {
		t.Errorf("parsed %+v, want %+v", got, want)
	}
}

func TestParseProxyArgs_RequiresDataDir(t *testing.T) {
	if _, err := parseProxyArgs(nil, flag.ContinueOnError); err == nil {
		t.Error("parsed without --data-dir")
	}
}
