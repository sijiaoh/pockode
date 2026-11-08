package release

import (
	"slices"
	"strings"
	"testing"
)

func TestAssetName(t *testing.T) {
	tests := []struct{ goos, goarch, want string }{
		{"linux", "amd64", "pockode-linux-amd64"},
		{"darwin", "arm64", "pockode-darwin-arm64"},
		{"windows", "amd64", "pockode-windows-amd64.exe"},
	}
	for _, tt := range tests {
		if got := AssetName(tt.goos, tt.goarch); got != tt.want {
			t.Errorf("AssetName(%q, %q) = %q, want %q", tt.goos, tt.goarch, got, tt.want)
		}
	}
}

// rel is a release as the API reports it, with a binary for linux/amd64 and
// its checksums.
func rel(tag string) Release {
	v, ok := parseTag(tag)
	if !ok {
		panic(tag)
	}
	return Release{
		Tag: tag, Version: v, Prerelease: isPrerelease(v),
		Assets: []string{"pockode-linux-amd64", "checksums.txt"},
	}
}

func TestParseTag(t *testing.T) {
	for tag, want := range map[string]string{
		"v0.25.0":             "0.25.0",
		"v0.26.0-alpha.1":     "0.26.0-alpha.1",
		"v1.0.0-rc.1+build.5": "1.0.0-rc.1+build.5",
		"v0.25":               "",
		"v1":                  "",
		"0.25.0":              "",
		"v+1.0.0":             "",
		"v0.25.0/../../evil":  "",
		"v0.25.0-alpha?x=1":   "",
		"nightly":             "",
		"v0.25.0-":            "",
	} {
		got, ok := parseTag(tag)
		if got != want || ok != (want != "") {
			t.Errorf("parseTag(%q) = %q, %v; want %q", tag, got, ok, want)
		}
	}
}

func TestPick(t *testing.T) {
	type want struct {
		channel Channel
		version string
	}
	tests := []struct {
		name     string
		current  string
		releases []Release
		want     []want
	}{
		{
			name:     "newest final and a newer alpha",
			current:  "0.24.0",
			releases: []Release{rel("v0.26.0-alpha.1"), rel("v0.25.0"), rel("v0.24.0"), rel("v0.25.0-alpha.3")},
			want:     []want{{ChannelLatest, "0.25.0"}, {ChannelAlpha, "0.26.0-alpha.1"}},
		},
		{
			name:     "alpha of a version already released final is not offered",
			current:  "0.24.0",
			releases: []Release{rel("v0.25.0"), rel("v0.25.0-alpha.3")},
			want:     []want{{ChannelLatest, "0.25.0"}},
		},
		{
			name:     "versions compare as semver, not as text",
			current:  "0.19.0",
			releases: []Release{rel("v0.100.0"), rel("v0.99.1"), rel("v0.101.0-alpha.2"), rel("v0.101.0-alpha.10")},
			want:     []want{{ChannelLatest, "0.100.0"}, {ChannelAlpha, "0.101.0-alpha.10"}},
		},
		{
			name:     "running the latest offers only a newer alpha",
			current:  "0.25.0",
			releases: []Release{rel("v0.25.0"), rel("v0.26.0-alpha.1")},
			want:     []want{{ChannelAlpha, "0.26.0-alpha.1"}},
		},
		{
			name:     "running an alpha ahead of latest: no downgrade, the next alpha is offered",
			current:  "0.26.0-alpha.1",
			releases: []Release{rel("v0.25.0"), rel("v0.26.0-alpha.2")},
			want:     []want{{ChannelAlpha, "0.26.0-alpha.2"}},
		},
		{
			name:     "running an alpha whose final is out",
			current:  "0.26.0-alpha.2",
			releases: []Release{rel("v0.26.0"), rel("v0.26.0-alpha.2")},
			want:     []want{{ChannelLatest, "0.26.0"}},
		},
		{
			name:     "up to date",
			current:  "0.26.0-alpha.2",
			releases: []Release{rel("v0.25.0"), rel("v0.26.0-alpha.2")},
		},
		{
			name:     "releases before checksums.txt are ignored",
			current:  "0.14.0",
			releases: []Release{rel("v0.15.0"), rel("v0.16.0-alpha.1"), rel("v0.16.0")},
			want:     []want{{ChannelLatest, "0.16.0"}},
		},
		{
			name:     "only pre-releases published",
			current:  "0.16.0",
			releases: []Release{rel("v0.17.0-alpha.1")},
			want:     []want{{ChannelAlpha, "0.17.0-alpha.1"}},
		},
		{
			name:    "nothing published",
			current: "0.16.0",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := pick(tt.current, tt.releases, "linux", "amd64")
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %d candidates %+v, want %+v", len(got), got, tt.want)
			}
			for i, w := range tt.want {
				if got[i].Channel != w.channel || got[i].Version != w.version {
					t.Errorf("candidate %d = %s %s, want %s %s", i, got[i].Channel, got[i].Version, w.channel, w.version)
				}
			}
		})
	}
}

func TestPickRefusesNonVersion(t *testing.T) {
	if _, err := pick("dev", []Release{rel("v0.25.0")}, "linux", "amd64"); err == nil {
		t.Fatal("pick accepted current version \"dev\"")
	}
}

func TestPickAsset(t *testing.T) {
	t.Run("listed among the release's assets", func(t *testing.T) {
		got, _ := pick("0.24.0", []Release{rel("v0.25.0")}, "linux", "amd64")
		want := Asset{
			Name:         "pockode-linux-amd64",
			URL:          "https://github.com/sijiaoh/pockode/releases/download/v0.25.0/pockode-linux-amd64",
			ChecksumsURL: "https://github.com/sijiaoh/pockode/releases/download/v0.25.0/checksums.txt",
		}
		if got[0].Asset == nil || *got[0].Asset != want || got[0].Unavailable != nil {
			t.Fatalf("candidate = %+v, want asset %+v", got[0], want)
		}
		if got[0].NotesURL != "https://github.com/sijiaoh/pockode/releases/tag/v0.25.0" {
			t.Errorf("NotesURL = %q", got[0].NotesURL)
		}
	})

	t.Run("no build for this platform", func(t *testing.T) {
		got, _ := pick("0.24.0", []Release{rel("v0.25.0")}, "windows", "arm64")
		if got[0].Asset != nil || got[0].Unavailable == nil || got[0].Unavailable.Reason != ReasonNoAsset {
			t.Fatalf("candidate = %+v, want no asset and ReasonNoAsset", got[0])
		}
		for _, s := range []string{"v0.25.0", "windows/arm64", "pockode-windows-arm64.exe"} {
			if !strings.Contains(got[0].Unavailable.Message, s) {
				t.Errorf("Unavailable = %q, want it to mention %q", got[0].Unavailable.Message, s)
			}
		}
	})

	t.Run("no checksums", func(t *testing.T) {
		r := rel("v0.25.0")
		r.Assets = []string{"pockode-linux-amd64"}
		got, _ := pick("0.24.0", []Release{r}, "linux", "amd64")
		if u := got[0].Unavailable; got[0].Asset != nil || u == nil || u.Reason != ReasonNoChecksums || !strings.Contains(u.Message, ChecksumsName) {
			t.Fatalf("candidate = %+v, want it unavailable for want of %s", got[0], ChecksumsName)
		}
	})

	t.Run("assets unknown: assumed, as the release workflow publishes them all", func(t *testing.T) {
		r := rel("v0.26.0-alpha.1")
		r.Assets = nil
		got, _ := pick("0.24.0", []Release{r}, "windows", "amd64")
		want := Asset{
			Name:         "pockode-windows-amd64.exe",
			URL:          "https://github.com/sijiaoh/pockode/releases/download/v0.26.0-alpha.1/pockode-windows-amd64.exe",
			ChecksumsURL: "https://github.com/sijiaoh/pockode/releases/download/v0.26.0-alpha.1/checksums.txt",
		}
		if got[0].Asset == nil || *got[0].Asset != want {
			t.Fatalf("candidate = %+v, want asset %+v", got[0], want)
		}
	})
}

func TestIsRelease(t *testing.T) {
	for _, tt := range []struct {
		version string
		want    bool
	}{
		{"0.25.0", true},
		{"0.26.0-alpha.1", true},
		{"dev", false},
		{"", false},
		{"1", false},
		{"v0.25.0", false},
	} {
		if got := IsRelease(tt.version); got != tt.want {
			t.Errorf("IsRelease(%q) = %v, want %v", tt.version, got, tt.want)
		}
	}
}

func TestNewerThan(t *testing.T) {
	cands, _ := pick("0.24.0", []Release{rel("v0.25.0"), rel("v0.26.0-alpha.1")}, "linux", "amd64")
	versions := func(cs []Candidate) []string {
		var out []string
		for _, c := range cs {
			out = append(out, c.Version)
		}
		return out
	}
	for installed, want := range map[string][]string{
		"0.24.0":         {"0.25.0", "0.26.0-alpha.1"},
		"0.25.0":         {"0.26.0-alpha.1"},
		"0.26.0-alpha.1": nil,
		"dev":            {"0.25.0", "0.26.0-alpha.1"},
		"":               {"0.25.0", "0.26.0-alpha.1"},
	} {
		if got := versions(NewerThan(cands, installed)); !slices.Equal(got, want) {
			t.Errorf("NewerThan(installed %q) = %v, want %v", installed, got, want)
		}
	}
}

func TestLatestVersion(t *testing.T) {
	for _, tc := range []struct {
		releases []Release
		want     string
	}{
		{[]Release{rel("v0.25.0"), rel("v0.24.0"), rel("v0.26.0-alpha.1")}, "0.25.0"},
		{[]Release{rel("v0.26.0-alpha.1")}, ""},
		{[]Release{rel("v0.15.0")}, ""},
		{nil, ""},
	} {
		if got := latestVersion(tc.releases); got != tc.want {
			t.Errorf("latestVersion(%v) = %q, want %q", tc.releases, got, tc.want)
		}
	}
}
