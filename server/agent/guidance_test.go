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
func TestGuidance_CarriesTheAskingRulesNeededBeforeLoading(t *testing.T) {
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
		if !strings.Contains(askingGuidance, want) {
			t.Errorf("the asking guidance does not say %q", want)
		}
	}
}

// html_render is only a name until loaded, like question_post, so when to
// reach for it — and that it does not replace Markdown or the reply — has to
// be seen before then too.
func TestGuidance_CarriesTheRenderingRulesNeededBeforeLoading(t *testing.T) {
	for _, want := range []string{
		"html_render",
		"tool search",
		"richer than Markdown",
		"Keep plain prose and code in Markdown",
		"Do not repeat",
	} {
		if !strings.Contains(renderingGuidance, want) {
			t.Errorf("the rendering guidance does not say %q", want)
		}
	}
}
