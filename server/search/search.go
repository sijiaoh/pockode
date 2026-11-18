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

	// A query is matched against every line of a repository, at a cost that
	// grows with its length; no one types one this long, so a longer one is
	// rejected at the boundary rather than left to run into the timeout.
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
	// Rank orders the file's lines by score, 0 for its best: Lines stay in
	// line order for reading, and Rank says which of them earned the file its
	// place, so a client showing only a few can show those. Ties go to the
	// earlier line. A rank rather than the score itself, so that, as with the
	// order of Matches, the scoring scale stays the server's own.
	Rank int `json:"rank"`
}

// FileMatch is one matching file. Lines is set in ModeContent only, in line
// order; PathRanges in ModeName only. Either set of ranges is empty when the
// query matched no characters (a query of nothing but exclusions, such as
// "!test", matches without any).
type FileMatch struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	PathRanges []Range `json:"path_ranges,omitempty"`
	Lines      []Line  `json:"lines,omitempty"`
	// Link is set when the match is a symlink, which only ModeName lists.
	Link *contents.Link `json:"link,omitempty"`
	// Type is set with Link: the entry's type as a directory listing gives it
	// (a followed link takes its target's), which a path alone cannot say.
	Type contents.EntryType `json:"type,omitempty"`
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
// Both modes take the same query, fzf's extended search syntax
// (fuzzy.ParsePattern): ModeName matches it against each relative path,
// ModeContent against each line of each file, where every term has to match
// within one line. Results are ranked by score; in ModeContent a file ranks by
// its best line.
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

	pattern := fuzzy.ParsePattern(opts.Query)

	ctx, cancel := context.WithTimeout(ctx, searchTimeout)
	defer cancel()

	files, listTruncated, err := listFiles(ctx, workDir, scope, opts.RespectGitignore)
	if err != nil {
		return Result{}, err
	}

	// Every listed path is looked up through the work directory's root. A
	// listing can name a path whose parent has since become a link out — git
	// keeps `a/b.txt` in its index after `a` is replaced by one — and a plain
	// lookup would follow it, reading and naming files outside.
	work, err := os.OpenRoot(workDir)
	if err != nil {
		return Result{}, fmt.Errorf("failed to open the work directory: %w", err)
	}
	defer work.Close()

	var matches []FileMatch
	var truncated bool
	if opts.Mode == ModeName {
		matches, truncated = searchNames(workDir, work, files, pattern, opts.MaxResults)
	} else {
		matches, truncated = searchContents(ctx, work, files, pattern, opts.MaxResults)
	}

	return Result{Matches: matches, Truncated: truncated || listTruncated}, nil
}

// resolveScope validates the requested subdirectory and normalizes it to the
// slash-separated real path it names relative to workDir ("" for the whole
// work directory). Existence is checked here rather than during listing so
// that a bad path is reported the same way whichever listing strategy runs.
//
// Links on the way are followed only inside workDir, as on every file route:
// a scope through a link out would otherwise walk, and read, outside it. A
// scope through a link inside is searched at its real path, which is where
// git lists those files too.
func resolveScope(workDir, path string) (string, error) {
	if path == "" {
		return "", contents.ValidatePath(workDir, path)
	}

	res, err := contents.Resolve(workDir, path)
	if err != nil {
		return "", err
	}
	if res.Link != nil && !res.Link.Followable() {
		return "", contents.LinkRefusal(path, res.Link.State)
	}
	if res.Real == "." {
		return "", nil
	}
	return filepath.ToSlash(res.Real), nil
}
