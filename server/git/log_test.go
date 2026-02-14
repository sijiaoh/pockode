package git

import (
	"testing"
)

func TestParseLogOutput(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []Commit
	}{
		{
			name:     "empty input",
			input:    "",
			expected: []Commit{},
		},
		{
			name: "single commit without body",
			input: `---COMMIT_START---
d6f9947789f16ed6736042f10d58271c23b36ad0
Merge branch 'feature/settings-registry-v2'
---BODY_START---
---BODY_END---
sijiaoh
2026-02-14T12:08:43+09:00
---COMMIT_END---`,
			expected: []Commit{
				{
					Hash:    "d6f9947789f16ed6736042f10d58271c23b36ad0",
					Subject: "Merge branch 'feature/settings-registry-v2'",
					Body:    "",
					Author:  "sijiaoh",
					Date:    "2026-02-14T12:08:43+09:00",
				},
			},
		},
		{
			name: "single commit with body",
			input: `---COMMIT_START---
1d35cb97443e41199cddc35f34d578e57bb268e2
Decouple watchers from WebSocket dependency with Notifier interface
---BODY_START---
Introduce watch.Notifier interface to abstract notification mechanism,
allowing non-WebSocket clients (agent teams, internal goroutines) to
subscribe to watchers.
---BODY_END---
sijiaoh
2026-02-14T12:04:08+09:00
---COMMIT_END---`,
			expected: []Commit{
				{
					Hash:    "1d35cb97443e41199cddc35f34d578e57bb268e2",
					Subject: "Decouple watchers from WebSocket dependency with Notifier interface",
					Body:    "Introduce watch.Notifier interface to abstract notification mechanism,\nallowing non-WebSocket clients (agent teams, internal goroutines) to\nsubscribe to watchers.",
					Author:  "sijiaoh",
					Date:    "2026-02-14T12:04:08+09:00",
				},
			},
		},
		{
			name: "multiple commits",
			input: `---COMMIT_START---
aaaa111122223333444455556666777788889999
First commit
---BODY_START---
---BODY_END---
author1
2026-01-01T10:00:00+09:00
---COMMIT_END---
---COMMIT_START---
bbbb111122223333444455556666777788889999
Second commit
---BODY_START---
Some body text
---BODY_END---
author2
2026-01-02T10:00:00+09:00
---COMMIT_END---`,
			expected: []Commit{
				{
					Hash:    "aaaa111122223333444455556666777788889999",
					Subject: "First commit",
					Body:    "",
					Author:  "author1",
					Date:    "2026-01-01T10:00:00+09:00",
				},
				{
					Hash:    "bbbb111122223333444455556666777788889999",
					Subject: "Second commit",
					Body:    "Some body text",
					Author:  "author2",
					Date:    "2026-01-02T10:00:00+09:00",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseLogOutput(tt.input)

			if len(result) != len(tt.expected) {
				t.Fatalf("expected %d commits, got %d", len(tt.expected), len(result))
			}

			for i, commit := range result {
				exp := tt.expected[i]
				if commit.Hash != exp.Hash {
					t.Errorf("commit[%d].Hash: expected %q, got %q", i, exp.Hash, commit.Hash)
				}
				if commit.Subject != exp.Subject {
					t.Errorf("commit[%d].Subject: expected %q, got %q", i, exp.Subject, commit.Subject)
				}
				if commit.Body != exp.Body {
					t.Errorf("commit[%d].Body: expected %q, got %q", i, exp.Body, commit.Body)
				}
				if commit.Author != exp.Author {
					t.Errorf("commit[%d].Author: expected %q, got %q", i, exp.Author, commit.Author)
				}
				if commit.Date != exp.Date {
					t.Errorf("commit[%d].Date: expected %q, got %q", i, exp.Date, commit.Date)
				}
			}
		})
	}
}

func TestParseNameStatus(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []FileChange
	}{
		{
			name:     "empty input",
			input:    "",
			expected: nil,
		},
		{
			name:  "simple changes",
			input: "M\tserver/git/git.go\nA\tserver/git/log_test.go\nD\told_file.go",
			expected: []FileChange{
				{Path: "server/git/git.go", Status: "M"},
				{Path: "server/git/log_test.go", Status: "A"},
				{Path: "old_file.go", Status: "D"},
			},
		},
		{
			name:  "rename with percentage",
			input: "R100\told_name.go\tnew_name.go",
			expected: []FileChange{
				{Path: "new_name.go", Status: "R"},
			},
		},
		{
			name:  "copy normalized to R",
			input: "C050\toriginal.go\tcopy.go",
			expected: []FileChange{
				{Path: "copy.go", Status: "R"}, // Copy normalized to "R"
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseNameStatus(tt.input)

			if len(result) != len(tt.expected) {
				t.Fatalf("expected %d files, got %d", len(tt.expected), len(result))
			}

			for i, file := range result {
				exp := tt.expected[i]
				if file.Path != exp.Path {
					t.Errorf("file[%d].Path: expected %q, got %q", i, exp.Path, file.Path)
				}
				if file.Status != exp.Status {
					t.Errorf("file[%d].Status: expected %q, got %q", i, exp.Status, file.Status)
				}
			}
		})
	}
}

func TestValidateCommitHash(t *testing.T) {
	tests := []struct {
		hash    string
		wantErr bool
	}{
		{"", true},                                          // empty
		{"abc", true},                                       // too short
		{"abcdef", true},                                    // still too short (6)
		{"abcdefg", true},                                   // 7 chars but contains 'g'
		{"abcdef1", false},                                  // 7 hex chars - valid
		{"1234567", false},                                  // 7 digits - valid
		{"d6f9947789f16ed6736042f10d58271c23b36ad0", false}, // full 40 hex - valid
		{"D6F9947789F16ED6736042F10D58271C23B36AD0", false}, // uppercase - valid
		{"d6f9947", false},                                  // short hash - valid
		{"HEAD", true},                                      // special ref - invalid (contains non-hex)
		{"main", true},                                      // branch name - invalid
		{"abc123!", true},                                   // contains special char
	}

	for _, tt := range tests {
		t.Run(tt.hash, func(t *testing.T) {
			err := validateCommitHash(tt.hash)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateCommitHash(%q) error = %v, wantErr %v", tt.hash, err, tt.wantErr)
			}
		})
	}
}
