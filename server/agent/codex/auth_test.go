package codex

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/pockode/server/cliauth"
)

// The answers below are account/read's, as codex-cli 0.153.0 gives them; the
// chatgpt, signed-out and no-OpenAI-auth ones were each seen for real, the rest
// follow the generated schema.
func TestParseAccount(t *testing.T) {
	tests := []struct {
		name   string
		result string
		want   cliauth.Status
	}{
		{
			"ChatGPT",
			`{"account":{"type":"chatgpt","email":"ada@example.com","planType":"plus"},"requiresOpenaiAuth":true}`,
			cliauth.Status{State: cliauth.StateSignedIn, Account: &cliauth.Account{Email: "ada@example.com", Plan: "plus"}},
		},
		{
			"ChatGPT with no plan to name",
			`{"account":{"type":"chatgpt","email":null,"planType":"unknown"},"requiresOpenaiAuth":true}`,
			cliauth.Status{State: cliauth.StateSignedIn, Account: &cliauth.Account{}},
		},
		{
			"signed out",
			`{"account":null,"requiresOpenaiAuth":true}`,
			cliauth.Status{State: cliauth.StateSignedOut},
		},
		{
			"API key",
			`{"account":{"type":"apiKey"},"requiresOpenaiAuth":true}`,
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalAPIKey}},
		},
		{
			"Bedrock",
			`{"account":{"type":"amazonBedrock","usesCodexManagedCredentials":false},"requiresOpenaiAuth":true}`,
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalCloudProvider, Provider: "bedrock"}},
		},
		{
			// model_provider set to one that needs no OpenAI sign-in: whatever
			// account is stored, sessions do not use it.
			"provider without OpenAI auth",
			`{"account":{"type":"chatgpt","email":"ada@example.com","planType":"plus"},"requiresOpenaiAuth":false}`,
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalNoSignInNeeded}},
		},
		{
			"an account type this version does not know",
			`{"account":{"type":"agentIdentity"},"requiresOpenaiAuth":true}`,
			cliauth.Status{State: cliauth.StateExternal, External: &cliauth.External{Kind: cliauth.ExternalOther, Method: "agentIdentity"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseAccount(json.RawMessage(tt.result))
			if err != nil {
				t.Fatalf("parseAccount: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestParseAccount_Unreadable(t *testing.T) {
	for _, result := range []string{`{"account":null}`, `[]`} {
		if _, err := parseAccount(json.RawMessage(result)); err == nil {
			t.Errorf("%s: got no error, want one rather than a guess", result)
		}
	}
}

func TestCallError(t *testing.T) {
	err := callError("account/read", &rpcError{Code: methodNotFound, Message: "method not found"})
	if !strings.Contains(err.Error(), "update codex") {
		t.Errorf("method not found: got %q, want it to point at updating codex", err)
	}

	err = callError("account/logout", &rpcError{Code: -32600, Message: "failed to remove auth.json"})
	if !strings.Contains(err.Error(), "failed to remove auth.json") {
		t.Errorf("other errors: got %q, want the app-server's own message", err)
	}
}
