package mcp

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// toolLikeName matches what the prompts name as a tool or as a tool's argument:
// every Pockode tool is prefixed by what it acts on.
var toolLikeName = regexp.MustCompile(`\b(?:work|story|task|step|question|agent_role)_[a-z_]*[a-z]\b`)

// prompts.yaml is the other half of the tool contract: it is where an agent is
// told which tool to call, and it is read from a different package than the one
// that defines the tools, so a rename on one side compiles fine without the
// other. Every name it uses has to be a tool that is listed and not retired, or
// an argument one of those tools takes — a prompt pointing at a retired stub
// costs the agent a refused call on every message, and one pointing at a name
// no tool has costs it an "unknown tool". (Only names carrying a tool prefix are
// seen; a misspelt prefix is not.)
//
// Read from the file rather than from the builders because the file is the
// whole of the text; the builders only choose between its sections.
func TestPrompts_NameOnlyLiveTools(t *testing.T) {
	data, err := os.ReadFile("../work/prompts.yaml")
	if err != nil {
		t.Fatalf("read prompts: %v", err)
	}
	// Values only: the keys (story_behavior_rules, task_rules, ...) and the
	// comments are not read by any agent.
	var templates map[string]string
	if err := yaml.Unmarshal(data, &templates); err != nil {
		t.Fatalf("parse prompts: %v", err)
	}

	live := map[string]bool{}
	retired := map[string]bool{}
	for _, def := range toolDefinitions {
		if strings.HasPrefix(def.Description, "Retired") {
			retired[def.Name] = true
			continue
		}
		live[def.Name] = true
		for arg := range def.InputSchema.Properties {
			live[arg] = true
		}
	}
	if len(retired) == 0 {
		t.Fatal("no tool reads as retired; the check below would pass vacuously")
	}

	for key, text := range templates {
		for _, name := range toolLikeName.FindAllString(text, -1) {
			switch {
			case retired[name]:
				t.Errorf("%s tells the agent to use %s, which is retired", key, name)
			case !live[name]:
				t.Errorf("%s names %s, which is neither a tool nor an argument of one", key, name)
			}
		}
	}
}
