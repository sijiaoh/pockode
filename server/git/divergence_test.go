package git

import (
	"reflect"
	"testing"
)

func TestVersionAtLeast(t *testing.T) {
	tests := []struct {
		output string
		want   bool
	}{
		{"git version 2.41.0", true},
		{"git version 2.43.0", true},
		{"git version 3.0.0", true},
		{"git version 2.45.1.windows.1", true},
		{"git version 2.39.5 (Apple Git-154)", false},
		{"git version 1.99.0", false},
		{"something else", false},
	}
	for _, tt := range tests {
		if got := versionAtLeast(tt.output, aheadBehindMinVersion); got != tt.want {
			t.Errorf("versionAtLeast(%q) = %v, want %v", tt.output, got, tt.want)
		}
	}
}

// The fallback has to count exactly what %(ahead-behind) does, or a user on an
// older git would see other numbers for the same branches. The base is an
// object id, as Branches passes it. The fallback's own counts are checked on
// any git: an older one is exactly where it runs.
func TestDivergences_FallbackMatchesForEachRef(t *testing.T) {
	dir, cleanup := setupTestRepoWithCommit(t)
	defer cleanup()
	runGit(t, dir, "branch", "-M", "main")
	runGit(t, dir, "checkout", "-q", "-b", "topic")
	runGit(t, dir, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "t1")
	runGit(t, dir, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "t2")
	runGit(t, dir, "checkout", "-q", "main")
	runGit(t, dir, "commit", "-q", "--no-gpg-sign", "--allow-empty", "-m", "m1")
	base, err := execGit(dir, "rev-parse", "refs/heads/main")
	if err != nil {
		t.Fatalf("rev-parse error: %v", err)
	}

	refs := []string{"refs/heads/main", "refs/heads/topic"}
	byRevList, err := divergencesByRevList(dir, base, refs)
	if err != nil {
		t.Fatalf("divergencesByRevList() error: %v", err)
	}
	if byRevList["refs/heads/topic"] != (Divergence{Ahead: 2, Behind: 1}) {
		t.Errorf("topic = %+v, want 2 ahead, 1 behind", byRevList["refs/heads/topic"])
	}

	native, err := gitHasAheadBehind()
	if err != nil {
		t.Fatalf("gitHasAheadBehind() error: %v", err)
	}
	if !native {
		t.Skip("git predates %(ahead-behind); nothing to compare the fallback with")
	}
	byForEachRef, err := divergencesByForEachRef(dir, base)
	if err != nil {
		t.Fatalf("divergencesByForEachRef() error: %v", err)
	}
	if !reflect.DeepEqual(byRevList, byForEachRef) {
		t.Errorf("fallback = %v, for-each-ref = %v", byRevList, byForEachRef)
	}
}
