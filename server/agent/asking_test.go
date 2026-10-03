package agent

import (
	"strings"
	"testing"
)

// These are the rules an agent breaks before it has any reason to load
// question_post — found by the question eval, where no agent that could not see
// them called it once: it asked in the reply text, wrote the options out there,
// asked for an API key in the chat, or did not ask at all — or asked one of a
// step's decisions and quietly took the rest, which a rule in the tool's own
// description did not prevent. Each has to be in the text every session sees
// from its first turn.
func TestAskingGuidance_CarriesTheRulesNeededBeforeLoading(t *testing.T) {
	for _, want := range []string{
		"question_post",
		"tool search",             // the tool is only a name until loaded
		"does not reach the user", // the CLI's own ask tool
		"reply text",
		"multiple-choice",
		"together, in one question_post call",
		"quietly decide the rest",
		"passwords, tokens or API keys",
	} {
		if !strings.Contains(AskingGuidance, want) {
			t.Errorf("AskingGuidance does not say %q", want)
		}
	}
}
