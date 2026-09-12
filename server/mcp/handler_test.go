package mcp

import (
	"testing"

	"github.com/pockode/server/apiroute"
)

// The local MCP API is only safe to expose because it never leaves this
// machine, and what enforces that is a path check in the relay's local proxy.
// Moving APIPath out from under that check would open the tools this server can
// run to anyone who reaches its public URL, with nothing else failing.
func TestAPIPathStaysLocalOnly(t *testing.T) {
	if !apiroute.IsLocalOnly(APIPath) {
		t.Fatalf("apiroute.IsLocalOnly(%q) = false; the relay would forward the local MCP API", APIPath)
	}
}
