package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/pockode/server/htmlpage"
)

// htmlSourceMarker is the line html_get puts between what it says about a page
// and the page's HTML. The HTML is given raw rather than inside JSON so that
// what the agent reads is byte for byte what html_edit's old has to match: an
// escaped copy would put a backslash before every quote it might copy back.
const htmlSourceMarker = "----- HTML -----"

func (e *Executor) htmlGet(caller Caller, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	if params.ID == "" {
		return "", userErrorf("id is required: pass the page's id, such as p1")
	}
	if caller.SessionID == "" {
		return "", errNoCallerSession("html_get", "there is no chat whose pages to read")
	}
	dataDir, err := e.pageDataDir(caller)
	if err != nil {
		return "", err
	}
	page, err := readPage(dataDir, caller.SessionID, params.ID)
	if err != nil {
		return "", err
	}
	pages, err := htmlpage.List(dataDir, caller.SessionID)
	if err != nil {
		return "", fmt.Errorf("list pages: %w", err)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s %q", page.ID, page.Title)
	if page.Base != "" {
		fmt.Fprintf(&b, ", derived from %s", page.Base)
	}
	fmt.Fprintf(&b, ". Its HTML is everything after the %s line, exactly as stored.\n", htmlSourceMarker)
	fmt.Fprintf(&b, "Pages in this chat, oldest first: %s\n", listPages(pages))
	b.WriteString(htmlSourceMarker + "\n")
	b.WriteString(page.HTML)
	return b.String(), nil
}

func (e *Executor) htmlEdit(caller Caller, args json.RawMessage) (string, error) {
	var params struct {
		Base  string `json:"base"`
		Title string `json:"title"`
		Edits []struct {
			Old string `json:"old"`
			// A pointer so that an absent new is told apart from an empty one:
			// left to decode as "", a mistyped field name (new_string, from the
			// file edit tool) would delete old instead of failing.
			New        *string `json:"new"`
			ReplaceAll bool    `json:"replace_all"`
		} `json:"edits"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	edits := make([]htmlpage.Edit, len(params.Edits))
	for i, edit := range params.Edits {
		if edit.New == nil {
			return "", userErrorf("edit %d: new is missing: pass the replacement text as new (an empty string deletes old); each edit is {old, new, replace_all?}", i+1)
		}
		edits[i] = htmlpage.Edit{Old: edit.Old, New: *edit.New, ReplaceAll: edit.ReplaceAll}
	}
	if params.Base == "" {
		return "", userErrorf("base is required: pass the id of the page to derive from, such as p1")
	}
	if caller.SessionID == "" {
		return "", errNoCallerSession("html_edit", "there is no chat to show the page in")
	}
	dataDir, err := e.pageDataDir(caller)
	if err != nil {
		return "", err
	}
	base, err := readPage(dataDir, caller.SessionID, params.Base)
	if err != nil {
		return "", err
	}
	html, err := htmlpage.ApplyEdits(base.HTML, edits)
	if err != nil {
		return "", &userError{err: fmt.Errorf("%w; nothing was stored and %s is unchanged", err, base.ID)}
	}
	title := params.Title
	if strings.TrimSpace(title) == "" {
		title = base.Title
	}
	page, err := e.appendPage("html_edit", caller, htmlpage.Draft{Title: title, HTML: html, Base: base.ID})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s %q, derived from %s, is shown to the user; %s is unchanged. Do not repeat its content in your reply.", htmlpage.ResultLead(page.ID), page.Title, base.ID, base.ID), nil
}

// readPage reads one of the session's pages. A page that is not there is the
// agent's mistake, and the refusal lists the pages there are, so the next call
// can name a real one.
func readPage(dataDir, sessionID, id string) (htmlpage.Page, error) {
	page, err := htmlpage.Get(dataDir, sessionID, id)
	if errors.Is(err, htmlpage.ErrNotFound) {
		pages, err := htmlpage.List(dataDir, sessionID)
		if err != nil {
			return htmlpage.Page{}, fmt.Errorf("list pages: %w", err)
		}
		return htmlpage.Page{}, userErrorf("page %q not found in this chat; its pages, oldest first: %s", id, listPages(pages))
	}
	if err != nil {
		return htmlpage.Page{}, fmt.Errorf("read page %s: %w", id, err)
	}
	return page, nil
}

func listPages(pages []htmlpage.Summary) string {
	if len(pages) == 0 {
		return "none yet"
	}
	parts := make([]string, len(pages))
	for i, p := range pages {
		parts[i] = fmt.Sprintf("%s %q", p.ID, p.Title)
	}
	return strings.Join(parts, ", ")
}
