package settings

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestValidateWorktreeBaseDir(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"empty uses default", "", false},
		{"repo-relative dot path", "./worktrees", false},
		{"repo-relative parent path", "../worktrees", false},
		{"repo-relative parent alone", "..", false},
		{"repo-relative deep parent", "../../shared/worktrees", false},
		{"home-relative path", "~/worktrees", false},
		{"home alone", "~", false},
		{"bare relative path rejected", "worktrees", true},
		{"repo-relative interior traversal rejected", "./a/../b", true},
		{"home-relative escape rejected", "~/../escape", true},
		{"home-relative deep escape rejected", "~/a/../../escape", true},
		{"home-relative rooted remainder rejected", "~//worktrees", true},
		{"trailing separator rejected", "./worktrees/", true},
		{"redundant separator rejected", "./var//worktrees", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateWorktreeBaseDir(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateWorktreeBaseDir(%q) error = %v, wantErr = %v", tt.path, err, tt.wantErr)
			}
		})
	}
}

// Absolute paths are spelled differently per platform, so they are checked
// against the running platform's forms rather than in the shared table above.
func TestValidateWorktreeBaseDir_Absolute(t *testing.T) {
	type testCase struct {
		name    string
		path    string
		wantErr bool
	}

	tests := []testCase{
		{"clean path", "/var/pockode/worktrees", false},
		{"traversal segment rejected", "/var/pockode/../worktrees", true},
		{"trailing separator rejected", "/var/worktrees/", true},
		{"redundant separator rejected", "/var//worktrees", true},
	}
	if runtime.GOOS == "windows" {
		tests = []testCase{
			{"clean drive path", `C:\pockode\worktrees`, false},
			{"clean drive path with forward slashes", "C:/pockode/worktrees", false},
			{"clean UNC path", `\\host\share\worktrees`, false},
			{"traversal segment rejected", `C:\pockode\..\worktrees`, true},
			{"trailing separator rejected", `C:\worktrees\`, true},
			{"redundant separator rejected", `C:\\worktrees`, true},
			{"drive-relative path rejected", `C:worktrees`, true},
			{"root-relative path rejected", `\worktrees`, true},
		}
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateWorktreeBaseDir(tt.path)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateWorktreeBaseDir(%q) error = %v, wantErr = %v", tt.path, err, tt.wantErr)
			}
		})
	}
}

// Windows users write `\` and cross-platform configs write `/`, so the two
// spellings must reach the same verdict: otherwise the most common setting
// (`../worktrees`) is unusable on Windows, or a traversal spelled the other way
// slips through. Which verdict is correct is the table above's job.
func TestValidateWorktreeBaseDir_SeparatorSpellingsAgree(t *testing.T) {
	paths := []string{
		"./worktrees",
		"../worktrees",
		"../../shared/worktrees",
		"~/worktrees",
		"./a/../b",
		"~/../escape",
		"~//worktrees",
		"worktrees/nested",
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			native := filepath.FromSlash(path)

			slashedErr := ValidateWorktreeBaseDir(path)
			nativeErr := ValidateWorktreeBaseDir(native)
			if (slashedErr != nil) != (nativeErr != nil) {
				t.Errorf("verdicts disagree: %q -> %v, %q -> %v", path, slashedErr, native, nativeErr)
			}
		})
	}
}
