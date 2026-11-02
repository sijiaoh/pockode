package htmlpage

import (
	"errors"
	"fmt"
	"strings"
)

// Edit is one exact-string replacement in a page's HTML: the semantics of the
// str_replace edits an agent already makes to files, so deriving a page asks
// nothing new of it. Plain text matching rather than anything that parses
// HTML: a parser's notion of the document can change, an agent's copy of the
// text it read cannot.
type Edit struct {
	Old        string
	New        string
	ReplaceAll bool
}

// ApplyEdits applies edits to html in order, each to the result of the ones
// before it, and returns the result only if every one of them applied — and
// left a page no larger than MaxHTMLBytes after each step, not only at the end,
// so that no step builds more than that. An edit that does not fails the whole
// set, so a derived page is never half of what was asked for. The errors name
// the edit by its 1-based position and are written for the agent, which is who
// reads them.
func ApplyEdits(html string, edits []Edit) (string, error) {
	if len(edits) == 0 {
		return "", errors.New("edits is required: pass at least one {old, new} replacement")
	}
	for i, edit := range edits {
		n := i + 1
		if edit.Old == "" {
			return "", fmt.Errorf("edit %d: old is missing or empty: pass the exact text to replace as old; each edit is {old, new, replace_all?}", n)
		}
		if edit.Old == edit.New {
			return "", fmt.Errorf("edit %d: old and new are the same, so it changes nothing", n)
		}
		count := strings.Count(html, edit.Old)
		switch {
		case count == 0:
			return "", fmt.Errorf("edit %d: old was not found in the page%s: it must match the page's HTML exactly, whitespace included — read it with html_get", n, afterEarlier(n))
		case count > 1 && !edit.ReplaceAll:
			return "", fmt.Errorf("edit %d: old matches %d places in the page%s: include more surrounding text to make it unique, or set replace_all to replace every one", n, count, afterEarlier(n))
		}
		// Checked before replacing, not left to Validate afterwards: a short old
		// matching all over the page times a long new is a result far bigger
		// than any request, and building it would be the failure.
		if size := len(html) + count*(len(edit.New)-len(edit.Old)); size > MaxHTMLBytes {
			return "", fmt.Errorf("edit %d: the page would be %s", n, overLimit(size))
		}
		// count is 1 here unless replace_all is set.
		html = strings.ReplaceAll(html, edit.Old, edit.New)
	}
	// Validate would refuse this too, but in html_render's words, which name
	// an html argument the deriving call does not have.
	if strings.TrimSpace(html) == "" {
		return "", errors.New("the edits leave the page empty, and a blank page is no page")
	}
	return html, nil
}

// afterEarlier says which text an edit was matched against when that is not
// the base page as the agent read it.
func afterEarlier(n int) string {
	if n == 1 {
		return ""
	}
	return " as the edits before it left it"
}
