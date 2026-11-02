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
// reach for it — that it can show project files, and that the reply does not
// repeat what it showed — has to be seen before then too.
func TestGuidance_CarriesTheRenderingRulesNeededBeforeLoading(t *testing.T) {
	for _, want := range []string{
		"html_render",
		"tool search",
		"richer than Markdown",
		"project files",
		"Do not repeat",
	} {
		if !strings.Contains(renderingGuidance, want) {
			t.Errorf("the rendering guidance does not say %q", want)
		}
	}
}

// An HTML-first session has the same tools, so it keeps every asking rule
// above; what it changes is that a page, not the reply, is where anything
// structured goes. Those rules are what the session is for, and the tools they
// name are only names until loaded.
func TestHTMLFirstGuidance_KeepsAskingAndCarriesThePageRules(t *testing.T) {
	if !strings.HasPrefix(HTMLFirstGuidance, askingGuidance) {
		t.Error("the HTML-first guidance does not carry the asking guidance")
	}
	for _, want := range []string{
		"html_render",
		"html_edit",
		"html_get",
		"tool search",
		"choices, forms",
		"a sentence or two",
		"work by itself",
		"only when it needs you",
		"question_post",  // a page's choice does not replace asking a decision
		"320–1280px",     // a recommendation, not a rule:
		"wide by nature", // what may be drawn wide anyway
	} {
		if !strings.Contains(htmlFirstRenderingGuidance, want) {
			t.Errorf("the HTML-first rendering guidance does not say %q", want)
		}
	}
}

func TestGuidanceFor(t *testing.T) {
	if GuidanceFor(false) != Guidance {
		t.Error("a session that is not HTML-first does not get Guidance")
	}
	if GuidanceFor(true) != HTMLFirstGuidance {
		t.Error("an HTML-first session does not get HTMLFirstGuidance")
	}
}
