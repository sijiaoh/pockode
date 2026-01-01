package relay

import "testing"

func TestBuildRemoteURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  *StoredConfig
		want string
	}{
		{
			name: "production",
			cfg: &StoredConfig{
				Subdomain: "abc123def456ghi789jkl0123",
				FrpServer: "cloud.pockode.com",
			},
			want: "https://abc123def456ghi789jkl0123.cloud.pockode.com",
		},
		{
			name: "local development",
			cfg: &StoredConfig{
				Subdomain: "dev123",
				FrpServer: "local.pockode.com",
			},
			want: "http://dev123.local.pockode.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildRemoteURL(tt.cfg)
			if got != tt.want {
				t.Errorf("buildRemoteURL() = %v, want %v", got, tt.want)
			}
		})
	}
}
