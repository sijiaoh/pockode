package settings

import "testing"

func TestValidateWorktreeBaseDir(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"empty uses default", "", false},
		{"absolute clean path", "/var/pockode/worktrees", false},
		{"repo-relative dot path", "./worktrees", false},
		{"repo-relative parent path", "../worktrees", false},
		{"repo-relative parent alone", "..", false},
		{"repo-relative deep parent", "../../shared/worktrees", false},
		{"home-relative path", "~/worktrees", false},
		{"home alone", "~", false},
		{"bare relative path rejected", "worktrees", true},
		{"repo-relative interior traversal rejected", "./a/../b", true},
		{"home-relative escape rejected", "~/../escape", true},
		{"traversal segment rejected", "/var/pockode/../worktrees", true},
		{"trailing separator rejected", "/var/worktrees/", true},
		{"redundant separator rejected", "/var//worktrees", true},
		{"home redundant separator rejected", "~//worktrees", true},
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
