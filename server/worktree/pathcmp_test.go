package worktree

import (
	"path/filepath"
	"testing"
)

// childName decides both which worktrees Pockode manages and whether a
// requested name escapes the base directory, so its boundary cases are worth
// pinning down directly rather than only through the paths that use it.
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
			got, inside := childName(tt.path, dir)
			if inside != tt.wantInside || got != tt.want {
				t.Errorf("childName(%q, %q) = (%q, %v), want (%q, %v)",
					tt.path, dir, got, inside, tt.want, tt.wantInside)
			}
		})
	}
}
