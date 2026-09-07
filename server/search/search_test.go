package search

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/contents"
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
		"main.go":              "package main",
		"pkg/handler.go":       "package pkg",
		"pkg/handler_test.go":  "package pkg",
		"handler/README.md":    "docs",
		"vendor/lib/Handler.h": "header",
	})

	tests := []struct {
		name string
		opts Options
		want []string
	}{
		{
			name: "matches base name and path, base name first",
			opts: Options{Query: "handler"},
			want: []string{"pkg/handler.go", "pkg/handler_test.go", "vendor/lib/Handler.h", "handler/README.md"},
		},
		{
			name: "case sensitive excludes different casing",
			opts: Options{Query: "Handler", CaseSensitive: true},
			want: []string{"vendor/lib/Handler.h"},
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

func TestSearchNameTruncates(t *testing.T) {
	workDir := t.TempDir()
	files := make(map[string]string)
	for _, name := range []string{"a_hit.go", "b_hit.go", "c_hit.go"} {
		files[name] = "x"
	}
	writeTree(t, workDir, files)

	result, err := Search(context.Background(), workDir, Options{Query: "hit", MaxResults: 2})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(result.Matches) != 2 {
		t.Errorf("got %d matches, want 2", len(result.Matches))
	}
	if !result.Truncated {
		t.Error("got Truncated = false, want true")
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
	if _, ok := byPath["binary.dat"]; ok {
		t.Error("binary file was searched, want it skipped")
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

	b := byPath["b.txt"]
	if len(b.Lines) != 1 || len(b.Lines[0].Ranges) != 2 {
		t.Errorf("got b.txt lines %+v, want one line with two ranges", b.Lines)
	}

	if _, ok := byPath["sub/d.txt"]; !ok {
		t.Error("sub/d.txt missing: case-insensitive match failed")
	}

	// Ranges are byte offsets into Text, so multi-byte prefixes must be counted
	// in bytes rather than runes.
	u := byPath["unicode.txt"]
	if len(u.Lines) != 1 {
		t.Fatalf("got unicode.txt lines %+v, want one", u.Lines)
	}
	r := u.Lines[0].Ranges[0]
	if got := u.Lines[0].Text[r.Start:r.End]; got != "needle" {
		t.Errorf("got %q at range %+v, want %q", got, r, "needle")
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
	if got := line.Text[line.Ranges[0].Start:line.Ranges[0].End]; got != "needle" {
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
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(workDir, "link.txt")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

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
