package git

import (
	"fmt"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

// Divergence is how far a branch has moved apart from the default branch.
type Divergence struct {
	Ahead  int `json:"ahead"`  // commits on the branch the default branch lacks
	Behind int `json:"behind"` // commits on the default branch the branch lacks
}

// aheadBehindMinVersion is the first git whose for-each-ref has the
// %(ahead-behind:<ref>) atom (2.41.0), which counts every ref in one commit
// walk. Apple's git, the one most macOS users run, is still 2.39.
var aheadBehindMinVersion = [2]int{2, 41}

var (
	hasAheadBehindMu sync.Mutex
	hasAheadBehind   *bool
)

// gitHasAheadBehind is read once per process: the git on PATH does not change
// under a running server often enough to pay a process per branch listing. A
// failure is not kept, so one bad moment does not break every later listing.
func gitHasAheadBehind() (bool, error) {
	hasAheadBehindMu.Lock()
	defer hasAheadBehindMu.Unlock()
	if hasAheadBehind != nil {
		return *hasAheadBehind, nil
	}

	out, err := execGit("", "version")
	if err != nil {
		return false, err
	}
	supported := versionAtLeast(out, aheadBehindMinVersion)
	hasAheadBehind = &supported
	return supported, nil
}

var gitVersionPattern = regexp.MustCompile(`(\d+)\.(\d+)`)

// versionAtLeast reports whether `git version` output names a version at or
// past min. Vendor suffixes ("(Apple Git-154)", ".windows.1") are ignored.
func versionAtLeast(output string, min [2]int) bool {
	m := gitVersionPattern.FindStringSubmatch(output)
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major > min[0] || (major == min[0] && minor >= min[1])
}

// divergences counts each of refs against the commit base (an object id),
// keyed by full ref name.
//
// On a git without %(ahead-behind) only refs/heads are counted: the fallback
// costs one rev-list per ref, which is affordable for the user's own branches
// but not for every remote branch of a large repository. A ref missing from the
// result has no count to show.
func divergences(dir, base string, refs []string) (map[string]Divergence, error) {
	native, err := gitHasAheadBehind()
	if err != nil {
		return nil, err
	}
	if native {
		return divergencesByForEachRef(dir, base)
	}

	var local []string
	for _, ref := range refs {
		if strings.HasPrefix(ref, "refs/heads/") {
			local = append(local, ref)
		}
	}
	return divergencesByRevList(dir, base, local)
}

// divergencesByForEachRef counts every branch and remote-tracking ref in one
// process.
func divergencesByForEachRef(dir, base string) (map[string]Divergence, error) {
	lines, err := execGitLines(dir, "for-each-ref", "--format=%(refname)%09%(ahead-behind:"+base+")", "refs/heads", "refs/remotes")
	if err != nil {
		return nil, err
	}

	result := make(map[string]Divergence, len(lines))
	for _, line := range lines {
		ref, counts, ok := strings.Cut(line, "\t")
		if !ok {
			return nil, fmt.Errorf("unexpected for-each-ref output: %q", line)
		}
		var d Divergence
		if _, err := fmt.Sscanf(counts, "%d %d", &d.Ahead, &d.Behind); err != nil {
			return nil, fmt.Errorf("unexpected ahead-behind output: %q", line)
		}
		result[ref] = d
	}
	return result, nil
}

// divergencesByRevList is the fallback for a git that predates %(ahead-behind),
// running the per-ref counts side by side so a long branch list does not add
// up their latencies.
func divergencesByRevList(dir, base string, refs []string) (map[string]Divergence, error) {
	result := make(map[string]Divergence, len(refs))
	var (
		resultMu sync.Mutex
		firstErr error
		wg       sync.WaitGroup
	)
	slots := make(chan struct{}, runtime.NumCPU())

	for _, ref := range refs {
		wg.Add(1)
		slots <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-slots }()

			ahead, behind, err := aheadBehind(dir, ref, base)
			resultMu.Lock()
			defer resultMu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			result[ref] = Divergence{Ahead: ahead, Behind: behind}
		}()
	}
	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}
	return result, nil
}
