// Package search provides file name and file content search within a
// worktree's work directory.
package search

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/fuzzy"
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

// Range is a match position in the string it accompanies (Line.Text, or
// FileMatch.Path for PathRanges), end-exclusive, in UTF-16 code units: the unit
// JS string indexes count, so the client can slice that string with it
// directly. Inside this package ranges are byte offsets, and toClientText
// converts on the way out.
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

// FileMatch is one matching file. Lines is set in ModeContent only; PathRanges
// in ModeName only, and only when the query matched characters of Path (a
// query of nothing but exclusions, such as "!test", matches without any).
type FileMatch struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	PathRanges []Range `json:"path_ranges,omitempty"`
	Lines      []Line  `json:"lines,omitempty"`
}

// Result holds search matches. Truncated reports that limits or the timeout
// cut the search short, so more matches may exist.
type Result struct {
	Matches   []FileMatch `json:"matches"`
	Truncated bool        `json:"truncated"`
}

// Options configures a search. The zero value searches file names in the whole
// work directory without respecting gitignore.
//
// Case is smart-case in both modes, as in fzf: a query (in ModeName, each
// space-separated term) is case-sensitive exactly when it contains an
// uppercase letter.
type Options struct {
	Query string
	Mode  Mode
	// Path limits the search to a subdirectory, relative to the work directory.
	Path             string
	RespectGitignore bool
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

	// The query is prepared before listing so that a bad one fails without
	// paying for enumeration.
	var pattern *fuzzy.Pattern
	var m *matcher
	if opts.Mode == ModeName {
		pattern = fuzzy.ParsePattern(opts.Query)
	} else {
		// One literal is one term, so smart-case reads the whole query: the
		// same test fuzzy.ParsePattern applies per term in ModeName.
		m, err = newMatcher(opts.Query, opts.Query != strings.ToLower(opts.Query))
		if err != nil {
			return Result{}, err
		}
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
		matches, truncated = searchNames(workDir, files, pattern, opts.MaxResults)
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
