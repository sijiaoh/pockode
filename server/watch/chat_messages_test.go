package watch

import (
	"testing"
)

func TestMergeIDIntoParams(t *testing.T) {
	tests := []struct {
		name     string
		id       string
		params   any
		wantID   string
		wantKeys []string
	}{
		{
			name: "merges id into struct params",
			id:   "cm-123",
			params: struct {
				SessionID string `json:"session_id"`
				Content   string `json:"content"`
			}{
				SessionID: "sess-1",
				Content:   "hello",
			},
			wantID:   "cm-123",
			wantKeys: []string{"id", "session_id", "content"},
		},
		{
			name:     "handles nil params",
			id:       "cm-456",
			params:   nil,
			wantID:   "cm-456",
			wantKeys: []string{"id"},
		},
		{
			name:     "handles empty struct",
			id:       "cm-789",
			params:   struct{}{},
			wantID:   "cm-789",
			wantKeys: []string{"id"},
		},
		{
			name:     "escapes special characters in id",
			id:       `cm-"test"`,
			params:   struct{}{},
			wantID:   `cm-"test"`,
			wantKeys: []string{"id"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := mergeIDIntoParams(tt.id, tt.params)

			// Check ID
			if got := result["id"]; got != tt.wantID {
				t.Errorf("id = %v, want %v", got, tt.wantID)
			}

			// Check all expected keys exist
			for _, key := range tt.wantKeys {
				if _, ok := result[key]; !ok {
					t.Errorf("missing key %q", key)
				}
			}
		})
	}
}
