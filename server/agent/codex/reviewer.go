package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/pockode/server/agent"
)

// A permission reviewer runs in a directory of its own outside the project
// (process.Manager), which is what keeps the project's AGENTS.md, its
// `.codex/` config layer and its hooks away from it. Two things that directory
// cannot do are done here, both measured on codex-cli 0.169.0 against a local
// fake provider:
//
//   - project_doc_max_bytes = 0 stops AGENTS.md discovery altogether. Without
//     it a reviewer directory that ended up inside some git repository would
//     have Codex read every AGENTS.md from that repository's root down.
//   - Pockode's own server has its tools approved up front
//     (default_tools_approval_mode = "approve", a typed key that 0.169.0
//     validates): under on-request, Codex may ask before an MCP tool call, and
//     Pockode denies whatever a reviewer asks for itself, which would leave it
//     unable ever to give a verdict. Claude's --allowedTools does the same job.
//     The proxy offers permission_verdict alone, so nothing else is approved.
//   - The user's MCP servers are switched off one by one. A thread's config
//     overrides are merged into the user's config.toml rather than replacing
//     it, so naming Pockode's server alone leaves theirs in place;
//     `enabled = false` on each of theirs is what drops their tools.
//
// What remains is the user's own CODEX_HOME/AGENTS.md, which Codex reads
// whatever the working directory and has no setting to skip, and their own
// hooks (docs/unattended-mode.md).

// reviewerConfigOverrides adds a reviewer's isolation to a thread's config
// overrides. hidden are the user's MCP servers, read by readUserMCPServers.
func reviewerConfigOverrides(overrides map[string]interface{}, hidden []string) {
	overrides["project_doc_max_bytes"] = 0
	servers, _ := overrides["mcp_servers"].(map[string]interface{})
	if ours, ok := servers[agent.MCPServerName].(map[string]interface{}); ok {
		ours["default_tools_approval_mode"] = "approve"
	}
	if len(hidden) == 0 {
		return
	}
	if servers == nil {
		servers = map[string]interface{}{}
		overrides["mcp_servers"] = servers
	}
	for _, name := range hidden {
		// Pockode's own, when the user's config names one too: the
		// override already sets it.
		if _, ours := servers[name]; ours {
			continue
		}
		servers[name] = map[string]interface{}{"enabled": false}
	}
}

// readUserMCPServers asks Codex for the names of the MCP servers its config
// layers resolve to in this working directory, sorted so that the overrides
// sent are the same from one launch to the next.
func (s *appSession) readUserMCPServers(ctx context.Context) ([]string, error) {
	result, err := s.sendRPC(ctx, "config/read", map[string]interface{}{"cwd": s.opts.WorkDir})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Config struct {
			MCPServers map[string]json.RawMessage `json:"mcp_servers"`
		} `json:"config"`
	}
	if err := json.Unmarshal(result, &parsed); err != nil {
		return nil, fmt.Errorf("parse config/read reply: %w", err)
	}
	names := make([]string, 0, len(parsed.Config.MCPServers))
	for name := range parsed.Config.MCPServers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
