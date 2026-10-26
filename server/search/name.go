package search

import (
	"cmp"
	"math"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/pockode/server/fuzzy"
)

// searchNames fuzzy-matches the query against relative paths and returns the
// best maxResults by score. Ties break the way fzf's path scheme breaks them
// (docs/code/fuzzy-matching.md, "Ranking Is the Caller's"): pathname, then
// length, then list order.
func searchNames(workDir string, files []string, pattern *fuzzy.Pattern, maxResults int) ([]FileMatch, bool) {
	type candidate struct {
		path      string
		score     int
		pathname  int
		length    int
		positions []int
	}

	slab := fuzzy.NewSlab()
	var candidates []candidate
	for _, p := range files {
		chars := fuzzy.ToChars([]byte(p))
		score, positions, ok := pattern.Match(fuzzy.PathScheme, &chars, true, slab)
		if !ok {
			continue
		}
		candidates = append(candidates, candidate{
			path:      p,
			score:     score,
			pathname:  pathnameTiebreak(p, positions),
			length:    utf8.RuneCountInString(strings.TrimSpace(p)),
			positions: positions,
		})
	}

	// A query that parses to no terms (such as "'" alone) matches everything
	// with score 0; ranking by tiebreaks alone would just list the shortest
	// paths first, so the listing's own order is kept instead.
	if !pattern.IsEmpty() {
		slices.SortStableFunc(candidates, func(a, b candidate) int {
			return cmp.Or(
				cmp.Compare(b.score, a.score),
				cmp.Compare(a.pathname, b.pathname),
				cmp.Compare(a.length, b.length),
			)
		})
	}

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
		_, ranges := toClientText(c.path, positionsToByteRanges(c.path, c.positions))
		matches = append(matches, FileMatch{Path: c.path, Name: path.Base(c.path), PathRanges: ranges})
	}
	return matches, false
}

// pathnameTiebreak is fzf's pathname criterion, lower is better: a match that
// starts in the base name beats one that starts in a directory, and among base
// name matches the one starting closer to the last "/" wins. fzf compares a
// byte offset with a rune index here; both are rune indices in this port, which
// only differs from fzf on non-ASCII directory names.
func pathnameTiebreak(p string, positions []int) int {
	if len(positions) == 0 {
		return math.MaxInt
	}
	lastDelim := -1
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		lastDelim = utf8.RuneCountInString(p[:i])
	}
	if lastDelim > positions[0] {
		return math.MaxInt
	}
	return positions[0] - lastDelim
}

// positionsToByteRanges turns fuzzy.Pattern.Match positions — ascending rune
// indices, where an invalid UTF-8 byte counts as one rune just as it does for
// toClientText — into byte ranges of text, merging consecutive positions.
//
// The result is never nil, so that a Line matched without positions encodes
// its ranges as [] rather than null.
func positionsToByteRanges[T ~string | ~[]byte](text T, positions []int) []Range {
	ranges := make([]Range, 0, len(positions))
	next := 0
	for i, runeIdx := 0, 0; i < len(text) && next < len(positions); runeIdx++ {
		size := runeSize(text[i:])
		if runeIdx == positions[next] {
			if n := len(ranges); n > 0 && ranges[n-1].End == i {
				ranges[n-1].End = i + size
			} else {
				ranges = append(ranges, Range{Start: i, End: i + size})
			}
			next++
		}
		i += size
	}
	return ranges
}

// runeSize is the byte length of the rune text starts with, as ranging over
// it as a string decodes it.
func runeSize[T ~string | ~[]byte](text T) int {
	if text[0] < utf8.RuneSelf {
		return 1
	}
	// A rune is at most UTFMax bytes, so only that much is converted.
	_, size := utf8.DecodeRuneInString(string(text[:min(len(text), utf8.UTFMax)]))
	return size
}
