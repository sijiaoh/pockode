package claude

import (
	"reflect"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliauth"
)

// The outputs below are `claude auth status --json` from Claude Code 2.1.283,
// cut down to the fields that decide the answer; each was seen for real under the
// condition its name gives, unless its case says otherwise.
func TestParseAuthStatus(t *testing.T) {
	tests := []struct {
		name string
		res  agent.RunResult
		want cliauth.Status
	}{
		{
			"subscription",
			agent.RunResult{Stdout: `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"ada@example.com","orgName":"Ada's Org","subscriptionType":"max"}`},
			cliauth.Status{State: cliauth.StateSignedIn, Account: &cliauth.Account{Email: "ada@example.com", Organization: "Ada's Org", Plan: "max"}},
		},
		{
			// Exits 1 and still prints the JSON.
			"signed out",
			agent.RunResult{Stdout: `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`, ExitCode: 1},
			cliauth.Status{State: cliauth.StateSignedOut},
		},
		{
			"expired and could not be refreshed",
			agent.RunResult{Stdout: `{"loggedIn":false,"authMethod":"claude.ai","apiProvider":"firstParty"}`, ExitCode: 1},
			cliauth.Status{State: cliauth.StateSignedOut},
		},
		{
			"ANTHROPIC_API_KEY",
			agent.RunResult{Stdout: `{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}`},
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalAPIKey, Source: "ANTHROPIC_API_KEY"}},
		},
		{
			// A key `auth login --console` saved is a sign-in `auth logout` clears.
			// This one follows the CLI's own schema; it was not seen for real.
			"Console sign-in",
			agent.RunResult{Stdout: `{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"/login managed key","email":"ada@example.com"}`},
			cliauth.Status{State: cliauth.StateSignedIn, Account: &cliauth.Account{Email: "ada@example.com"}},
		},
		{
			"apiKeyHelper",
			agent.RunResult{Stdout: `{"loggedIn":true,"authMethod":"api_key_helper","apiProvider":"firstParty","apiKeySource":"apiKeyHelper"}`},
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalAPIKeyHelper, Source: "apiKeyHelper"}},
		},
		{
			"CLAUDE_CODE_OAUTH_TOKEN",
			agent.RunResult{Stdout: `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}`},
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalOAuthToken}},
		},
		{
			"Bedrock",
			agent.RunResult{Stdout: `{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}`},
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalCloudProvider, Provider: "bedrock"}},
		},
		{
			// A method a later version adds is still not a sign-in Pockode owns.
			"a method this version does not know",
			agent.RunResult{Stdout: `{"loggedIn":true,"authMethod":"workload_identity","apiProvider":"firstParty"}`},
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalOther, Method: "workload_identity"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseAuthStatus(tt.res)
			if err != nil {
				t.Fatalf("parseAuthStatus: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v (external %+v), want %+v (external %+v)", got, got.External, tt.want, tt.want.External)
			}
		})
	}
}

// Anything that is not the answer is an error, never a guess at "signed out".
func TestParseAuthStatus_Unreadable(t *testing.T) {
	tests := []struct {
		name    string
		res     agent.RunResult
		wantMsg string
	}{
		{"failed with a reason", agent.RunResult{Stderr: "Error: unknown option '--json'\n", ExitCode: 1}, "unknown option '--json'"},
		{"not JSON", agent.RunResult{Stdout: "Login method: Claude account\n"}, "did not print JSON"},
		{"JSON without the deciding fields", agent.RunResult{Stdout: `{"email":"ada@example.com"}`}, "did not report loggedIn and authMethod"},
		{"failed, with JSON that says nothing", agent.RunResult{Stdout: `{}`, Stderr: "Error: config is corrupt\n", ExitCode: 1}, "config is corrupt"},
		// The output is the JSON, which carries the account: never the reason,
		// because the reason is logged.
		{"failed silently", agent.RunResult{Stdout: `{"email":"ada@example.com"}`, ExitCode: 2}, "exit status 2"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseAuthStatus(tt.res)
			if err == nil || !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("got %v, want an error containing %q", err, tt.wantMsg)
			}
			if err != nil && strings.Contains(err.Error(), "ada@example.com") {
				t.Errorf("got %v, which carries the account into the log", err)
			}
		})
	}
}

func TestFailureReason(t *testing.T) {
	tests := []struct {
		name string
		res  agent.RunResult
		want string
	}{
		{"last stderr line", agent.RunResult{Stderr: "warning: something\nLogout failed: network down\n\n", ExitCode: 1}, "Logout failed: network down"},
		{"stdout when stderr is empty", agent.RunResult{Stdout: "Could not log out\n", ExitCode: 1}, "Could not log out"},
		{"exit status when silent", agent.RunResult{ExitCode: 2}, "exit status 2"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := failureReason(tt.res); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}
