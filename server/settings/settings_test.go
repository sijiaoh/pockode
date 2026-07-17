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
		{"relative path rejected", "worktrees", true},
		{"relative dot path rejected", "./worktrees", true},
		{"traversal segment rejected", "/var/pockode/../worktrees", true},
		{"trailing separator rejected", "/var/worktrees/", true},
		{"redundant separator rejected", "/var//worktrees", true},
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
