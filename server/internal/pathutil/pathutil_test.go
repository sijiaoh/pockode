package pathutil

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// IsAnchored is the gate every "stays inside this directory" check relies on,
// so the forms it must catch are pinned per platform rather than through the
// callers. The Windows-only forms are the point of the function: filepath.IsAbs
// calls them relative, yet joining them to a base directory does not confine
// them.
func TestIsAnchored(t *testing.T) {
	type testCase struct {
		name string
		path string
		want bool
	}

	tests := []testCase{
		{"empty", "", false},
		{"plain relative", "worktrees", false},
		{"nested relative", filepath.Join("a", "b"), false},
		{"dot relative", "." + string(filepath.Separator) + "worktrees", false},
		{"parent relative", ".." + string(filepath.Separator) + "worktrees", false},
		// Windows accepts `/` as a separator, so this is root-relative there and
		// absolute on Unix — anchored either way.
		{"forward-slash root", "/worktrees", true},
	}

	if runtime.GOOS == "windows" {
		tests = append(tests,
			testCase{"drive absolute", `C:\worktrees`, true},
			testCase{"UNC absolute", `\\host\share\worktrees`, true},
			testCase{"root-relative", `\worktrees`, true},
			testCase{"drive-relative", `C:worktrees`, true},
		)
	} else {
		// Backslash and colon are ordinary filename characters here, so none of
		// the Windows anchors mean anything: these are plain relative names.
		tests = append(tests,
			testCase{"backslash is a filename character", `\worktrees`, false},
			testCase{"colon is a filename character", `C:worktrees`, false},
		)
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsAnchored(tt.path); got != tt.want {
				t.Errorf("IsAnchored(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

// ChildName decides which worktrees Pockode manages and whether a requested
// name escapes its base directory, so its boundary cases are worth pinning down
// directly rather than only through the paths that use it.
func TestChildName(t *testing.T) {
	dir := absPath(t, "repo", "worktrees")

	tests := []struct {
		name       string
		path       string
		want       string
		wantInside bool
	}{
		{"direct child", filepath.Join(dir, "feature"), "feature", true},
		{"nested child", filepath.Join(dir, "team", "feature"), filepath.Join("team", "feature"), true},
		{"the directory itself", dir, "", false},
		// Without the separator in the prefix, a sibling whose name merely
		// starts with the base directory's name would be claimed as a child.
		{"sibling sharing a name prefix", filepath.Join(dir+"-other", "feature"), "", false},
		{"unrelated path", absPath(t, "elsewhere", "feature"), "", false},
		{"parent", absPath(t, "repo"), "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, inside := ChildName(tt.path, dir)
			if inside != tt.wantInside || got != tt.want {
				t.Errorf("ChildName(%q, %q) = (%q, %v), want (%q, %v)",
					tt.path, dir, got, inside, tt.want, tt.wantInside)
			}
		})
	}
}

// Windows resolves paths case-insensitively; Unix does not. Both directions are
// silent when wrong — a spurious match hands back the wrong directory, a missed
// match makes a managed worktree look external — so each platform asserts its
// own answer instead of the test skipping on the other.
func TestChildName_CaseSensitivity(t *testing.T) {
	dir := absPath(t, "Repo", "Worktrees")
	path := filepath.Join(absPath(t, "repo", "worktrees"), "Feature")

	got, inside := ChildName(path, dir)
	wantInside := runtime.GOOS == "windows"

	if inside != wantInside {
		t.Fatalf("ChildName(%q, %q) inside = %v, want %v", path, dir, inside, wantInside)
	}
	if wantInside && got != "Feature" {
		t.Errorf("ChildName(%q, %q) = %q, want %q", path, dir, got, "Feature")
	}
}

func TestTrimTildePrefix(t *testing.T) {
	type testCase struct {
		name     string
		path     string
		wantRest string
		wantOK   bool
	}

	tests := []testCase{
		{"bare tilde", "~", "", true},
		{"tilde slash", "~/projects", "projects", true},
		{"tilde slash nested", "~/a/b", "a/b", true},
		{"tilde slash only", "~/", "", true},
		{"empty", "", "", false},
		{"no tilde", "projects", "", false},
		{"tilde mid-path", "a/~/b", "", false},
		// `~user` is another user's home on Unix and nothing in particular on
		// Windows; either way it is not ours to expand.
		{"named home", "~root/x", "", false},
		{"tilde-prefixed name", "~backup", "", false},
	}

	// A backslash separates path segments only on Windows. Elsewhere
	// `~\projects` is one directory whose name contains a backslash, and
	// treating it as home-relative would address a different file.
	backslash := testCase{name: "tilde backslash", path: `~\projects`}
	if runtime.GOOS == "windows" {
		backslash.wantRest, backslash.wantOK = "projects", true
	}
	tests = append(tests, backslash)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rest, ok := TrimTildePrefix(tt.path)
			if ok != tt.wantOK || rest != tt.wantRest {
				t.Errorf("TrimTildePrefix(%q) = (%q, %v), want (%q, %v)",
					tt.path, rest, ok, tt.wantRest, tt.wantOK)
			}
		})
	}
}

func TestExpandTilde(t *testing.T) {
	type testCase struct {
		name string
		path string
		want string
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir() failed: %v", err)
	}

	tests := []testCase{
		{"bare tilde", "~", home},
		{"tilde slash", "~/projects", filepath.Join(home, "projects")},
		{"result is native", "~/a/b", filepath.Join(home, "a", "b")},
		{"untouched when not home-relative", "projects", "projects"},
		{"untouched when named home", "~root/x", "~root/x"},
		{"empty", "", ""},
	}

	// The reason this function exists: on Windows no shell expands `~` before
	// the value reaches us, so `~\projects` arrives verbatim and would otherwise
	// become a directory literally named `~`. On Unix the backslash is part of
	// the name and the value must survive untouched.
	backslash := testCase{name: "tilde backslash", path: `~\projects`, want: `~\projects`}
	if runtime.GOOS == "windows" {
		backslash.want = filepath.Join(home, "projects")
	}
	tests = append(tests, backslash)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ExpandTilde(tt.path); got != tt.want {
				t.Errorf("ExpandTilde(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

// absPath builds an absolute path on the current platform, so tests that mean
// to exercise absolute-path handling do not silently fall into a relative-path
// branch on Windows.
func absPath(t *testing.T, segments ...string) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd() failed: %v", err)
	}
	root := filepath.VolumeName(wd) + string(filepath.Separator)
	path := filepath.Join(append([]string{root}, segments...)...)
	if !filepath.IsAbs(path) {
		t.Fatalf("absPath(%v) = %q, which is not absolute on this platform", segments, path)
	}
	return path
}
