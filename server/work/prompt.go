package work

import (
	"bytes"
	_ "embed"
	"strconv"
	"strings"
	"sync"
	"text/template"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
	"gopkg.in/yaml.v3"
)

// Message subtypes identify which system-driven prompt produced a message.
// The frontend maps these to display labels (Kickoff, Restart, ...).
const (
	MessageSubtypeKickoff      = "kickoff"
	MessageSubtypeRestart      = "restart"
	MessageSubtypeAutoContinue = "auto_continue"
	MessageSubtypeStepAdvance  = "step_advance"
	MessageSubtypeReopen       = "reopen"
	MessageSubtypeChildDone    = "child_done"
	// MessageSubtypeWaitStranded is the counterpart of child_done for the case
	// where nothing is going to close: the parent's wait on its subtasks has
	// nothing left that could end it.
	MessageSubtypeWaitStranded = "wait_stranded"
)

// NewMessageMeta builds the summary metadata for a system message.
//
// w is the *receiving* work — the one whose session the message is delivered
// to, which is not always the work the message talks about (see
// agent.MessageMeta.WorkID). step is 1-indexed; pass total <= 0 to omit step
// info (e.g. stepless works).
func NewMessageMeta(w Work, step, total int) *agent.MessageMeta {
	meta := &agent.MessageMeta{
		WorkID:   w.ID,
		WorkType: string(w.Type),
		Title:    w.Title,
	}
	if total > 0 && step >= 1 && step <= total {
		meta.Step = &agent.StepInfo{Current: step, Total: total}
	}
	return meta
}

//go:embed prompts.yaml
var promptsYAML []byte

// promptTemplates holds parsed templates from prompts.yaml.
type promptTemplates struct {
	PockodeMCPPrefix       string `yaml:"pockode_mcp_prefix"`
	RoleReference          string `yaml:"role_reference"`
	WorkContext            string `yaml:"work_context"`
	StoryBehaviorRules     string `yaml:"story_behavior_rules"`
	TaskRulesWithParent    string `yaml:"task_rules_with_parent"`
	LifecycleRules         string `yaml:"lifecycle_rules"`
	StoryRestartNudge      string `yaml:"story_restart_nudge"`
	TaskRestartNudge       string `yaml:"task_restart_nudge"`
	StoryReopenNudge       string `yaml:"story_reopen_nudge"`
	TaskReopenNudge        string `yaml:"task_reopen_nudge"`
	StoryAutoContinueNudge string `yaml:"story_auto_continue_nudge"`
	TaskAutoContinueNudge  string `yaml:"task_auto_continue_nudge"`
	StepAutoContinueNudge  string `yaml:"step_auto_continue_nudge"`
	ChildCompletionNudge   string `yaml:"child_completion_nudge"`
	StrandedWaitNudge      string `yaml:"stranded_wait_nudge"`
	StepAdvanceSection     string `yaml:"step_advance_section"`
	CurrentStepSection     string `yaml:"current_step_section"`
}

var prompts promptTemplates

func init() {
	if err := yaml.Unmarshal(promptsYAML, &prompts); err != nil {
		panic("failed to parse prompts.yaml: " + err.Error())
	}
}

// compiledTemplates caches parsed templates keyed by their source string.
// The prompt strings are compile-time constants (from embedded prompts.yaml),
// so each is parsed once and reused across the many messages built per session.
// *template.Template.Execute is safe for concurrent use.
var compiledTemplates sync.Map // map[string]*template.Template

// render executes a template string with the given data.
func render(tmplStr string, data any) string {
	compiled, ok := compiledTemplates.Load(tmplStr)
	if !ok {
		tmpl, err := template.New("").Parse(tmplStr)
		if err != nil {
			// Template parse errors should be caught during development
			panic("invalid template: " + err.Error())
		}
		compiled, _ = compiledTemplates.LoadOrStore(tmplStr, tmpl)
	}

	var buf bytes.Buffer
	if err := compiled.(*template.Template).Execute(&buf, data); err != nil {
		panic("template execution failed: " + err.Error())
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// storyBehaviorRules is the coordinator half of a story's prompt.
//
// A function, not a package-level var: initialisers of vars that depend on no
// other var run *before* init(), so a var holding this ran against a zero
// promptTemplates and every story prompt shipped without its coordinator rules —
// silently, because the test asserting they were present was comparing against
// that same empty string.
func storyBehaviorRules() string {
	return render(prompts.StoryBehaviorRules, nil)
}

func roleReference(agentRoleID string) string {
	return render(prompts.RoleReference, map[string]string{
		"AgentRoleID": agentRoleID,
	})
}

// lifecycleRules is the one explanation of how the engine drives a work, told to
// story and task alike. The numbers in it are read from the constants that
// actually govern the behaviour, so a prompt cannot promise an allowance or a
// deadline the server does not keep.
func lifecycleRules(w Work) string {
	return render(prompts.LifecycleRules, map[string]any{
		"ID":           w.ID,
		"IsStory":      w.Type == WorkTypeStory,
		"MaxNudges":    DefaultMaxNudges,
		"AnswerBudget": humanDuration(session.DefaultAnswerBudget),
	})
}

// humanDuration writes a duration the way a sentence addressed to an agent
// needs it. time.Duration.String() gives "1h0m0s", which reads as a machine
// value the agent may well repeat back to the user.
func humanDuration(d time.Duration) string {
	switch {
	case d >= time.Hour && d%time.Hour == 0:
		return pluralize(int(d/time.Hour), "hour", "an")
	case d >= time.Minute && d%time.Minute == 0:
		return pluralize(int(d/time.Minute), "minute", "a")
	default:
		return d.String()
	}
}

// article is part of pluralize's job because the two units it serves take
// different ones: "an hour", "a minute".
func pluralize(n int, unit, article string) string {
	if n == 1 {
		return article + " " + unit
	}
	return strconv.Itoa(n) + " " + unit + "s"
}

// buildBase builds the common message shared by all prompt types.
//
// Everything that is true of every work Pockode drives lives in the lifecycle
// section; what is left in the per-type rules is only what differs — how a
// coordinator splits a story up, and where a task reports to. Saying step_done
// twice in one message was how the old prompts drifted: each send site repeated
// its own half-remembered version of the rule.
func buildBase(w Work) string {
	role := roleReference(w.AgentRoleID)

	workCtx := render(prompts.WorkContext, map[string]string{
		"Title": w.Title,
		"ID":    w.ID,
	})

	sections := []string{render(prompts.PockodeMCPPrefix, nil), role, workCtx}
	switch {
	case w.Type == WorkTypeStory:
		sections = append(sections, storyBehaviorRules())
	case w.ParentID != "":
		sections = append(sections, render(prompts.TaskRulesWithParent, map[string]string{
			"ParentID": w.ParentID,
		}))
	}
	sections = append(sections, lifecycleRules(w))

	return strings.Join(sections, "\n\n")
}

func BuildKickoffMessage(w Work) string {
	return buildBase(w)
}

// formatStepSection creates the step instruction section.
// Format: "## Current Step\nStep N of M\n\n<step content>"
func formatStepSection(workID string, steps []string, stepIndex int) string {
	if len(steps) == 0 || stepIndex < 0 || stepIndex >= len(steps) {
		return ""
	}
	return render(prompts.CurrentStepSection, map[string]any{
		"CurrentStep": stepIndex + 1,
		"TotalSteps":  len(steps),
		"StepPrompt":  steps[stepIndex],
		"ID":          workID,
	})
}

// BuildKickoffMessageWithSteps creates the kickoff message with step instructions.
// If steps is non-empty and currentStep (0-indexed) is valid, the step section is appended.
func BuildKickoffMessageWithSteps(w Work, steps []string, currentStep int) string {
	base := buildBase(w)

	stepSection := formatStepSection(w.ID, steps, currentStep)
	if stepSection == "" {
		return base
	}

	return base + "\n\n" + stepSection
}

// BuildRestartMessage appends a restart nudge to the base message
// when a stopped work item is restarted by the user.
func BuildRestartMessage(w Work) string {
	base := buildBase(w)

	var nudge string
	if w.Type == WorkTypeStory {
		nudge = render(prompts.StoryRestartNudge, nil)
	} else {
		nudge = render(prompts.TaskRestartNudge, nil)
	}

	return base + "\n\n" + nudge
}

// BuildAutoContinuationMessage appends a nudge to the base message when a turn
// ended without the agent saying it was done or what it is waiting for. The
// nudge names the three things it was looking for, because "carry on" alone
// never told an agent how to make the nudging stop.
func BuildAutoContinuationMessage(w Work) string {
	base := buildBase(w)

	var nudge string
	if w.Type == WorkTypeStory {
		nudge = render(prompts.StoryAutoContinueNudge, nil)
	} else {
		nudge = render(prompts.TaskAutoContinueNudge, nil)
	}

	return base + "\n\n" + nudge
}

// BuildAutoContinuationMessageWithSteps creates the auto-continuation message with step context.
// When the work has steps configured, the message prompts the agent to check if the current step is complete.
func BuildAutoContinuationMessageWithSteps(w Work, steps []string, currentStep int) string {
	base := buildBase(w)

	// No steps or invalid index: fall back to standard message
	if len(steps) == 0 || currentStep < 0 || currentStep >= len(steps) {
		return BuildAutoContinuationMessage(w)
	}

	stepSection := formatStepSection(w.ID, steps, currentStep)

	nudge := render(prompts.StepAutoContinueNudge, map[string]any{
		"CurrentStep": currentStep + 1,
		"TotalSteps":  len(steps),
		"ID":          w.ID,
	})

	return base + "\n\n" + stepSection + "\n\n" + nudge
}

// BuildChildCompletionMessage tells a parent that one of its children closed.
//
// waitCleared says whether this closure ended the parent's wait, and it is a
// parameter rather than a read of parent.Wait because only the caller knows:
// the engine clears a wait on children and deliberately leaves a wait on the
// *user* standing (Engine.notifyParentOfChild). Telling a parent its wait is
// gone when it is not would invite it to call work_wait and overwrite a wait on
// a person with one on its subtasks — the user would stop being told they are
// the one being waited for.
func BuildChildCompletionMessage(parent Work, childTitle, childID string, waitCleared bool) string {
	base := buildBase(parent)

	nudge := render(prompts.ChildCompletionNudge, map[string]any{
		"ChildTitle":  childTitle,
		"ChildID":     childID,
		"ID":          parent.ID,
		"WaitCleared": waitCleared,
	})

	return base + "\n\n" + nudge
}

// BuildStrandedWaitMessage tells a parent that its wait on its subtasks has
// nothing left that could end it, and what became of the last one.
//
// exit is a parameter for the same reason waitCleared is one above: only the
// caller knows which of the three shapes it was, and the three differ in the way
// back — a stopped or unstarted subtask is restarted, a deleted one is replaced.
// Collapsing them into "the subtask is gone" would send the agent looking for
// work_start on an ID that no longer exists.
func BuildStrandedWaitMessage(parent Work, childTitle, childID string, exit childExit) string {
	base := buildBase(parent)

	nudge := render(prompts.StrandedWaitNudge, map[string]any{
		"ChildTitle": childTitle,
		"ChildID":    childID,
		"ID":         parent.ID,
		"Exit":       string(exit),
	})

	return base + "\n\n" + nudge
}

// BuildStepAdvanceMessage creates the message sent when advancing to the next step.
// stepNum is 1-indexed (the step we are advancing TO), totalSteps is the total count.
func BuildStepAdvanceMessage(w Work, stepPrompt string, stepNum, totalSteps int) string {
	base := buildBase(w)

	stepSection := render(prompts.StepAdvanceSection, map[string]any{
		"PrevStep":    stepNum - 1,
		"TotalSteps":  totalSteps,
		"CurrentStep": stepNum,
		"StepPrompt":  stepPrompt,
		"ID":          w.ID,
	})

	return base + "\n\n" + stepSection
}

// BuildReopenMessage appends a reopen nudge to the base message
// when a closed work item is reopened by the user.
func BuildReopenMessage(w Work) string {
	base := buildBase(w)

	var nudge string
	if w.Type == WorkTypeStory {
		nudge = render(prompts.StoryReopenNudge, nil)
	} else {
		nudge = render(prompts.TaskReopenNudge, nil)
	}

	return base + "\n\n" + nudge
}
