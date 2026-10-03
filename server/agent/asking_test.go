package agent

import (
	"strings"
	"testing"
)

// These are the rules an agent breaks before it has any reason to load
// question_post — found by the question eval, where no agent that could not see
// them called it once: it asked in the reply text, wrote the options out there,
// asked for an API key in the chat, or did not ask at all. Each has to be in the
// text every session sees from its first turn.
func TestAskingGuidance_CarriesTheRulesNeededBeforeLoading(t *testing.T) {
	for _, want := range []string{
		"question_post",
		"tool search",             // the tool is only a name until loaded
		"does not reach the user", // the CLI's own ask tool
		"reply text",
		"multiple-choice",
		"passwords, tokens or API keys",
	} {
		if !strings.Contains(AskingGuidance, want) {
			t.Errorf("AskingGuidance does not say %q", want)
		}
	}
}
