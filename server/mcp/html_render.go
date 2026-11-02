package mcp

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pockode/server/htmlpage"
)

// PageDirs resolves where a session's pages are written: the data directory
// of the worktree the session lives in, once both are known to exist.
// Satisfied by *worktree.Manager.
type PageDirs interface {
	PageDataDir(worktree, sessionID string) (string, error)
}

// SetPages installs where the page tools store their pages. The server always
// sets it; left unset, a page tool called from a session fails as a server
// fault rather than drawing a page nothing could read back.
func (e *Executor) SetPages(store *htmlpage.Store, dirs PageDirs) {
	e.pages = store
	e.pageDirs = dirs
}

// pageDataDir is the data directory the calling session's pages are under.
// The caller's session is checked by the tool first, since each tool says in
// its own words what a call without one cannot do.
func (e *Executor) pageDataDir(caller Caller) (string, error) {
	if e.pages == nil || e.pageDirs == nil {
		return "", errors.New("page store not configured")
	}
	dataDir, err := e.pageDirs.PageDataDir(caller.Worktree, caller.SessionID)
	if err != nil {
		return "", fmt.Errorf("resolve the session's data directory: %w", err)
	}
	return dataDir, nil
}

// appendPage stores a page for the calling session and returns it with its id.
// A draft the store refuses is the agent's to fix, so it comes back as a user
// error.
func (e *Executor) appendPage(tool string, caller Caller, draft htmlpage.Draft) (htmlpage.Page, error) {
	if caller.SessionID == "" {
		return htmlpage.Page{}, errNoCallerSession(tool, "there is no chat to show the page in")
	}
	if err := draft.Validate(); err != nil {
		return htmlpage.Page{}, &userError{err: err}
	}
	dataDir, err := e.pageDataDir(caller)
	if err != nil {
		return htmlpage.Page{}, err
	}
	page, err := e.pages.Append(dataDir, caller.SessionID, draft)
	if err != nil {
		return htmlpage.Page{}, fmt.Errorf("store page: %w", err)
	}
	return page, nil
}

func (e *Executor) htmlRender(caller Caller, args json.RawMessage) (string, error) {
	var params struct {
		Title string `json:"title"`
		HTML  string `json:"html"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	page, err := e.appendPage("html_render", caller, htmlpage.Draft{Title: params.Title, HTML: params.HTML})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s %q is shown to the user; do not repeat its content in your reply.", htmlpage.ResultLead(page.ID), page.Title), nil
}
