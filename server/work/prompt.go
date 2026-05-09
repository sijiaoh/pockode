package work

import (
	"bytes"
	_ "embed"
	"strings"
	"text/template"

	"gopkg.in/yaml.v3"
)

//go:embed prompts.yaml
var promptsYAML []byte

// promptTemplates holds parsed templates from prompts.yaml.
type promptTemplates struct {
	PockodeMCPPrefix        string `yaml:"pockode_mcp_prefix"`
	RoleReference           string `yaml:"role_reference"`
	WorkContext             string `yaml:"work_context"`
	StoryBehaviorRules      string `yaml:"story_behavior_rules"`
	StoryRulesSuffix        string `yaml:"story_rules_suffix"`
	TaskRulesWithParent     string `yaml:"task_rules_with_parent"`
	TaskRulesWithoutParent  string `yaml:"task_rules_without_parent"`
	StoryRestartNudge       string `yaml:"story_restart_nudge"`
	TaskRestartNudge        string `yaml:"task_restart_nudge"`
	StoryReopenNudge        string `yaml:"story_reopen_nudge"`
	TaskReopenNudge         string `yaml:"task_reopen_nudge"`
	StoryAutoContinueNudge  string `yaml:"story_auto_continue_nudge"`
	TaskAutoContinueNudge   string `yaml:"task_auto_continue_nudge"`
	TaskStepAutoContinue    string `yaml:"task_step_auto_continue_nudge"`
	ParentReactivationNudge string `yaml:"parent_reactivation_nudge"`
	StepAdvanceSection      string `yaml:"step_advance_section"`
	CurrentStepSection      string `yaml:"current_step_section"`
}

var prompts promptTemplates

func init() {
	if err := yaml.Unmarshal(promptsYAML, &prompts); err != nil {
		panic("failed to parse prompts.yaml: " + err.Error())
	}
}

// render executes a template string with the given data.
func render(tmplStr string, data any) string {
	tmpl, err := template.New("").Parse(tmplStr)
	if err != nil {
		// Template parse errors should be caught during development
		panic("invalid template: " + err.Error())
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		panic("template execution failed: " + err.Error())
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// storyBehaviorRules is kept for test compatibility.
var storyBehaviorRules = strings.TrimSuffix(prompts.StoryBehaviorRules, "\n")

func roleReference(agentRoleID string) string {
	return render(prompts.RoleReference, map[string]string{
		"AgentRoleID": agentRoleID,
	})
}

// buildBase builds the common message shared by all prompt types.
func buildBase(w Work) string {
	role := roleReference(w.AgentRoleID)

	workCtx := render(prompts.WorkContext, map[string]string{
		"Title": w.Title,
		"ID":    w.ID,
	})

	var rules string
	if w.Type == WorkTypeStory {
		rules = storyBehaviorRules + "\n" + render(prompts.StoryRulesSuffix, map[string]string{
			"ID": w.ID,
		})
	} else {
		if w.ParentID != "" {
			rules = render(prompts.TaskRulesWithParent, map[string]string{
				"ParentID": w.ParentID,
				"ID":       w.ID,
			})
		} else {
			rules = render(prompts.TaskRulesWithoutParent, map[string]string{
				"ID": w.ID,
			})
		}
	}

	pockodeMCPPrefix := render(prompts.PockodeMCPPrefix, nil)
	return pockodeMCPPrefix + "\n\n" + role + "\n\n" + workCtx + "\n\n" + rules
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
		nudge = render(prompts.StoryRestartNudge, map[string]string{
			"ID": w.ID,
		})
	} else {
		nudge = render(prompts.TaskRestartNudge, map[string]string{
			"ID": w.ID,
		})
	}

	return base + "\n\n" + nudge
}

// BuildAutoContinuationMessage appends a nudge to the base message
// when an agent process stops but its work item is still in_progress.
func BuildAutoContinuationMessage(w Work) string {
	base := buildBase(w)

	var nudge string
	if w.Type == WorkTypeStory {
		nudge = render(prompts.StoryAutoContinueNudge, map[string]string{
			"ID": w.ID,
		})
	} else {
		nudge = render(prompts.TaskAutoContinueNudge, map[string]string{
			"ID": w.ID,
		})
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

	// For stories, steps don't apply (stories coordinate, don't execute steps)
	if w.Type == WorkTypeStory {
		return BuildAutoContinuationMessage(w)
	}

	stepSection := formatStepSection(w.ID, steps, currentStep)

	nudge := render(prompts.TaskStepAutoContinue, map[string]any{
		"CurrentStep": currentStep + 1,
		"TotalSteps":  len(steps),
		"ID":          w.ID,
	})

	return base + "\n\n" + stepSection + "\n\n" + nudge
}

// BuildParentReactivationMessage appends a reactivation nudge to the base message
// when one of a parent story's child tasks completes.
func BuildParentReactivationMessage(parent Work, childTitle, childID string) string {
	base := buildBase(parent)

	nudge := render(prompts.ParentReactivationNudge, map[string]string{
		"ChildTitle": childTitle,
		"ChildID":    childID,
		"ID":         parent.ID,
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
		nudge = render(prompts.StoryReopenNudge, map[string]string{
			"ID": w.ID,
		})
	} else {
		nudge = render(prompts.TaskReopenNudge, map[string]string{
			"ID": w.ID,
		})
	}

	return base + "\n\n" + nudge
}
