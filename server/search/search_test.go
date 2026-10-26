package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/internal/symlinktest"
)

// writeTree materializes files (relative slash paths → content) under dir.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for p, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("failed to create dir for %s: %v", p, err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("failed to write %s: %v", p, err)
		}
	}
}

func matchedPaths(matches []FileMatch) []string {
	paths := make([]string, 0, len(matches))
	for _, m := range matches {
		paths = append(paths, m.Path)
	}
	return paths
}

func TestSearchName(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"web/src/hooks/useFileSearch.ts": "x",
		"web/src/hooks/useTheme.ts":      "x",
		"pkg/handler.go":                 "x",
		"vendor/lib/Handler.h":           "x",
	})

	tests := []struct {
		name string
		opts Options
		want []string
	}{
		{
			name: "fuzzy subsequence",
			opts: Options{Query: "usefs"},
			want: []string{"web/src/hooks/useFileSearch.ts"},
		},
		{
			name: "lowercase query ignores case",
			opts: Options{Query: "handler"},
			want: []string{"pkg/handler.go", "vendor/lib/Handler.h"},
		},
		{
			name: "uppercase letter makes the term case-sensitive",
			opts: Options{Query: "Handler"},
			want: []string{"vendor/lib/Handler.h"},
		},
		{
			name: "extended syntax",
			opts: Options{Query: "hooks !search"},
			want: []string{"web/src/hooks/useTheme.ts"},
		},
		{
			name: "no match",
			opts: Options{Query: "nonexistent"},
			want: []string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := Search(context.Background(), workDir, tt.opts)
			if err != nil {
				t.Fatalf("Search failed: %v", err)
			}
			got := matchedPaths(result.Matches)
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Errorf("got %v, want %v", got, tt.want)
			}
			if result.Truncated {
				t.Errorf("got Truncated = true, want false")
			}
		})
	}
}

// rankingTree is listed in alphabetical order (the order files are scored in)
// with the best match for "main" last, so a result that keeps list order or
// cuts before sorting fails.
var rankingTree = map[string]string{
	"a/xmxaxixn.txt":   "x",
	"b/domain/x.go":    "x",
	"c/main/README.md": "x",
	"d/main.go":        "x",
}

func TestSearchNameOrdersByScore(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, rankingTree)

	result, err := Search(context.Background(), workDir, Options{Query: "main"})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	// A whole word after "/" beats one inside a word, which beats letters
	// scattered over the path; between the two word matches the base name wins.
	want := []string{"d/main.go", "c/main/README.md", "b/domain/x.go", "a/xmxaxixn.txt"}
	if got := matchedPaths(result.Matches); !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestSearchNameTruncatesKeepingBest(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, rankingTree)

	result, err := Search(context.Background(), workDir, Options{Query: "main", MaxResults: 2})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	want := []string{"d/main.go", "c/main/README.md"}
	if got := matchedPaths(result.Matches); !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if !result.Truncated {
		t.Error("got Truncated = false, want true")
	}
}

func TestSearchNamePathRanges(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"web/src/hooks/useFileSearch.ts": "x",
		"docs/😀日本/notes.md":              "x",
	})

	tests := []struct {
		query string
		// want is each range's slice of the decoded path, the way a JS client
		// would cut it.
		want []string
	}{
		{query: "usefs", want: []string{"useF", "S"}},
		// The emoji is a surrogate pair, so UTF-16 offsets after it differ
		// from both rune and byte offsets.
		{query: "日本/n", want: []string{"日本/n"}},
		{query: "😀 notes", want: []string{"😀", "notes"}},
	}

	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			result, err := Search(context.Background(), workDir, Options{Query: tt.query})
			if err != nil {
				t.Fatalf("Search failed: %v", err)
			}
			if len(result.Matches) != 1 {
				t.Fatalf("got %v, want one match", matchedPaths(result.Matches))
			}

			encoded, err := json.Marshal(result.Matches[0])
			if err != nil {
				t.Fatalf("Marshal failed: %v", err)
			}
			var decoded FileMatch
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatalf("Unmarshal failed: %v", err)
			}

			got := make([]string, 0, len(decoded.PathRanges))
			for _, r := range decoded.PathRanges {
				got = append(got, sliceUTF16(decoded.Path, r))
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("got %q (ranges %+v), want %q", got, decoded.PathRanges, tt.want)
			}
		})
	}
}

func TestSearchContent(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"a.txt":       "first line\nneedle here\nlast line\n",
		"b.txt":       "needle needle\n",
		"c.txt":       "nothing to see\n",
		"sub/d.txt":   "a NEEDLE in sub\n",
		"binary.dat":  "before\x00needle after\n",
		"long.bin":    "\x00" + strings.Repeat("needle\n", binaryProbeBytes),
		"unicode.txt": "日本語 needle テスト\n",
	})

	result, err := Search(context.Background(), workDir, Options{Query: "needle", Mode: ModeContent})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}

	byPath := make(map[string]FileMatch)
	for _, m := range result.Matches {
		byPath[m.Path] = m
	}

	if _, ok := byPath["c.txt"]; ok {
		t.Error("c.txt has no match but was returned")
	}
	for _, binary := range []string{"binary.dat", "long.bin"} {
		if _, ok := byPath[binary]; ok {
			t.Errorf("binary file %s was searched, want it skipped", binary)
		}
	}

	a, ok := byPath["a.txt"]
	if !ok {
		t.Fatal("a.txt missing from results")
	}
	if len(a.Lines) != 1 || a.Lines[0].Number != 2 || a.Lines[0].Text != "needle here" {
		t.Errorf("got a.txt lines %+v, want single line 2 %q", a.Lines, "needle here")
	}
	if want := []Range{{Start: 0, End: 6}}; len(a.Lines[0].Ranges) != 1 || a.Lines[0].Ranges[0] != want[0] {
		t.Errorf("got a.txt ranges %+v, want %+v", a.Lines[0].Ranges, want)
	}

	// Like fzf, a line highlights the one occurrence it was scored by.
	b := byPath["b.txt"]
	if want := []Range{{Start: 0, End: 6}}; len(b.Lines) != 1 || !slices.Equal(b.Lines[0].Ranges, want) {
		t.Errorf("got b.txt lines %+v, want one line with ranges %+v", b.Lines, want)
	}

	if _, ok := byPath["sub/d.txt"]; !ok {
		t.Error("sub/d.txt missing: case-insensitive match failed")
	}

	u := byPath["unicode.txt"]
	if len(u.Lines) != 1 {
		t.Fatalf("got unicode.txt lines %+v, want one", u.Lines)
	}
	if want := []Range{{Start: 4, End: 10}}; !slices.Equal(u.Lines[0].Ranges, want) {
		t.Errorf("got unicode.txt ranges %+v, want %+v", u.Lines[0].Ranges, want)
	}
}

func TestSearchContentSmartCase(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"lower.txt": "needle école\n",
		"upper.txt": "NEEDLE ÉCOLE\n",
	})

	tests := []struct {
		query string
		want  []string
	}{
		{query: "needle", want: []string{"lower.txt", "upper.txt"}},
		{query: "NEEDLE", want: []string{"upper.txt"}},
		{query: "école", want: []string{"lower.txt", "upper.txt"}},
		{query: "ÉCOLE", want: []string{"upper.txt"}},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			result, err := Search(context.Background(), workDir, Options{Query: tt.query, Mode: ModeContent})
			if err != nil {
				t.Fatalf("Search failed: %v", err)
			}
			if got := matchedPaths(result.Matches); !slices.Equal(got, tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

// Ranges must index the text the client decodes from JSON, including on lines
// whose invalid UTF-8 bytes json turns into U+FFFD.
func TestSearchContentRangesIndexDecodedText(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		// Past the binary probe, which would reject the file outright.
		"a.txt": strings.Repeat("ok\n", binaryProbeBytes) + "\xff\xfe 😀 needle \xe6\x97 NEEDLE\n",
	})

	// Two exact terms, so that two ranges land past the invalid bytes.
	result, err := Search(context.Background(), workDir, Options{Query: "'needle 'NEEDLE", Mode: ModeContent})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	var decoded Result
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}

	line := decoded.Matches[0].Lines[0]
	if len(line.Ranges) != 2 {
		t.Fatalf("got ranges %+v, want two", line.Ranges)
	}
	for i, want := range []string{"needle", "NEEDLE"} {
		if got := sliceUTF16(line.Text, line.Ranges[i]); got != want {
			t.Errorf("got %q at range %+v in %q, want %q", got, line.Ranges[i], line.Text, want)
		}
	}
}

func TestSearchContentSkipsLargeFiles(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"big.txt":   strings.Repeat("a", maxFileSize) + "\nneedle\n",
		"small.txt": "needle\n",
	})

	result, err := Search(context.Background(), workDir, Options{Query: "needle", Mode: ModeContent})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if got := matchedPaths(result.Matches); len(got) != 1 || got[0] != "small.txt" {
		t.Errorf("got %v, want [small.txt]", got)
	}
}

// The line here is nearly maxFileSize, so this also covers the scanner's token
// ceiling: too small a ceiling would drop the file's matches silently.
func TestSearchContentClipsLongLines(t *testing.T) {
	workDir := t.TempDir()
	half := strings.Repeat("x", (maxFileSize-len("needle"))/2-1)
	writeTree(t, workDir, map[string]string{
		"long.txt": half + "needle" + half + "\n",
	})

	result, err := Search(context.Background(), workDir, Options{Query: "needle", Mode: ModeContent})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(result.Matches) != 1 {
		t.Fatalf("got %d matches, want 1", len(result.Matches))
	}

	line := result.Matches[0].Lines[0]
	if len(line.Text) > maxLineBytes {
		t.Errorf("got text of %d bytes, want at most %d", len(line.Text), maxLineBytes)
	}
	if len(line.Ranges) != 1 {
		t.Fatalf("got ranges %+v, want one", line.Ranges)
	}
	if got := sliceUTF16(line.Text, line.Ranges[0]); got != "needle" {
		t.Errorf("got %q at clipped range, want %q", got, "needle")
	}
}

// Clipping counts bytes and the ranges count UTF-16 units, so a window cut
// from multi-byte text must still yield ranges that land on the match.
func TestSearchContentClipsMultibyteLines(t *testing.T) {
	workDir := t.TempDir()
	pad := strings.Repeat("日😀", maxLineBytes)
	writeTree(t, workDir, map[string]string{
		"long.txt": pad + "needle" + pad + "\n",
	})

	result, err := Search(context.Background(), workDir, Options{Query: "needle", Mode: ModeContent})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	line := result.Matches[0].Lines[0]
	if !utf8.ValidString(line.Text) {
		t.Errorf("clipped text %q is not valid UTF-8", line.Text)
	}
	if len(line.Ranges) != 1 {
		t.Fatalf("got ranges %+v, want one", line.Ranges)
	}
	if got := sliceUTF16(line.Text, line.Ranges[0]); got != "needle" {
		t.Errorf("got %q at clipped range, want %q", got, "needle")
	}
}

func TestSearchContentCapsLinesPerFile(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"many.txt": strings.Repeat("needle\n", maxLinesPerFile+5),
	})

	result, err := Search(context.Background(), workDir, Options{Query: "needle", Mode: ModeContent})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if got := len(result.Matches[0].Lines); got != maxLinesPerFile {
		t.Errorf("got %d lines, want %d", got, maxLinesPerFile)
	}
	if !result.Truncated {
		t.Error("got Truncated = false, want true")
	}
}

func searchContent(t *testing.T, workDir string, opts Options) Result {
	t.Helper()
	opts.Mode = ModeContent
	result, err := Search(context.Background(), workDir, opts)
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	return result
}

// Content mode takes name mode's query language, with a line as the text every
// term has to match within.
func TestSearchContentQuerySyntax(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"const.go": "\tsearchTimeout = 10 * time.Second\n",
		"split.go": "search\ntimeout\n",
		"test.go":  "// searchTimeout under test\n",
	})

	tests := []struct {
		query string
		want  []string
	}{
		{query: "search timeout", want: []string{"const.go", "test.go"}},
		{query: "stmo", want: []string{"const.go", "test.go"}},
		{query: "'searchtimeout", want: []string{"const.go", "test.go"}},
		{query: "'stmo"},
		{query: "searchTimeout !test", want: []string{"const.go"}},
		// As in fzf, ^ skips the line's leading whitespace: indentation.
		{query: "^search", want: []string{"const.go", "split.go"}},
		{query: "Second$", want: []string{"const.go"}},
		{query: "'SEARCH"},
		{query: "zzz | ^timeout", want: []string{"split.go"}},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			got := matchedPaths(searchContent(t, workDir, Options{Query: tt.query}).Matches)
			slices.Sort(got)
			if !slices.Equal(got, tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSearchContentRanksFilesByBestLine(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		// Listed first, so only ranking can put the others ahead of it.
		"a.txt": "sxexaxrxcxh\n",
		"b.txt": "researching\n",
		// One scattered line and one whole word: the word ranks the file.
		"c.txt": "s.e.a.r.c.h\nfind search here\n",
		// The same best line as c.txt ties, and ties keep the listing's order.
		"d.txt": "search here find\n",
	})

	result := searchContent(t, workDir, Options{Query: "search"})
	want := []string{"c.txt", "d.txt", "b.txt", "a.txt"}
	if got := matchedPaths(result.Matches); !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if lines := result.Matches[0].Lines; len(lines) != 2 || lines[0].Number != 1 || lines[1].Number != 2 {
		t.Errorf("got c.txt lines %+v, want lines 1 and 2 in order", lines)
	}
}

func TestSearchContentTruncatesKeepingBest(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"a.txt": "sxexaxrxcxh\n",
		"b.txt": "researching\n",
		"c.txt": "search\n",
	})

	result := searchContent(t, workDir, Options{Query: "search", MaxResults: 2})
	want := []string{"c.txt", "b.txt"}
	if got := matchedPaths(result.Matches); !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if !result.Truncated {
		t.Error("got Truncated = false, want true")
	}
}

// Ranking holds across chunks and the trims made while scanning: a better file
// in a later chunk still wins, and among ties the earliest listed survives.
func TestSearchContentRanksAcrossChunks(t *testing.T) {
	workDir := t.TempDir()
	files := make(map[string]string)
	for i := range chunkSize + 1 {
		files[fmt.Sprintf("f%03d.txt", i)] = "sxexaxrxcxh\n"
	}
	files[fmt.Sprintf("f%03d.txt", chunkSize+1)] = "search\n"
	writeTree(t, workDir, files)

	result := searchContent(t, workDir, Options{Query: "search", MaxResults: 2})
	want := []string{fmt.Sprintf("f%03d.txt", chunkSize+1), "f000.txt"}
	if got := matchedPaths(result.Matches); !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if !result.Truncated {
		t.Error("got Truncated = false, want true")
	}
}

// A query that parses to no terms matches every line without marking any
// characters, and the files come in the listing's order.
func TestSearchContentNoTerms(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"a.txt": "one\n",
		"b.txt": "two\n",
		"c.txt": "three\n",
	})

	result := searchContent(t, workDir, Options{Query: "'", MaxResults: 2})
	if got, want := matchedPaths(result.Matches), []string{"a.txt", "b.txt"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if !result.Truncated {
		t.Error("got Truncated = false, want true")
	}
	if line := result.Matches[0].Lines[0]; line.Ranges == nil || len(line.Ranges) != 0 {
		t.Errorf("got ranges %+v, want empty (not null)", line.Ranges)
	}
}

// A file with more matching lines than are kept shows its best ones, still in
// line order, so the lines that ranked it are among those shown, and
// ranks them so a client showing fewer can pick the best. Equal scores rank
// the earlier line first, and also decide which of them is dropped.
func TestSearchContentKeepsBestLines(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"many.txt": strings.Repeat("sxexaxrxcxh\n", maxLinesPerFile) + "search\n" + "sxexaxrxcxh\n",
	})

	result := searchContent(t, workDir, Options{Query: "search"})
	lines := result.Matches[0].Lines
	if len(lines) != maxLinesPerFile {
		t.Fatalf("got %d lines, want %d", len(lines), maxLinesPerFile)
	}
	if got := lines[len(lines)-1]; got.Number != maxLinesPerFile+1 || got.Text != "search" {
		t.Errorf("got last line %+v, want line %d %q", got, maxLinesPerFile+1, "search")
	}
	if !slices.IsSortedFunc(lines, func(a, b Line) int { return a.Number - b.Number }) {
		t.Errorf("got lines out of order: %+v", lines)
	}
	// Lines 1..19 survive with equal scores, the 20th is the one dropped.
	for i, l := range lines[:len(lines)-1] {
		if l.Number != i+1 || l.Rank != i+1 {
			t.Errorf("got line %d with rank %d, want line %d with rank %d", l.Number, l.Rank, i+1, i+1)
		}
	}
	if got := lines[len(lines)-1].Rank; got != 0 {
		t.Errorf("got best line rank %d, want 0", got)
	}
	if !result.Truncated {
		t.Error("got Truncated = false, want true")
	}
}

// Fuzzy ranges mark each matched character, in UTF-16 units past characters
// that take two of them.
func TestSearchContentFuzzyRanges(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"a.txt": "😀 é searchTimeout\r\n",
	})

	line := searchContent(t, workDir, Options{Query: "stmo"}).Matches[0].Lines[0]
	if line.Text != "😀 é searchTimeout" {
		t.Errorf("got text %q, want the line without its line break", line.Text)
	}
	var got strings.Builder
	for _, r := range line.Ranges {
		got.WriteString(sliceUTF16(line.Text, r))
	}
	if got.String() != "sTmo" {
		t.Errorf("got %q marked by ranges %+v, want %q", got.String(), line.Ranges, "sTmo")
	}
}

// A query of only exclusions matches lines without marking any characters,
// long ones included.
func TestSearchContentExclusionOnly(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"a.txt": "needle\n" + strings.Repeat("x", 2*maxLineBytes) + "\n",
	})

	result := searchContent(t, workDir, Options{Query: "!needle"})
	lines := result.Matches[0].Lines
	if len(lines) != 1 || lines[0].Number != 2 || lines[0].Ranges == nil || len(lines[0].Ranges) != 0 {
		t.Fatalf("got lines %+v, want line 2 with empty (not null) ranges", lines)
	}
	if len(lines[0].Text) != maxLineBytes {
		t.Errorf("got text of %d bytes, want it clipped to %d", len(lines[0].Text), maxLineBytes)
	}
}

func TestSearchGitignore(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		".gitignore":            "ignored/\n",
		"tracked.txt":           "needle\n",
		"ignored/generated.txt": "needle\n",
	})

	initGitRepo(t, workDir, "tracked.txt")

	tests := []struct {
		name             string
		respectGitignore bool
		wantIgnored      bool
	}{
		{name: "respecting gitignore hides ignored files", respectGitignore: true, wantIgnored: false},
		{name: "ignoring gitignore includes ignored files", respectGitignore: false, wantIgnored: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, mode := range []Mode{ModeName, ModeContent} {
				query := "needle"
				if mode == ModeName {
					query = ".txt"
				}
				result, err := Search(context.Background(), workDir, Options{
					Query:            query,
					Mode:             mode,
					RespectGitignore: tt.respectGitignore,
				})
				if err != nil {
					t.Fatalf("Search(%s) failed: %v", mode, err)
				}
				got := matchedPaths(result.Matches)
				hasIgnored := slices.Contains(got, "ignored/generated.txt")
				if hasIgnored != tt.wantIgnored {
					t.Errorf("mode %s: got %v, want ignored/generated.txt present = %v", mode, got, tt.wantIgnored)
				}
				if !slices.Contains(got, "tracked.txt") {
					t.Errorf("mode %s: got %v, want tracked.txt present", mode, got)
				}
			}
		})
	}
}

// A search that ran out of time must never look like a complete one, or the
// client would show "no more results" for a scan that never finished.
func TestSearchCancelledReportsTruncated(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{"a.txt": "needle\n"})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	for _, mode := range []Mode{ModeName, ModeContent} {
		result, err := Search(ctx, workDir, Options{Query: "needle", Mode: mode})
		if err != nil {
			t.Fatalf("Search(%s) failed: %v", mode, err)
		}
		if !result.Truncated {
			t.Errorf("mode %s: got Truncated = false, want true", mode)
		}
	}
}

// The two listing strategies scope a subdirectory in completely different ways
// — git lists the whole repository and the prefix is filtered afterwards, while
// the walker is simply rooted at the subdirectory — so both need checking.
func TestSearchPathScope(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		"src/needle.txt":      "needle\n",
		"srcx/needle.txt":     "needle\n",
		"other/needle.txt":    "needle\n",
		"src/deep/needle.txt": "needle\n",
	})
	initGitRepo(t, workDir, ".")

	for _, respectGitignore := range []bool{true, false} {
		for _, mode := range []Mode{ModeName, ModeContent} {
			result, err := Search(context.Background(), workDir, Options{
				Query:            "needle",
				Mode:             mode,
				Path:             "src",
				RespectGitignore: respectGitignore,
			})
			if err != nil {
				t.Fatalf("Search(%s, gitignore=%v) failed: %v", mode, respectGitignore, err)
			}
			got := matchedPaths(result.Matches)
			slices.Sort(got)
			want := []string{"src/deep/needle.txt", "src/needle.txt"}
			if !slices.Equal(got, want) {
				t.Errorf("mode %s, gitignore=%v: got %v, want %v", mode, respectGitignore, got, want)
			}
		}
	}
}

func TestSearchInvalidInput(t *testing.T) {
	// A git repo, so the missing-path cases cover both listing strategies:
	// the error must not depend on whether git or the walker enumerates files.
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{"tracked.txt": "x"})
	initGitRepo(t, workDir, "tracked.txt")

	tests := []struct {
		name string
		opts Options
		want error
	}{
		{name: "empty query", opts: Options{Query: "  "}, want: ErrEmptyQuery},
		{name: "oversized query", opts: Options{Query: strings.Repeat("x", maxQueryBytes+1)}, want: ErrQueryTooLong},
		{name: "unknown mode", opts: Options{Query: "x", Mode: "regex"}, want: ErrInvalidMode},
		{name: "path traversal", opts: Options{Query: "x", Path: "../escape"}, want: contents.ErrInvalidPath},
		{name: "absolute path", opts: Options{Query: "x", Path: "/etc"}, want: contents.ErrInvalidPath},
		{name: "missing path", opts: Options{Query: "x", Path: "nope"}, want: contents.ErrNotFound},
		{name: "missing path with gitignore", opts: Options{Query: "x", Path: "nope", RespectGitignore: true}, want: contents.ErrNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Search(context.Background(), workDir, tt.opts)
			if !errors.Is(err, tt.want) {
				t.Errorf("got error %v, want %v", err, tt.want)
			}
		})
	}
}

// Symlinks must never be read: following one would let a search return content
// from outside the work directory, bypassing the path validation that guards
// every other file operation.
func TestSearchSkipsGitDirAndSymlinks(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{"real.txt": "needle\n"})
	initGitRepo(t, workDir, "real.txt")
	writeTree(t, workDir, map[string]string{".git/leak.txt": "needle\n"})

	outside := t.TempDir()
	writeTree(t, outside, map[string]string{"secret.txt": "needle\n"})
	symlinktest.Make(t, filepath.Join(outside, "secret.txt"), filepath.Join(workDir, "link.txt"))

	for _, respectGitignore := range []bool{true, false} {
		result, err := Search(context.Background(), workDir, Options{
			Query:            "needle",
			Mode:             ModeContent,
			RespectGitignore: respectGitignore,
		})
		if err != nil {
			t.Fatalf("Search failed: %v", err)
		}
		if got := matchedPaths(result.Matches); len(got) != 1 || got[0] != "real.txt" {
			t.Errorf("respectGitignore=%v: got %v, want [real.txt]", respectGitignore, got)
		}
	}
}

// A linked worktree — the shape Pockode itself runs in — has .git as a file
// pointing at the real git dir, not a directory, and it must be just as
// invisible to a search as the directory form is.
func TestSearchSkipsGitLinkFile(t *testing.T) {
	workDir := t.TempDir()
	writeTree(t, workDir, map[string]string{
		".git":     "gitdir: /elsewhere/.git/worktrees/needle\n",
		"real.txt": "needle\n",
	})

	// Only the walking strategy can reach it: git never lists .git itself.
	result, err := Search(context.Background(), workDir, Options{
		Query: "needle",
		Mode:  ModeContent,
	})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if got := matchedPaths(result.Matches); len(got) != 1 || got[0] != "real.txt" {
		t.Errorf("got %v, want [real.txt]", got)
	}
}

func initGitRepo(t *testing.T, dir string, add ...string) {
	t.Helper()
	cmds := [][]string{
		{"git", "init"},
		{"git", "config", "user.email", "test@test.com"},
		{"git", "config", "user.name", "Test"},
	}
	cmds = append(cmds, append([]string{"git", "add"}, add...))
	cmds = append(cmds, []string{"git", "commit", "--no-gpg-sign", "-m", "initial"})

	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("failed to run %v: %v\n%s", args, err, out)
		}
	}
}
