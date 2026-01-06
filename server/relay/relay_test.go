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
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayServer: "cloud.pockode.com",
			},
			want: "https://abc123def456ghi789jkl0123.cloud.pockode.com",
		},
		{
			name: "local development",
			cfg: &StoredConfig{
				Subdomain:   "dev123",
				RelayServer: "local.pockode.com",
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

func TestBuildRelayWSURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  *StoredConfig
		want string
	}{
		{
			name: "production",
			cfg: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayServer: "cloud.pockode.com",
			},
			want: "wss://abc123def456ghi789jkl0123.cloud.pockode.com/relay",
		},
		{
			name: "local development",
			cfg: &StoredConfig{
				Subdomain:   "dev123",
				RelayServer: "local.pockode.com",
			},
			want: "ws://dev123.local.pockode.com/relay",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildRelayWSURL(tt.cfg)
			if got != tt.want {
				t.Errorf("buildRelayWSURL() = %v, want %v", got, tt.want)
			}
		})
	}
}
