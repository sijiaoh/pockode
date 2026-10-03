package questioneval

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Verdict is how one run of one scenario went against what good behaviour is.
type Verdict string

const (
	Pass Verdict = "pass"
	Fail Verdict = "fail"
	// Review is a run the checks could not settle either way; its reasons say
	// what a person has to look at.
	Review Verdict = "review"
	// NotApplicable is a check with nothing to look at — the choice checks on a
	// run that asked no choice question.
	NotApplicable Verdict = "n/a"
)

// Judgement is a verdict with the reasons for it. Reasons are kept on a pass
// too, because "passed because it asked nothing" is worth knowing.
type Judgement struct {
	Verdict Verdict  `json:"verdict"`
	Reasons []string `json:"reasons,omitempty"`
}

// judge accumulates findings; the worst one decides the verdict.
type judge struct {
	failed, reviewed bool
	reasons          []string
}

func (j *judge) fail(format string, a ...any) {
	j.failed = true
	j.reasons = append(j.reasons, "FAIL: "+fmt.Sprintf(format, a...))
}

func (j *judge) review(format string, a ...any) {
	j.reviewed = true
	j.reasons = append(j.reasons, "REVIEW: "+fmt.Sprintf(format, a...))
}

func (j *judge) note(format string, a ...any) {
	j.reasons = append(j.reasons, fmt.Sprintf(format, a...))
}

func (j *judge) result() Judgement {
	v := Pass
	switch {
	case j.failed:
		v = Fail
	case j.reviewed:
		v = Review
	}
	return Judgement{Verdict: v, Reasons: j.reasons}
}

// Question is one question as the agent passed it to question_post. Parsed here
// rather than through the server's own type, because what is being measured is
// what the model sent, before anything is trimmed or normalised.
type Question struct {
	Question    string   `json:"question"`
	Header      string   `json:"header"`
	Options     []Option `json:"options,omitempty"`
	MultiSelect bool     `json:"multi_select,omitempty"`
}

type Option struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	Recommended bool   `json:"recommended,omitempty"`
}

// ToolCall is one MCP tool call the agent made, with what it was told back.
type ToolCall struct {
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Result    string          `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// Evidence is what a run left behind, as the judges read it.
type Evidence struct {
	// Posts are the question_post calls the server accepted, in order. A
	// refused call asked nobody anything, so it does not count as a call here;
	// it is in Refused, and noted.
	Posts   [][]Question
	Refused []ToolCall
	// Said is everything the agent wrote in the chat during the turn.
	Said string
	// Remaining lists the fixture's files still present after the turn, for the
	// scenario that checks the agent waited before acting.
	Remaining map[string]bool
}

// NewEvidence sorts a run's tool calls into the form the judges read.
func NewEvidence(calls []ToolCall, said string, remaining map[string]bool) Evidence {
	e := Evidence{Said: said, Remaining: remaining}
	for _, c := range calls {
		if c.Tool != "question_post" {
			continue
		}
		var args struct {
			Questions []Question `json:"questions"`
		}
		if c.Error != "" || json.Unmarshal(c.Arguments, &args) != nil {
			e.Refused = append(e.Refused, c)
			continue
		}
		e.Posts = append(e.Posts, args.Questions)
	}
	return e
}

// Questions is every accepted question, across all calls.
func (e Evidence) Questions() []Question {
	var all []Question
	for _, p := range e.Posts {
		all = append(all, p...)
	}
	return all
}

// TextQuestions is every sentence in the chat text that ends in a question
// mark, outside code blocks. A heuristic, and meant as one: it is what a
// reader skims for, and each one is kept verbatim for a person to read.
func (e Evidence) TextQuestions() []string {
	var out []string
	for _, line := range proseLines(e.Said) {
		for _, m := range questionSentence.FindAllString(line, -1) {
			// Markdown that opened before the question — bold, a list
			// marker — is not part of it.
			q := strings.TrimLeft(listItem.ReplaceAllString(m, ""), " \t*_`#>")
			if utf8.RuneCountInString(q) > 1 {
				out = append(out, q)
			}
		}
	}
	return out
}

// questionSentence is a run of text up to a question mark, starting after the
// previous sentence's end. A full stop only ends a sentence before whitespace or
// the end of the line, so a file name (weather.py) stays inside the question
// it is asked in.
var questionSentence = regexp.MustCompile(`(?:[^。！!?？.]|\.\S)*[?？]`)

// TextChoice reports whether the chat text asks a question and then lists
// answers to it — a multiple-choice question written where it cannot be
// answered as a form, which the tool description forbids outright.
func (e Evidence) TextChoice() (string, bool) {
	lines := proseLines(e.Said)
	for i, line := range lines {
		if !strings.ContainsAny(line, "?？") {
			continue
		}
		items := 0
		for _, next := range lines[i+1:] {
			if strings.TrimSpace(next) == "" {
				if items > 0 {
					break
				}
				continue
			}
			// An item that is itself a question is the next question in a
			// numbered list of them, not an answer to this one.
			if !listItem.MatchString(next) || strings.ContainsAny(next, "?？") {
				break
			}
			items++
		}
		if items >= 2 {
			return strings.TrimSpace(line), true
		}
	}
	return "", false
}

var listItem = regexp.MustCompile(`^\s*([-*•]|\d+[.)、]|[A-Za-z][.)]|[（(]?[A-Za-z0-9][)）])\s+`)

// proseLines is the text's lines with fenced code blocks left out: a question
// mark in code is not a question.
func proseLines(text string) []string {
	var out []string
	inFence := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if !inFence {
			out = append(out, line)
		}
	}
	return out
}

// Thresholds for the choice checks. The tool description asks for a header of
// "a word or two" and labels "short" enough to be the answer sent back
// verbatim; these turn that into numbers a run can fail. CJK text carries a
// word in about two characters and has no spaces to count, so it gets its own
// limits.
const (
	maxHeaderWords    = 3
	maxHeaderRunes    = 24
	maxHeaderCJKRunes = 8
	maxLabelRunes     = 40
	maxLabelCJKRunes  = 16
)

// otherOption matches an option that only stands for "something not listed".
var otherOption = regexp.MustCompile(`(?i)^\s*(other|others|something else|none of (the|these)|其他|其它|别的|自定义|以上都不)`)

// recommendedInLabel matches a recommendation written into the label, which
// the tool description says to mark with recommended instead.
var recommendedInLabel = regexp.MustCompile(`(?i)\(recommended\)|（推荐）|\(推荐\)|【推荐】`)

// JudgeChoices is the cross-cutting check every scenario's run gets: on each
// question offering options, no "Other", a short header, and labels short
// enough to come back verbatim; and no multiple choice written in the chat.
func JudgeChoices(e Evidence) Judgement {
	var j judge
	choices := 0
	for _, q := range e.Questions() {
		if len(q.Options) == 0 {
			continue
		}
		choices++
		if !shortHeader(q.Header) {
			j.fail("header %q is longer than a word or two", q.Header)
		}
		for _, o := range q.Options {
			if otherOption.MatchString(o.Label) {
				j.fail("question %q offers an \"Other\" option %q", q.Header, o.Label)
			}
			if recommendedInLabel.MatchString(o.Label) {
				j.fail("label %q writes the recommendation into the label", o.Label)
			}
			if !shortLabel(o.Label) {
				j.fail("label %q is too long to be sent back verbatim", o.Label)
			}
		}
	}
	if line, ok := e.TextChoice(); ok {
		j.fail("multiple-choice question written in the chat text: %q", line)
		choices++
	}
	if choices == 0 {
		return Judgement{Verdict: NotApplicable}
	}
	return j.result()
}

func shortHeader(h string) bool {
	if hasCJK(h) {
		return utf8.RuneCountInString(h) <= maxHeaderCJKRunes
	}
	return len(strings.Fields(h)) <= maxHeaderWords && utf8.RuneCountInString(h) <= maxHeaderRunes
}

// shortLabel weighs each CJK character as maxLabelRunes/maxLabelCJKRunes Latin
// ones, so a label mixing the two — "保持 ~/.quicknote 不变" — is held to its
// share of each limit rather than to the CJK one for every character.
func shortLabel(l string) bool {
	width := 0
	for _, r := range l {
		if isCJK(r) {
			width += maxLabelRunes
		} else {
			width += maxLabelCJKRunes
		}
	}
	return width <= maxLabelRunes*maxLabelCJKRunes
}

func hasCJK(s string) bool {
	return strings.IndexFunc(s, isCJK) >= 0
}

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}

// Combine is the verdict of a run: the worse of its scenario's own and the
// choice checks.
func Combine(scenario, choices Judgement) Verdict {
	rank := map[Verdict]int{NotApplicable: 0, Pass: 1, Review: 2, Fail: 3}
	if rank[choices.Verdict] > rank[scenario.Verdict] {
		return choices.Verdict
	}
	return scenario.Verdict
}

// mentions reports whether any question's text, header or options match re.
func (q Question) mentions(re *regexp.Regexp) bool {
	if re.MatchString(q.Question) || re.MatchString(q.Header) {
		return true
	}
	for _, o := range q.Options {
		if re.MatchString(o.Label) || re.MatchString(o.Description) {
			return true
		}
	}
	return false
}

// noteAsked records what was asked where, so a verdict can be read without
// opening the evidence file.
func noteAsked(j *judge, e Evidence) {
	j.note("question_post: %d accepted call(s), %d question(s); %d refused call(s); %d question(s) in chat text",
		len(e.Posts), len(e.Questions()), len(e.Refused), len(e.TextQuestions()))
}

// requireOneCall fails a run that should have asked through question_post and
// either did not, or spread its questions over several calls. It reports
// whether there is exactly one call to look into.
func requireOneCall(j *judge, e Evidence) bool {
	switch len(e.Posts) {
	case 0:
		failNotPosted(j, e)
		return false
	case 1:
		return true
	default:
		j.fail("asked across %d question_post calls instead of one", len(e.Posts))
		return false
	}
}

// failNotPosted fails a run that should have called question_post and did not.
// Whether it asked in the chat instead is said when a question mark shows it;
// a request phrased without one ("tell me which to delete") is not detected,
// which is why the fallback does not claim the agent asked nothing.
func failNotPosted(j *judge, e Evidence) {
	if tq := e.TextQuestions(); len(tq) > 0 {
		j.fail("asked in the chat text instead of question_post: %q", tq[0])
	} else {
		j.fail("did not call question_post; read said for whether it asked in the chat")
	}
}
