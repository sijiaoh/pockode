// Package htmlpage keeps the pages an agent draws in a chat (html_render, and
// the tools that derive one page from another), one immutable snapshot each.
//
// Each page is an event: it records what the agent drew at one moment and never
// changes. It is stored whole rather than rebuilt by replaying the edits that
// produced it, so a change to how edits are applied can never quietly turn an
// old page into a different one.
//
// The pages live under the session's own directory, so they are removed with
// it — session.FileStore.Delete drops that whole directory — and a fork copies
// the ones its history names (Clone).
//
// A page is named by a short id, "p1", "p2", …, numbered per session in the
// order the pages were drawn. Short because the agent has to quote it back
// exactly (a CLI's own tool call id is far harder to repeat), and per session
// because that is the conversation the agent remembers.
package htmlpage

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/filestore"
)

// MaxHTMLBytes bounds one page's HTML. The page is kept in the session's data
// directory for as long as the session, and the drawing call's input carries
// it too, so the cap is on what a session's history can afford, not on what a
// browser could draw.
const MaxHTMLBytes = 256 * 1024

// ErrNotFound is returned for a page id the session does not have.
var ErrNotFound = errors.New("no such page")

// ErrSessionGone is returned by Append when the session's directory is not
// there: the session was deleted, and a page written now would recreate a
// directory nothing would ever remove again.
var ErrSessionGone = errors.New("the session has no data directory")

const (
	idPrefix  = "p"
	pageExt   = ".json"
	filePerm  = 0o644
	dirPerm   = 0o755
	pagesName = "html_pages"
	// floorName holds a fork's numbering floor (Clone). Not a page: its name
	// has no number, so pageNumbers passes over it.
	floorName = "numbered_from.json"
)

// Dir is where one session's pages live.
func Dir(dataDir, sessionID string) string {
	return filepath.Join(dataDir, "sessions", sessionID, pagesName)
}

// FormatID is the id of the page numbered n.
func FormatID(n int) string {
	return idPrefix + strconv.Itoa(n)
}

// ParseID is the number in a page id, false for anything that is not one —
// including a number with a leading zero, so one page has exactly one id.
func ParseID(id string) (int, bool) {
	digits, ok := strings.CutPrefix(id, idPrefix)
	if !ok || digits == "" || digits[0] == '0' {
		return 0, false
	}
	n, err := strconv.Atoi(digits)
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

// Page is one stored page.
type Page struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	HTML  string `json:"html"`
	// Base is the page this one was derived from, empty for a page drawn from
	// scratch. A fact about how the page came to be, kept so a reader can show
	// the lineage; the HTML here is already the whole result.
	Base      string    `json:"base,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Summary is a page without its HTML: what a listing shows.
type Summary struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// Draft is a new page before it has an id. The store numbers it and stamps the
// time, which is what makes two pages drawn at once get two ids.
type Draft struct {
	Title string
	HTML  string
	Base  string
}

// Validate is the check every page passes before it is stored: there has to
// be something to draw, and not more than MaxHTMLBytes of it. The message is
// written for the agent, which is who reads it.
func (d Draft) Validate() error {
	if strings.TrimSpace(d.Title) == "" {
		return errors.New("title is required: name what the page shows")
	}
	// Whitespace alone renders as a blank frame, which is no page at all.
	if strings.TrimSpace(d.HTML) == "" {
		return errors.New("html is required: pass the page to render")
	}
	if len(d.HTML) > MaxHTMLBytes {
		return fmt.Errorf("html is %s", overLimit(len(d.HTML)))
	}
	return nil
}

// overLimit is why a page of size bytes is refused, and what to do instead.
func overLimit(size int) string {
	return fmt.Sprintf("%d bytes, over the %d-byte (256KB) limit: write large data or libraries to a project file and reference it by path instead of inlining it", size, MaxHTMLBytes)
}

// Store writes pages. Reads need no Store (Get, List): a page is written once,
// atomically, and never again.
//
// One Store serves every session of every worktree; what it serializes is the
// numbering inside one session's directory, so two pages drawn in parallel
// never take the same id. A session's lock outlives the session: one mutex
// per session that ever drew a page, for the life of the process.
type Store struct {
	locksMu sync.Mutex
	locks   map[string]*sync.Mutex
}

func NewStore() *Store {
	return &Store{locks: make(map[string]*sync.Mutex)}
}

func (s *Store) lock(dir string) func() {
	s.locksMu.Lock()
	l, ok := s.locks[dir]
	if !ok {
		l = &sync.Mutex{}
		s.locks[dir] = l
	}
	s.locksMu.Unlock()
	l.Lock()
	return l.Unlock
}

// Append stores draft as the session's next page and returns it with its id.
// The draft is validated first; a draft that fails is returned as that error
// and nothing is stored.
func (s *Store) Append(dataDir, sessionID string, draft Draft) (Page, error) {
	if err := draft.Validate(); err != nil {
		return Page{}, err
	}
	dir := Dir(dataDir, sessionID)
	defer s.lock(dir)()

	// Made one level at a time rather than with MkdirAll: a session deleted
	// while this call was on its way has no directory, and recreating it here
	// would leave a page directory behind that belongs to nobody.
	if err := os.Mkdir(dir, dirPerm); err != nil && !errors.Is(err, fs.ErrExist) {
		if errors.Is(err, fs.ErrNotExist) {
			return Page{}, fmt.Errorf("%w: %s", ErrSessionGone, sessionID)
		}
		return Page{}, fmt.Errorf("create page directory: %w", err)
	}

	highest, err := highestPage(dir)
	if err != nil {
		return Page{}, err
	}
	page := Page{
		ID:        FormatID(highest + 1),
		Title:     draft.Title,
		HTML:      draft.HTML,
		Base:      draft.Base,
		CreatedAt: time.Now().UTC(),
	}
	data, err := json.Marshal(page)
	if err != nil {
		return Page{}, fmt.Errorf("encode page: %w", err)
	}
	if err := filestore.WriteFileAtomic(pagePath(dir, highest+1), data, filePerm); err != nil {
		return Page{}, fmt.Errorf("write page: %w", err)
	}
	return page, nil
}

// Get reads one page. ErrNotFound for an id that is not a page id at all, as
// for one the session does not have: either way there is no page by that name.
func Get(dataDir, sessionID, id string) (Page, error) {
	n, ok := ParseID(id)
	if !ok {
		return Page{}, fmt.Errorf("%w: %q", ErrNotFound, id)
	}
	return readPage(pagePath(Dir(dataDir, sessionID), n))
}

// List is every page the session has, oldest first.
//
// It reads each page whole, HTML included. Fine at the size a conversation's
// pages run to (each is capped at MaxHTMLBytes, and a listing is asked for on
// purpose, not on every message); a second file per page holding only the
// title would be a second copy of the same fact to keep in step.
func List(dataDir, sessionID string) ([]Summary, error) {
	dir := Dir(dataDir, sessionID)
	numbers, err := pageNumbers(dir)
	if err != nil {
		return nil, err
	}
	summaries := make([]Summary, 0, len(numbers))
	for _, n := range numbers {
		page, err := readPage(pagePath(dir, n))
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, Summary{ID: page.ID, Title: page.Title})
	}
	return summaries, nil
}

// Clone gives the session dstSessionID the pages of srcSessionID numbered up
// to through, for a fork whose copied history names no page above it. Pages
// past the cut are left behind: the fork's transcript never drew them.
//
// Their numbers are not handed out again, though: the fork's next page is
// numbered past the source's highest. An agent can remember more than the
// transcript it was forked with — Codex reopens a conversation at a turn, not
// at a record, so a cut inside a turn leaves the agent the pages drawn later in
// that turn — and an id it remembers must never come to name a different page.
// One the fork does not have is then simply not found.
//
// Hard-linked where the filesystem allows, which is safe because a page file
// is never written again once it exists; copied where it does not.
func Clone(dataDir, srcSessionID, dstSessionID string, through int) error {
	srcDir := Dir(dataDir, srcSessionID)
	srcHighest, err := highestPage(srcDir)
	if err != nil {
		return err
	}
	if srcHighest == 0 {
		return nil
	}
	dstDir := Dir(dataDir, dstSessionID)
	if err := os.MkdirAll(dstDir, dirPerm); err != nil {
		return fmt.Errorf("create page directory: %w", err)
	}
	if srcHighest > through {
		data, err := json.Marshal(srcHighest)
		if err != nil {
			return fmt.Errorf("encode numbering floor: %w", err)
		}
		if err := filestore.WriteFileAtomic(filepath.Join(dstDir, floorName), data, filePerm); err != nil {
			return fmt.Errorf("write numbering floor: %w", err)
		}
	}

	numbers, err := pageNumbers(srcDir)
	if err != nil {
		return err
	}
	for _, n := range numbers {
		if n > through {
			break
		}
		src, dst := pagePath(srcDir, n), pagePath(dstDir, n)
		if err := os.Link(src, dst); err == nil || errors.Is(err, fs.ErrExist) {
			continue
		}
		data, err := os.ReadFile(src)
		if err != nil {
			return fmt.Errorf("read page: %w", err)
		}
		if err := filestore.WriteFileAtomic(dst, data, filePerm); err != nil {
			return fmt.Errorf("copy page: %w", err)
		}
	}
	return nil
}

func pagePath(dir string, n int) string {
	return filepath.Join(dir, strconv.Itoa(n)+pageExt)
}

func readPage(path string) (Page, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Page{}, fmt.Errorf("%w: %s", ErrNotFound, FormatID(numberOf(path)))
	}
	if err != nil {
		return Page{}, fmt.Errorf("read page: %w", err)
	}
	var page Page
	if err := json.Unmarshal(data, &page); err != nil {
		return Page{}, fmt.Errorf("decode page %s: %w", path, err)
	}
	return page, nil
}

func numberOf(path string) int {
	n, _ := strconv.Atoi(strings.TrimSuffix(filepath.Base(path), pageExt))
	return n
}

// pageNumbers are the numbers of the pages stored in dir, ascending. Anything
// else there — the lock files filestore's writes leave, a temp file a crash
// left — is not a page.
func pageNumbers(dir string) ([]int, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read page directory: %w", err)
	}
	var numbers []int
	for _, entry := range entries {
		digits, ok := strings.CutSuffix(entry.Name(), pageExt)
		if !ok || entry.IsDir() {
			continue
		}
		if n, ok := ParseID(idPrefix + digits); ok {
			numbers = append(numbers, n)
		}
	}
	sort.Ints(numbers)
	return numbers, nil
}

// highestPage is the number the next page in dir comes after: the highest
// page stored there, or a fork's numbering floor (Clone) if that is higher.
func highestPage(dir string) (int, error) {
	numbers, err := pageNumbers(dir)
	if err != nil {
		return 0, err
	}
	highest := 0
	if len(numbers) > 0 {
		highest = numbers[len(numbers)-1]
	}
	// A plain read, no lock: the floor is written once, atomically, before
	// the fork it belongs to has drawn anything.
	data, err := os.ReadFile(filepath.Join(dir, floorName))
	if errors.Is(err, fs.ErrNotExist) {
		return highest, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read numbering floor: %w", err)
	}
	var floor int
	if err := json.Unmarshal(data, &floor); err != nil {
		return 0, fmt.Errorf("decode numbering floor: %w", err)
	}
	return max(highest, floor), nil
}
