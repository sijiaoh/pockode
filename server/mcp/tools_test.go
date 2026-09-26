package mcp

import (
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/work"
)

// A tool description is a prompt: it is the whole of what an agent knows about
// a status it never sees the code for. The retired names (in_progress,
// needs_input as a *status*, waiting) described a work model that no longer
// exists, so finding one here means an agent is being taught it.
func TestToolDefinitions_DoNotTeachTheRetiredStatuses(t *testing.T) {
	for _, def := range toolDefinitions {
		text := def.Description
		for _, prop := range def.InputSchema.Properties {
			text += " " + prop.Description
		}
		for _, retired := range []string{"in_progress", "needs_input state", "status waiting"} {
			if strings.Contains(text, retired) {
				t.Errorf("%s still describes the retired status %q", def.Name, retired)
			}
		}
	}
}

// The listings hand the agent raw status values, and their descriptions are the
// only glossary for them. Read off the constants so a fifth status cannot be
// added without those sentences being extended.
func TestToolDefinitions_ListingsExplainEveryStatusTheyReturn(t *testing.T) {
	for _, tool := range []string{"story_list", "task_list"} {
		var listDesc string
		for _, def := range toolDefinitions {
			if def.Name == tool {
				listDesc = def.Description
			}
		}
		if listDesc == "" {
			t.Fatalf("%s is not defined", tool)
		}

		for _, status := range []work.WorkStatus{
			work.StatusOpen, work.StatusActive, work.StatusStopped, work.StatusClosed,
		} {
			if !strings.Contains(listDesc, string(status)) {
				t.Errorf("%s's description does not explain the status %q", tool, status)
			}
		}
	}
}

// The point of splitting a tool in two is that the *schema* states the fork, so
// an agent never has to learn it from a runtime refusal. That is a claim about
// which arguments exist on which tool, and nothing else in this package asserts
// it: give task_start a worktree property, or task_create's story_id to
// story_create, and every other test stays green while the split has quietly
// stopped being worth having.
func TestToolDefinitions_TheSchemasStateTheFork(t *testing.T) {
	defined := map[string]toolDefinition{}
	for _, def := range toolDefinitions {
		defined[def.Name] = def
	}

	for _, c := range []struct {
		tool     string
		property string
		want     bool
		required bool
	}{
		// Only a story chooses a worktree; a task inherits its story's.
		{tool: "story_start", property: "worktree", want: true},
		{tool: "task_start", property: "worktree", want: false},
		// Naming a story is the whole of what makes a task, so task_create
		// cannot be called without one and story_create has nowhere to put one.
		{tool: "task_create", property: "story_id", want: true, required: true},
		{tool: "story_create", property: "story_id", want: false},
		// The same fork, for the listings.
		{tool: "task_list", property: "story_id", want: true, required: true},
		{tool: "story_list", property: "story_id", want: false},
	} {
		def, ok := defined[c.tool]
		if !ok {
			t.Errorf("%s is not defined", c.tool)
			continue
		}
		if _, has := def.InputSchema.Properties[c.property]; has != c.want {
			t.Errorf("%s: has property %q = %v, want %v", c.tool, c.property, has, c.want)
		}
		if c.required && !slices.Contains(def.InputSchema.Required, c.property) {
			t.Errorf("%s: %q is not required, so the call can be made without the one argument that decides what it does", c.tool, c.property)
		}
	}
}

// The two refusals about subtasks (docs/lifecycle-ui.md §7) are rules an agent
// only ever reads in a tool description; nothing else tells it before it hits
// one. So each description has to announce its own rejection, and — because the
// two gates are exactly complementary — name the other tool as the way out. A
// description that stopped doing either would send the agent into a refusal it
// was never warned about, which no test of the refusal itself would catch.
func TestToolDefinitions_BothSubtaskRefusalsAreAnnounced(t *testing.T) {
	descriptions := map[string]string{}
	for _, def := range toolDefinitions {
		descriptions[def.Name] = strings.ToLower(def.Description)
	}

	for _, c := range []struct{ tool, wayOut string }{
		{tool: "step_done", wayOut: "story_wait"},
		{tool: "story_wait", wayOut: "question_post"},
	} {
		desc, ok := descriptions[c.tool]
		if !ok {
			t.Fatalf("%s is not defined", c.tool)
		}
		if !strings.Contains(desc, "reject") {
			t.Errorf("%s does not say it can be rejected", c.tool)
		}
		if !strings.Contains(desc, c.wayOut) {
			t.Errorf("%s does not name %s as a way out", c.tool, c.wayOut)
		}
	}
}
