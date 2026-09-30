package cliupdate

import (
	"fmt"
	"strconv"
	"strings"
)

// compareVersions orders two semantic versions as semver does: -1 when a is
// older than b, 1 when newer, 0 when they are the same release. Build metadata
// is ignored, and a pre-release is older than the release it precedes.
func compareVersions(a, b string) (int, error) {
	va, err := parseSemver(a)
	if err != nil {
		return 0, err
	}
	vb, err := parseSemver(b)
	if err != nil {
		return 0, err
	}
	for i := range max(len(va.core), len(vb.core)) {
		if c := compareInts(at(va.core, i), at(vb.core, i)); c != 0 {
			return c, nil
		}
	}
	switch {
	case len(va.pre) == 0 && len(vb.pre) == 0:
		return 0, nil
	case len(va.pre) == 0:
		return 1, nil
	case len(vb.pre) == 0:
		return -1, nil
	}
	for i := range min(len(va.pre), len(vb.pre)) {
		if c := comparePrerelease(va.pre[i], vb.pre[i]); c != 0 {
			return c, nil
		}
	}
	return compareInts(len(va.pre), len(vb.pre)), nil
}

type semver struct {
	core []int
	pre  []string
}

func parseSemver(v string) (semver, error) {
	v, _, _ = strings.Cut(v, "+")
	core, pre, hasPre := strings.Cut(v, "-")
	var s semver
	for _, part := range strings.Split(core, ".") {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return semver{}, fmt.Errorf("not a version: %q", v)
		}
		s.core = append(s.core, n)
	}
	if hasPre {
		s.pre = strings.Split(pre, ".")
	}
	return s, nil
}

// comparePrerelease orders two pre-release identifiers: numeric ones by value
// and below alphanumeric ones, which compare as text.
func comparePrerelease(a, b string) int {
	na, errA := strconv.Atoi(a)
	nb, errB := strconv.Atoi(b)
	switch {
	case errA == nil && errB == nil:
		return compareInts(na, nb)
	case errA == nil:
		return -1
	case errB == nil:
		return 1
	}
	return strings.Compare(a, b)
}

func compareInts(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func at(s []int, i int) int {
	if i < len(s) {
		return s[i]
	}
	return 0
}
