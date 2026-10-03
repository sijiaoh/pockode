package questioneval

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/pockode/server/session"
)

// RunResult is everything one run left behind: the verdicts, and the raw
// evidence they were reached from, so a report can quote the run and a person
// can overrule a judge.
type RunResult struct {
	CLI          string `json:"cli"`
	ScenarioName string `json:"scenario"`
	Run          int    `json:"run"`
	Prompt       string `json:"prompt"`
	Duration     string `json:"duration"`
	// CostUSD is what the CLI reported the turn cost; zero for a CLI that
	// reports no price (Codex), whose Usage is the only measure.
	CostUSD float64            `json:"cost_usd"`
	Usage   session.TokenUsage `json:"usage"`

	Verdict  Verdict   `json:"verdict"`
	Scenario Judgement `json:"scenario_judgement"`
	Choices  Judgement `json:"choice_judgement"`

	// ToolCalls are every MCP call, raw arguments and reply included; Posts the
	// accepted question_post calls as the judges read them.
	ToolCalls     []ToolCall   `json:"tool_calls"`
	Posts         [][]Question `json:"question_posts"`
	Said          string       `json:"said"`
	TextQuestions []string     `json:"text_questions,omitempty"`

	// Records are the turn's events as Pockode's history stores them. Written
	// to a file of their own: they are long, and only needed to see what the
	// agent did between its questions.
	Records []json.RawMessage `json:"-"`
}

// Reasons are both judgements' reasons, the scenario's first.
func (r RunResult) Reasons() []string {
	return append(slices.Clone(r.Scenario.Reasons), r.Choices.Reasons...)
}

// Summary is the Markdown overview of a set of runs: a pass count per scenario
// and CLI, then each run that did not pass with its reasons.
func Summary(results []RunResult) string {
	var clis []string
	for _, r := range results {
		if !slices.Contains(clis, r.CLI) {
			clis = append(clis, r.CLI)
		}
	}

	var b strings.Builder
	b.WriteString("# question_post guidance eval\n\n")
	b.WriteString("Cells are pass / runs, with fails (F) and runs to review by hand (R).\n\n")
	b.WriteString("| Scenario | " + strings.Join(clis, " | ") + " |\n")
	b.WriteString("|---" + strings.Repeat("|---", len(clis)) + "|\n")
	for _, sc := range Scenarios {
		row := []string{sc.Name}
		seen := false
		for _, cli := range clis {
			var total, pass, fail, review int
			for _, r := range results {
				if r.CLI != cli || r.ScenarioName != sc.Name {
					continue
				}
				total++
				switch r.Verdict {
				case Pass:
					pass++
				case Fail:
					fail++
				case Review:
					review++
				}
			}
			if total == 0 {
				row = append(row, "—")
				continue
			}
			seen = true
			row = append(row, fmt.Sprintf("%d/%d (F%d R%d)", pass, total, fail, review))
		}
		if seen {
			b.WriteString("| " + strings.Join(row, " | ") + " |\n")
		}
	}

	b.WriteString("\n## Cost\n\n")
	for _, cli := range clis {
		var cost float64
		var tokens int64
		runs := 0
		for _, r := range results {
			if r.CLI == cli {
				cost += r.CostUSD
				tokens += r.Usage.Total()
				runs++
			}
		}
		price := "no price reported"
		if cost > 0 {
			price = fmt.Sprintf("$%.4f reported", cost)
		}
		fmt.Fprintf(&b, "- %s: %d run(s), %s, %d tokens\n", cli, runs, price, tokens)
	}

	b.WriteString("\n## Runs that did not pass\n")
	for _, r := range results {
		if r.Verdict == Pass {
			continue
		}
		fmt.Fprintf(&b, "\n### %s / %s / run-%d: %s\n\n", r.CLI, r.ScenarioName, r.Run, r.Verdict)
		for _, reason := range r.Reasons() {
			fmt.Fprintf(&b, "- %s\n", reason)
		}
	}
	return b.String()
}
