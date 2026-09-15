package codex

import "testing"

// The guard reads `codex --help`, and the one thing it must not do is match the
// word anywhere in the text: the neighbouring entries describe app-server in
// their own prose.
func TestListsAppServer(t *testing.T) {
	// Verbatim from codex-cli 0.153.0, trimmed to the lines that matter.
	const withAppServer = `Commands:
  mcp-server        Start Codex as an MCP server (stdio)
  app-server        [experimental] Run the app server or related tooling
  remote-control    [experimental] Manage the app-server daemon with remote control enabled
`
	const withoutAppServer = `Commands:
  mcp-server        Start Codex as an MCP server (stdio)
  remote-control    [experimental] Manage the app-server daemon with remote control enabled
`

	tests := []struct {
		name string
		help string
		want bool
	}{
		{"app-server offered", withAppServer, true},
		{"only named in another entry's description", withoutAppServer, false},
		{"empty", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := listsAppServer(tt.help); got != tt.want {
				t.Errorf("listsAppServer() = %v, want %v", got, tt.want)
			}
		})
	}
}
