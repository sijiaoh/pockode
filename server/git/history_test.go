package git

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

// historyRepo is a repository whose commits are dated one minute apart in the
// order they are made, so date order is fixed rather than left to the clock.
type historyRepo struct {
	t     *testing.T
	dir   string
	clock int
}

func newHistoryRepo(t *testing.T) *historyRepo {
	t.Helper()
	dir, cleanup := setupTestRepo(t)
	t.Cleanup(cleanup)
	runGit(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	return &historyRepo{t: t, dir: dir}
}

// git runs a command with the next timestamp, so a commit or merge it makes is
// newer than every one before it.
func (r *historyRepo) git(args ...string) string {
	r.t.Helper()
	r.clock++
	date := fmt.Sprintf("2026-01-01T00:%02d:00Z", r.clock)
	cmd := exec.Command("git", args...)
	cmd.Dir = r.dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// commit makes a commit touching path and returns its hash.
func (r *historyRepo) commit(message, path string) string {
	r.t.Helper()
	writeTestFile(r.t, r.dir, path, message+"\n")
	r.git("add", path)
	r.git("commit", "--no-gpg-sign", "-m", message)
	return r.git("rev-parse", "HEAD")
}

func (r *historyRepo) history(q HistoryQuery) *HistoryPage {
	r.t.Helper()
	page, err := History(r.dir, q)
	if err != nil {
		r.t.Fatalf("History(%+v) error: %v", q, err)
	}
	return page
}

func subjects(commits []Commit) []string {
	result := make([]string, len(commits))
	for i, c := range commits {
		result[i] = c.Subject
	}
	return result
}

func refNames(refs []Ref) []string {
	result := make([]string, len(refs))
	for i, ref := range refs {
		result[i] = string(ref.Type) + ":" + ref.Name
	}
	return result
}

func TestHistory_PagesContinueOneListing(t *testing.T) {
	r := newHistoryRepo(t)
	for i := 1; i <= 5; i++ {
		r.commit(fmt.Sprintf("c%d", i), "file.txt")
	}

	var all []Commit
	q := HistoryQuery{Limit: 2}
	for pages := 0; ; pages++ {
		if pages > 5 {
			t.Fatal("History() never reported the last page")
		}
		page := r.history(q)
		all = append(all, page.Commits...)
		if (q.Cursor == nil) != (page.UnpushedCount != nil) {
			t.Errorf("page %d: unpushed_count present = %v, want it on the first page only", pages, page.UnpushedCount != nil)
		}
		if page.Next == nil {
			break
		}
		q.Cursor = page.Next
	}

	if got, want := subjects(all), []string{"c5", "c4", "c3", "c2", "c1"}; !slices.Equal(got, want) {
		t.Fatalf("subjects = %v, want %v", got, want)
	}
	for i, c := range all[:len(all)-1] {
		if !slices.Equal(c.Parents, []string{all[i+1].Hash}) {
			t.Errorf("%s parents = %v, want [%s]", c.Subject, c.Parents, all[i+1].Hash)
		}
	}
	if root := all[len(all)-1]; root.Parents == nil || len(root.Parents) != 0 {
		t.Errorf("root parents = %#v, want an empty list", root.Parents)
	}
}

// The client lays the graph out across pages, so a ref moving between two of
// them must not shift what the next page holds.
func TestHistory_CursorIgnoresRefsMovedSinceFirstPage(t *testing.T) {
	r := newHistoryRepo(t)
	for i := 1; i <= 3; i++ {
		r.commit(fmt.Sprintf("c%d", i), "file.txt")
	}

	first := r.history(HistoryQuery{Limit: 2})
	r.commit("c4", "file.txt")
	second := r.history(HistoryQuery{Limit: 2, Cursor: first.Next})

	if got, want := subjects(second.Commits), []string{"c1"}; !slices.Equal(got, want) {
		t.Errorf("second page = %v, want %v", got, want)
	}
}

func TestHistory_Scopes(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("base", "file.txt")
	r.git("checkout", "-q", "-b", "feature")
	r.commit("feature work", "feature.txt")
	r.git("checkout", "-q", "-b", "other", "main")
	r.commit("other work", "other.txt")
	r.git("checkout", "-q", "main")
	r.commit("main work", "main.txt")
	r.git("checkout", "-q", "-b", "side")
	r.commit("side work", "side.txt")
	r.git("checkout", "-q", "feature")
	r.git("merge", "--no-ff", "--no-gpg-sign", "-m", "merge side", "side")

	tests := []struct {
		scope HistoryScope
		want  []string
	}{
		// HEAD plus the default branch, which feature has not merged.
		{ScopeCurrent, []string{"merge side", "side work", "main work", "feature work", "base"}},
		{ScopeAll, []string{"merge side", "side work", "main work", "other work", "feature work", "base"}},
		{ScopeMainline, []string{"merge side", "feature work", "base"}},
	}
	for _, tt := range tests {
		t.Run(string(tt.scope), func(t *testing.T) {
			page := r.history(HistoryQuery{Scope: tt.scope})
			if got := subjects(page.Commits); !slices.Equal(got, tt.want) {
				t.Errorf("subjects = %v, want %v", got, tt.want)
			}
		})
	}

	merge := r.history(HistoryQuery{Limit: 1}).Commits[0]
	if len(merge.Parents) != 2 {
		t.Errorf("merge parents = %v, want two", merge.Parents)
	}
}

// The default branch gets a line of its own only where it is walked from and
// HEAD does not already contain it.
func TestHistory_DefaultLine(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("base", "file.txt")
	r.git("checkout", "-q", "-b", "feature")
	r.commit("feature work", "feature.txt")

	// Ahead of main: main sits on HEAD's line.
	if got := r.history(HistoryQuery{}).DefaultLine; len(got) != 0 {
		t.Errorf("feature ahead of main: default_line = %v, want none", got)
	}

	r.git("checkout", "-q", "main")
	r.commit("main work", "main.txt")
	r.git("checkout", "-q", "feature")
	for _, scope := range []HistoryScope{ScopeCurrent, ScopeAll} {
		if got := r.history(HistoryQuery{Scope: scope}).DefaultLine; !slices.Equal(got, []string{"main"}) {
			t.Errorf("%s, main diverged: default_line = %v, want [main]", scope, got)
		}
	}
	if got := r.history(HistoryQuery{Scope: ScopeMainline}).DefaultLine; len(got) != 0 {
		t.Errorf("mainline: default_line = %v, want none", got)
	}

	// Named as Ref.Name carries it, which the client matches against.
	remote, cleanupRemote := setupBareRemote(t)
	defer cleanupRemote()
	r.git("remote", "add", "origin", remote)
	r.git("push", "-q", "origin", "main")
	if got := r.history(HistoryQuery{}).DefaultLine; !slices.Equal(got, []string{"main", "origin/main"}) {
		t.Errorf("with origin: default_line = %v, want [main origin/main]", got)
	}

	// Merged into HEAD: on HEAD's history again.
	r.git("merge", "--no-ff", "--no-gpg-sign", "-m", "merge main", "main")
	if got := r.history(HistoryQuery{}).DefaultLine; len(got) != 0 {
		t.Errorf("main merged: default_line = %v, want none", got)
	}
}

func TestHistory_RefsAndUnpushed(t *testing.T) {
	r := newHistoryRepo(t)
	remote, cleanupRemote := setupBareRemote(t)
	defer cleanupRemote()

	pushed := r.commit("pushed", "file.txt")
	r.git("tag", "--no-sign", "-a", "-m", "release", "v1", pushed)
	r.git("update-ref", "refs/tags/light", pushed)
	r.git("remote", "add", "origin", remote)
	r.git("push", "-q", "-u", "origin", "main")
	r.git("remote", "set-head", "origin", "main")
	local := r.commit("local", "file.txt")
	r.git("branch", "also-here")

	page := r.history(HistoryQuery{})
	if page.UnpushedCount == nil || *page.UnpushedCount != 1 {
		t.Errorf("unpushed_count = %v, want 1", page.UnpushedCount)
	}

	byHash := make(map[string]Commit)
	for _, c := range page.Commits {
		byHash[c.Hash] = c
	}
	if c := byHash[local]; !c.Unpushed {
		t.Error("local commit not marked unpushed")
	}
	if c := byHash[pushed]; c.Unpushed {
		t.Error("pushed commit marked unpushed")
	}

	// HEAD first, then its branch, then the rest; origin/HEAD is not repeated.
	if got, want := refNames(byHash[local].Refs), []string{"head:HEAD", "branch:main", "branch:also-here"}; !slices.Equal(got, want) {
		t.Errorf("local refs = %v, want %v", got, want)
	}
	if !byHash[local].Refs[1].Current || byHash[local].Refs[2].Current {
		t.Errorf("only main should be current: %+v", byHash[local].Refs)
	}
	// The annotated tag is peeled to the commit it tags.
	if got, want := refNames(byHash[pushed].Refs), []string{"remote:origin/main", "tag:light", "tag:v1"}; !slices.Equal(got, want) {
		t.Errorf("pushed refs = %v, want %v", got, want)
	}
}

// Without a remote there is nothing to push to, so nothing is "unpushed".
func TestHistory_NoRemoteMarksNothingUnpushed(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("only", "file.txt")

	page := r.history(HistoryQuery{})
	if page.UnpushedCount == nil || *page.UnpushedCount != 0 {
		t.Errorf("unpushed_count = %v, want 0", page.UnpushedCount)
	}
	if page.Commits[0].Unpushed {
		t.Error("commit marked unpushed in a repository with no remote")
	}
	if page.DefaultBranch != "main" {
		t.Errorf("default_branch = %q, want main, found by name without a remote", page.DefaultBranch)
	}
}

// A remote nothing was fetched from or pushed to yet leaves every commit
// unpushed, without git walking the history to say so.
func TestHistory_RemoteWithoutTrackingRefs(t *testing.T) {
	r := newHistoryRepo(t)
	remote, cleanupRemote := setupBareRemote(t)
	defer cleanupRemote()
	r.commit("first", "file.txt")
	r.commit("second", "file.txt")
	r.git("remote", "add", "origin", remote)

	page := r.history(HistoryQuery{})
	if page.UnpushedCount == nil || *page.UnpushedCount != 2 {
		t.Errorf("unpushed_count = %v, want 2", page.UnpushedCount)
	}
	for _, c := range page.Commits {
		if !c.Unpushed {
			t.Errorf("%q not marked unpushed", c.Subject)
		}
	}
}

// The default branch is found through the remote's HEAD, not by its name.
func TestHistory_CurrentScopeFollowsRemoteHead(t *testing.T) {
	r := newHistoryRepo(t)
	remote, cleanupRemote := setupBareRemote(t)
	defer cleanupRemote()

	r.commit("base", "file.txt")
	r.git("branch", "-m", "trunk")
	r.git("remote", "add", "origin", remote)
	r.git("checkout", "-q", "-b", "feature")
	r.commit("feature work", "feature.txt")
	r.git("checkout", "-q", "trunk")
	r.commit("trunk work", "trunk.txt")
	r.git("push", "-q", "origin", "trunk")
	r.git("remote", "set-head", "origin", "trunk")
	r.git("reset", "-q", "--hard", "HEAD~1")
	r.git("checkout", "-q", "feature")

	page := r.history(HistoryQuery{})
	if got, want := subjects(page.Commits), []string{"trunk work", "feature work", "base"}; !slices.Equal(got, want) {
		t.Errorf("subjects = %v, want %v", got, want)
	}
	if page.DefaultBranch != "trunk" {
		t.Errorf("default_branch = %q, want trunk", page.DefaultBranch)
	}
}

func TestHistory_DetachedHead(t *testing.T) {
	r := newHistoryRepo(t)
	first := r.commit("first", "file.txt")
	r.commit("second", "file.txt")
	r.git("checkout", "-q", "--detach", first)

	page := r.history(HistoryQuery{Scope: ScopeAll})
	if got, want := subjects(page.Commits), []string{"second", "first"}; !slices.Equal(got, want) {
		t.Fatalf("subjects = %v, want %v", got, want)
	}
	if got, want := refNames(page.Commits[1].Refs), []string{"head:HEAD"}; !slices.Equal(got, want) {
		t.Errorf("detached commit refs = %v, want %v", got, want)
	}
	if page.Commits[0].Refs[0].Current {
		t.Error("main marked current while HEAD is detached")
	}
}

func TestHistory_SearchAndPath(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("Fix(parser): crash", "parser.go")
	r.commit("fix(ui): button", "ui/button.tsx")
	r.commit("add docs", "ui/README.md")

	tests := []struct {
		name string
		q    HistoryQuery
		want []string
	}{
		// Plain text and case-insensitive: "(" would be a broken regex.
		{"query", HistoryQuery{Grep: "FIX("}, []string{"fix(ui): button", "Fix(parser): crash"}},
		{"directory", HistoryQuery{Path: "ui"}, []string{"add docs", "fix(ui): button"}},
		{"both", HistoryQuery{Grep: "fix", Path: "ui"}, []string{"fix(ui): button"}},
		{"paged", HistoryQuery{Grep: "fix", Limit: 1}, []string{"fix(ui): button"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := subjects(r.history(tt.q).Commits); !slices.Equal(got, tt.want) {
				t.Errorf("subjects = %v, want %v", got, tt.want)
			}
		})
	}

	first := r.history(HistoryQuery{Grep: "fix", Limit: 1})
	second := r.history(HistoryQuery{Grep: "fix", Limit: 1, Cursor: first.Next})
	if got, want := subjects(second.Commits), []string{"Fix(parser): crash"}; !slices.Equal(got, want) || second.Next != nil {
		t.Errorf("second filtered page = %v (next %v), want %v and no next", got, second.Next, want)
	}
}

func TestHistory_InvalidArguments(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("only", "file.txt")

	tests := []struct {
		name string
		q    HistoryQuery
	}{
		{"escaping path", HistoryQuery{Path: "../outside"}},
		{"empty cursor", HistoryQuery{Cursor: &HistoryCursor{}}},
		{"negative skip", HistoryQuery{Cursor: &HistoryCursor{Tips: []string{strings.Repeat("a", 40)}, Skip: -1}}},
		{"option as tip", HistoryQuery{Cursor: &HistoryCursor{Tips: []string{"--all"}}}},
		{"short hash as tip", HistoryQuery{Cursor: &HistoryCursor{Tips: []string{"abcdef1"}}}},
		// git would take each line as a pattern of its own and match any.
		{"multi-line search", HistoryQuery{Grep: "zzz\nonly"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := History(r.dir, tt.q); !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("History() error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}

// A shallow clone's oldest commit has parents git does not have; it is
// listed without them, and the page says the history is cut short.
func TestHistory_ShallowClone(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("first", "file.txt")
	r.commit("second", "file.txt")

	clone := t.TempDir()
	runGit(t, clone, "clone", "-q", "--depth", "1", "file://"+r.dir, ".")

	page, err := History(clone, HistoryQuery{})
	if err != nil {
		t.Fatalf("History() error: %v", err)
	}
	if !page.Shallow {
		t.Error("shallow = false for a shallow clone")
	}
	if len(page.Commits) != 1 || len(page.Commits[0].Parents) != 0 {
		t.Errorf("commits = %+v, want one without parents", page.Commits)
	}
}

func TestShow_ParentsAndRefs(t *testing.T) {
	r := newHistoryRepo(t)
	first := r.commit("first", "file.txt")
	second := r.commit("second", "file.txt")

	result, err := Show(r.dir, second)
	if err != nil {
		t.Fatalf("Show() error: %v", err)
	}
	if !slices.Equal(result.Parents, []string{first}) {
		t.Errorf("parents = %v, want [%s]", result.Parents, first)
	}
	if got, want := refNames(result.Refs), []string{"head:HEAD", "branch:main"}; !slices.Equal(got, want) {
		t.Errorf("refs = %v, want %v", got, want)
	}
}

func TestCreateBranch_FromCommit(t *testing.T) {
	r := newHistoryRepo(t)
	first := r.commit("first", "file.txt")
	r.commit("second", "file.txt")

	if err := CreateBranch(r.dir, "from-first", first); err != nil {
		t.Fatalf("CreateBranch() error: %v", err)
	}
	if branch, _ := CurrentBranch(r.dir); branch != "from-first" {
		t.Errorf("current branch = %q, want from-first", branch)
	}
	if head := r.git("rev-parse", "HEAD"); head != first {
		t.Errorf("HEAD = %s, want %s", head, first)
	}

	if err := CreateBranch(r.dir, "bad", "--orphan"); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("CreateBranch() with an option as start = %v, want ErrInvalidArgument", err)
	}
	// A short hash would lose to a ref of the same name.
	if err := CreateBranch(r.dir, "short", first[:7]); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("CreateBranch() with a short hash as start = %v, want ErrInvalidArgument", err)
	}
}

// A tag sharing the branch's name makes git's short form "heads/main", which
// would match neither the branch's ref nor its upstream.
func TestHistory_TagNamedLikeTheBranch(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("only", "file.txt")
	r.git("update-ref", "refs/tags/main", "HEAD")

	refs := r.history(HistoryQuery{}).Commits[0].Refs
	if got, want := refNames(refs), []string{"head:HEAD", "branch:main", "tag:main"}; !slices.Equal(got, want) || !refs[1].Current {
		t.Errorf("refs = %+v, want %v with main current", refs, want)
	}
}

// log.follow would turn a one-path filter into --follow, which tracks one
// line of history and crosses renames the listing says it does not.
func TestHistory_PathIgnoresLogFollow(t *testing.T) {
	r := newHistoryRepo(t)
	r.commit("create", "old.txt")
	r.git("mv", "old.txt", "new.txt")
	r.git("commit", "--no-gpg-sign", "-m", "rename")
	r.git("config", "log.follow", "true")

	if got, want := subjects(r.history(HistoryQuery{Path: "new.txt"}).Commits), []string{"rename"}; !slices.Equal(got, want) {
		t.Errorf("subjects = %v, want %v", got, want)
	}
}
