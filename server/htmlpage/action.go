package htmlpage

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// Action is something a page sent to the agent on the reader's press
// (pockode.send, data-pk-send): which page, what it named the action, and
// what it put with it (docs/tool-call-ui.md § Sending to the agent).
type Action struct {
	// Page is the card's id, filled in by the app rather than by the page, so
	// a page cannot claim to be another.
	Page   string `json:"page"`
	Action string `json:"action"`
	// Data is compact JSON; `{}` when the page sent none.
	Data json.RawMessage `json:"data"`
}

// ActionText is an action as the agent reads it, and as its message record's
// content holds it: the action quoted, the page, then the data on a line of
// its own. "from" the page, so the agent weighs it as the page's input rather
// than as the reader's own words.
func ActionText(a Action) string {
	return fmt.Sprintf("Page action %s from %s:\n%s", strconv.Quote(a.Action), a.Page, a.Data)
}
