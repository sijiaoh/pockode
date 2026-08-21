// Package search provides file name and file content search within a
// worktree's work directory.
package search

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pockode/server/contents"
)

var (
	ErrEmptyQuery   = errors.New("query is required")
	ErrQueryTooLong = errors.New("query is too long")
	ErrInvalidMode  = errors.New("invalid mode")
)

// Mode selects what a query is matched against.
type Mode string

const (
	ModeName    Mode = "name"
	ModeContent Mode = "content"
)

const (
	defaultMaxResults = 100
	maxMaxResults     = 500

	// A non-ASCII query is compiled into a regexp, which has its own size
	// ceiling; rejecting oversized input at the boundary gives a clear error
	// instead of a confusing "expression too large".
	maxQueryBytes = 1024

	// Searches run against a live repository from an interactive UI, so an
	// unbounded scan is never worth waiting for; partial results are returned
	// with Truncated set instead.
	searchTimeout = 10 * time.Second
)

// Range is a match position as byte offsets into Line.Text (end-exclusive).
// Offsets are byte-based, matching the UTF-8 encoding of Text.
type Range struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Line is a single matching line of a file.
type Line struct {
	// Number is the 1-based line number within the file.
	Number int `json:"number"`
	// Text is the line content, clipped to a window around the first match
	// when the line is very long.
	Text   string  `json:"text"`
	Ranges []Range `json:"ranges"`
}

// FileMatch is one matching file. Lines is empty in ModeName.
type FileMatch struct {
	Path  string `json:"path"`
	Name  string `json:"name"`
	Lines []Line `json:"lines,omitempty"`
}

// Result holds search matches. Truncated reports that limits or the timeout
// cut the search short, so more matches may exist.
type Result struct {
	Matches   []FileMatch `json:"matches"`
	Truncated bool        `json:"truncated"`
}

// Options configures a search. The zero value searches file names in the whole
// work directory, case-insensitively, without respecting gitignore.
type Options struct {
	Query string
	Mode  Mode
	// Path limits the search to a subdirectory, relative to the work directory.
	Path             string
	RespectGitignore bool
	CaseSensitive    bool
	// MaxResults caps the number of returned files. Non-positive means the
	// default; values above the hard cap are clamped.
	MaxResults int
}

// Search finds files by name or content under workDir.
// Returns ErrEmptyQuery, ErrQueryTooLong, ErrInvalidMode,
// contents.ErrInvalidPath or contents.ErrNotFound for bad input.
func Search(ctx context.Context, workDir string, opts Options) (Result, error) {
	if strings.TrimSpace(opts.Query) == "" {
		return Result{}, ErrEmptyQuery
	}
	if len(opts.Query) > maxQueryBytes {
		return Result{}, fmt.Errorf("%w: %d bytes, max %d", ErrQueryTooLong, len(opts.Query), maxQueryBytes)
	}

	if opts.Mode == "" {
		opts.Mode = ModeName
	}
	if opts.Mode != ModeName && opts.Mode != ModeContent {
		return Result{}, fmt.Errorf("%w: %s", ErrInvalidMode, opts.Mode)
	}

	scope, err := resolveScope(workDir, opts.Path)
	if err != nil {
		return Result{}, err
	}

	if opts.MaxResults <= 0 {
		opts.MaxResults = defaultMaxResults
	}
	opts.MaxResults = min(opts.MaxResults, maxMaxResults)

	m, err := newMatcher(opts.Query, opts.CaseSensitive)
	if err != nil {
		return Result{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, searchTimeout)
	defer cancel()

	files, listTruncated, err := listFiles(ctx, workDir, scope, opts.RespectGitignore)
	if err != nil {
		return Result{}, err
	}

	var matches []FileMatch
	var truncated bool
	if opts.Mode == ModeName {
		matches, truncated = searchNames(workDir, files, m, opts.MaxResults)
	} else {
		matches, truncated = searchContents(ctx, workDir, files, m, opts.MaxResults)
	}

	return Result{Matches: matches, Truncated: truncated || listTruncated}, nil
}

// resolveScope validates the requested subdirectory and normalizes it to a
// slash-separated path relative to workDir ("" for the whole work directory).
// Existence is checked here rather than during listing so that a bad path is
// reported the same way whichever listing strategy runs.
func resolveScope(workDir, path string) (string, error) {
	if err := contents.ValidatePath(workDir, path); err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	scope := filepath.ToSlash(filepath.Clean(path))
	if _, err := os.Stat(filepath.Join(workDir, filepath.FromSlash(scope))); err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("%w: %s", contents.ErrNotFound, path)
		}
		return "", fmt.Errorf("failed to stat search path: %w", err)
	}
	return scope, nil
}

// searchNames matches the query against relative paths, ranking base-name hits
// above path-only hits and shorter paths above longer ones.
func searchNames(workDir string, files []string, m *matcher, maxResults int) ([]FileMatch, bool) {
	type candidate struct {
		path      string
		name      string
		nameMatch bool
	}

	candidates := make([]candidate, 0, maxResults)
	for _, p := range files {
		if !m.matchString(p) {
			continue
		}
		name := path.Base(p)
		candidates = append(candidates, candidate{path: p, name: name, nameMatch: m.matchString(name)})
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].nameMatch != candidates[j].nameMatch {
			return candidates[i].nameMatch
		}
		return len(candidates[i].path) < len(candidates[j].path)
	})

	matches := make([]FileMatch, 0, min(len(candidates), maxResults))
	for _, c := range candidates {
		// The file list can name entries that are not readable regular files
		// (submodule gitlinks, tracked-but-deleted files); drop them here so
		// only results the client can actually open are returned.
		if !isRegularFile(filepath.Join(workDir, filepath.FromSlash(c.path))) {
			continue
		}
		if len(matches) >= maxResults {
			return matches, true
		}
		matches = append(matches, FileMatch{Path: c.path, Name: c.name})
	}
	return matches, false
}
