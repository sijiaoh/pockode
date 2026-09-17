package mcp

import (
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

// work_list hands the agent raw status values, and its description is the only
// glossary for them. Read off the constants so a fifth status cannot be added
// without this sentence being extended.
func TestToolDefinitions_WorkListExplainsEveryStatusItReturns(t *testing.T) {
	var listDesc string
	for _, def := range toolDefinitions {
		if def.Name == "work_list" {
			listDesc = def.Description
		}
	}
	if listDesc == "" {
		t.Fatal("work_list is not defined")
	}

	for _, status := range []work.WorkStatus{
		work.StatusOpen, work.StatusActive, work.StatusStopped, work.StatusClosed,
	} {
		if !strings.Contains(listDesc, string(status)) {
			t.Errorf("work_list's description does not explain the status %q", status)
		}
	}
}

// The one piece of guidance the redesign exists to give: a long wait belongs to
// the work, not to a question holding a process open.
func TestToolDefinitions_NeedsInputIsOfferedInsteadOfABlockingQuestion(t *testing.T) {
	for _, def := range toolDefinitions {
		if def.Name != "work_needs_input" {
			continue
		}
		if !strings.Contains(def.Description, "AskUserQuestion") {
			t.Error("work_needs_input does not say what it is preferred over")
		}
		if !strings.Contains(strings.ToLower(def.InputSchema.Properties["reason"].Description), "shown") {
			t.Error("the reason does not say it is shown to the user")
		}
		return
	}
	t.Fatal("work_needs_input is not defined")
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
		{tool: "step_done", wayOut: "work_wait"},
		{tool: "work_wait", wayOut: "work_needs_input"},
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
