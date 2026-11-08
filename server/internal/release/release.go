// Package release works out which published pockode releases this binary could
// move to — the newest final release ("latest") and the newest pre-release
// ("alpha") — and where each one's files for this platform are. It only reads
// what has been published; installing is another package's job. Both the
// pockode server and the cluster use it.
package release

import (
	"fmt"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/pockode/server/agent"
)

// Repo is where releases are published; install.sh and install.ps1 download
// from the same one.
const Repo = "sijiaoh/pockode"

// MinVersion is the oldest release that publishes checksums.txt beside its
// binaries. Nothing older is ever offered, since its download could not be
// verified.
const MinVersion = "0.16.0"

// ChecksumsName is the file every release carries with the sha256 of each of
// its binaries, written by scripts/build.sh.
const ChecksumsName = "checksums.txt"

// AssetName is the binary a release publishes for goos/goarch. It has to match
// what scripts/build.sh writes and what install.sh and install.ps1 download.
func AssetName(goos, goarch string) string {
	name := "pockode-" + goos + "-" + goarch
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// Platform is this binary's "os/arch", the way the copy about a release
// without a build for it names it.
func Platform() string { return runtime.GOOS + "/" + runtime.GOARCH }

// HostAsset is the asset this binary would be updated from.
func HostAsset() string { return AssetName(runtime.GOOS, runtime.GOARCH) }

// Release is one published release as a source reports it.
type Release struct {
	// Tag is the git tag, "v0.25.0".
	Tag string
	// Version is Tag without its leading "v", the way the binary reports its
	// own version.
	Version    string
	Prerelease bool
	// Assets names the files uploaded to the release. It is nil when the
	// source cannot say which assets a release has (the Atom feed), which is
	// different from a release that has none.
	Assets []string
}

// Channel names the two kinds of release a user can move to.
type Channel string

const (
	ChannelLatest Channel = "latest"
	ChannelAlpha  Channel = "alpha"
)

// Candidate is a release this binary could be updated to.
type Candidate struct {
	Channel  Channel
	Version  string
	NotesURL string
	// Asset is where this platform's binary and its checksums are; nil
	// exactly when Unavailable says why it cannot be installed.
	Asset       *Asset
	Unavailable *Unavailable
}

// UnavailableReason says why a release has nothing this platform can install.
type UnavailableReason string

const (
	// ReasonNoAsset: the release has no binary for this platform.
	ReasonNoAsset UnavailableReason = "no_asset"
	// ReasonNoChecksums: the release has no checksums.txt, so its binary
	// could not be verified.
	ReasonNoChecksums UnavailableReason = "no_checksums"
)

// Unavailable is why a candidate cannot be installed here. Message is for the
// user, as it is.
type Unavailable struct {
	Reason  UnavailableReason
	Message string
}

// NewerThan keeps the candidates newer than version — the one installed on
// disk, which an update must not downgrade and which a restart, not an update,
// moves to. A version that is not a release (a development build, or one that
// could not be read) sets no floor.
func NewerThan(candidates []Candidate, version string) []Candidate {
	if !IsRelease(version) {
		return candidates
	}
	var out []Candidate
	for _, c := range candidates {
		if newer(c.Version, version) {
			out = append(out, c)
		}
	}
	return out
}

// Asset is what an installer needs to fetch one release's binary for this
// platform and verify it.
type Asset struct {
	// Name is the binary's file name, which is also how checksums.txt names
	// it.
	Name string
	URL  string
	// ChecksumsURL is the checksums.txt of the same release: a binary is only
	// ever checked against the checksums published with it.
	ChecksumsURL string
}

// tagPattern is what the release workflow tags look like: "v", three numbers,
// and optionally a pre-release and build metadata, as in semver.
// agent.CompareVersions alone would also take "v1" or "v+1.0.0"; holding tags
// to this shape also keeps them safe to put in a URL path.
var tagPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)

// IsRelease reports whether version (no leading "v") is one a release can be
// compared with — what a release build reports. A development build reports
// "dev" (main's default, and scripts/build.sh's), and is neither checked for
// releases nor updated from one.
func IsRelease(version string) bool {
	_, ok := parseTag("v" + version)
	return ok
}

// parseTag returns the version a release tag names, and false for a tag that
// is not a release version.
func parseTag(tag string) (string, bool) {
	if !tagPattern.MatchString(tag) {
		return "", false
	}
	return tag[1:], true
}

// isPrerelease is the release workflow's own rule: a tag with a dash
// (v0.21.0-alpha.1) is published as a pre-release. The Atom feed does not say
// which releases are pre-releases, so this is how both sources decide.
func isPrerelease(version string) bool {
	core, _, _ := strings.Cut(version, "+")
	return strings.Contains(core, "-")
}

// compare orders two versions that have been parsed already, so the error
// CompareVersions can return does not arise.
func compare(a, b string) int {
	c, _ := agent.CompareVersions(a, b)
	return c
}

func newer(a, b string) bool { return compare(a, b) > 0 }

// pick chooses the candidates among releases for a binary running current on
// goos/goarch: latest first, then alpha. Either is left out when it is not
// newer than current, and alpha also when it is not newer than latest — a
// pre-release of a version already released final is behind it. current must
// be a version; a dev build has nothing to compare against.
func pick(current string, releases []Release, goos, goarch string) ([]Candidate, error) {
	if _, err := agent.CompareVersions(current, current); err != nil {
		return nil, err
	}
	latest, alpha := newest(releases)
	if alpha != nil && latest != nil && !newer(alpha.Version, latest.Version) {
		alpha = nil
	}

	var out []Candidate
	for _, c := range []struct {
		channel Channel
		r       *Release
	}{{ChannelLatest, latest}, {ChannelAlpha, alpha}} {
		if c.r != nil && newer(c.r.Version, current) {
			out = append(out, candidate(c.channel, *c.r, goos, goarch))
		}
	}
	return out, nil
}

// newest returns the newest final release and the newest pre-release from
// MinVersion on, either nil if there is none.
func newest(releases []Release) (latest, alpha *Release) {
	for i := range releases {
		r := &releases[i]
		if compare(r.Version, MinVersion) < 0 {
			continue
		}
		best := &latest
		if r.Prerelease {
			best = &alpha
		}
		if *best == nil || newer(r.Version, (*best).Version) {
			*best = r
		}
	}
	return latest, alpha
}

// latestVersion is the version of the newest final release, or "".
func latestVersion(releases []Release) string {
	if latest, _ := newest(releases); latest != nil {
		return latest.Version
	}
	return ""
}

// candidate builds every URL from the tag rather than taking the ones a
// source reported: GitHub serves a release's page and assets at these paths,
// and building them here keeps whatever an installer downloads and runs inside
// this repository's releases.
func candidate(channel Channel, r Release, goos, goarch string) Candidate {
	c := Candidate{Channel: channel, Version: r.Version, NotesURL: "https://github.com/" + Repo + "/releases/tag/" + r.Tag}
	name := AssetName(goos, goarch)
	switch {
	// With no list of assets the release workflow's guarantee stands in for
	// one: a release is only published with every binary and checksums.txt
	// uploaded. A platform it never built surfaces as the download's 404.
	case r.Assets != nil && !slices.Contains(r.Assets, name):
		c.Unavailable = &Unavailable{ReasonNoAsset, fmt.Sprintf("Release %s has no build for %s/%s (no %s asset).", r.Tag, goos, goarch, name)}
	case r.Assets != nil && !slices.Contains(r.Assets, ChecksumsName):
		c.Unavailable = &Unavailable{ReasonNoChecksums, fmt.Sprintf("Release %s has no %s, so its %s cannot be verified.", r.Tag, ChecksumsName, name)}
	default:
		c.Asset = &Asset{Name: name, URL: downloadURL(r.Tag, name), ChecksumsURL: downloadURL(r.Tag, ChecksumsName)}
	}
	return c
}

func downloadURL(tag, name string) string {
	return "https://github.com/" + Repo + "/releases/download/" + tag + "/" + name
}
