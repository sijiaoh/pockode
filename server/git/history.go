package git

import (
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// HistoryScope selects the refs History walks from.
type HistoryScope string

const (
	// ScopeCurrent is HEAD, its upstream and the default branch: where the user
	// is, where it was pushed, and what it will be merged into.
	ScopeCurrent HistoryScope = "current"
	// ScopeAll is every local branch and its upstream, plus HEAD for when it is
	// detached. Remote branches nobody checked out are left out: a busy remote
	// would bury the user's own work under other people's.
	ScopeAll HistoryScope = "all"
	// ScopeMainline is HEAD's first-parent chain: the commits made on the
	// branch and the merges into it, without what each merge brought along.
	ScopeMainline HistoryScope = "mainline"
)

// IsHistoryScope reports whether scope is one History accepts; the empty
// string is ScopeCurrent.
func IsHistoryScope(scope string) bool {
	switch HistoryScope(scope) {
	case "", ScopeCurrent, ScopeAll, ScopeMainline:
		return true
	}
	return false
}

const (
	defaultHistoryLimit = 50
	maxHistoryLimit     = 200
)

// HistoryQuery is one page request of History.
type HistoryQuery struct {
	Scope HistoryScope
	// Grep keeps the commits whose message contains it, case-insensitively and
	// as plain text: what a user types into a search box is not a regex.
	Grep string
	// Path keeps the commits that touched it, a file or a directory, relative
	// to the repository root.
	Path  string
	Limit int
	// Cursor is the Next of the previous page; nil asks for the first one.
	Cursor *HistoryCursor
}

// HistoryCursor continues a History listing where the previous page ended.
//
// It carries the commits the first page resolved the scope to, not the scope:
// a ref moving between two pages would otherwise reorder the listing under the
// client, which lays the graph out across pages and cannot redo the pages it
// already has. git orders the same starting commits the same way every time,
// so skipping what was already sent lands exactly after it.
type HistoryCursor struct {
	Tips []string `json:"tips"`
	Skip int      `json:"skip"`
}

// HistoryPage is one page of History.
type HistoryPage struct {
	// Commits are in date order: every commit before its parents, otherwise
	// newest first by commit date.
	Commits []Commit `json:"commits"`
	// Next is nil on the last page.
	Next *HistoryCursor `json:"next"`
	// UnpushedCount is how many commits of the scope no remote-tracking ref
	// contains — the search and path filter are not applied, it describes the
	// branches rather than the listing. Only the first page carries it, and it
	// is 0 in a repository with no remote, where there is nothing to push to.
	UnpushedCount *int `json:"unpushed_count,omitempty"`
	// Shallow marks a shallow clone, whose oldest commits are listed without
	// the parents git does not have. Only the first page carries it.
	Shallow bool `json:"shallow,omitempty"`
	// DefaultBranch names the repository's default branch ("main"), which
	// ScopeCurrent lists beside HEAD; empty when there is none to find. Only
	// the first page carries it.
	DefaultBranch string `json:"default_branch,omitempty"`
	// DefaultLine names the default branch's refs ("main", "origin/main")
	// that the listing draws as a line of their own: walked from, and not in
	// HEAD's history, where they would sit on HEAD's line. The client keeps a
	// lane for them only then — a lane held for a line that never comes is a
	// gap in the graph. Empty in ScopeMainline. Only the first page carries it.
	DefaultLine []string `json:"default_line,omitempty"`
}

// RefType is what kind of ref a Ref is.
type RefType string

const (
	RefHead   RefType = "head"
	RefBranch RefType = "branch"
	RefRemote RefType = "remote"
	RefTag    RefType = "tag"
)

// Ref is a ref pointing at a commit.
type Ref struct {
	// Name is "HEAD", a branch ("main"), a remote branch ("origin/main") or a
	// tag ("v1.0").
	Name string  `json:"name"`
	Type RefType `json:"type"`
	// Current marks the branch HEAD is on. HEAD itself is listed as well, so
	// "is this HEAD" is the same question whether HEAD is detached or not.
	Current bool `json:"current,omitempty"`
}

// History lists one page of commits for the history graph.
//
// The commits carry their parents and refs so the client can lay out the
// graph itself: how many lanes fit is a question of the screen's width, which
// the server does not know. A search or path filter makes the listed commits
// non-adjacent, so their parents may not be among them.
func History(dir string, q HistoryQuery) (*HistoryPage, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = defaultHistoryLimit
	}
	limit = min(limit, maxHistoryLimit)

	var pathspec string
	if q.Path != "" {
		if err := validatePath(q.Path); err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInvalidArgument, err)
		}
		var err error
		if pathspec, err = literalPathspec(q.Path); err != nil {
			return nil, fmt.Errorf("%w: %w", ErrInvalidArgument, err)
		}
	}
	// git splits --grep on newlines into patterns any one of which matches,
	// even with --fixed-strings.
	if strings.ContainsAny(q.Grep, "\r\n") {
		return nil, fmt.Errorf("%w: search text spans lines", ErrInvalidArgument)
	}
	if q.Cursor != nil {
		if len(q.Cursor.Tips) == 0 || q.Cursor.Skip < 0 {
			return nil, fmt.Errorf("%w: malformed cursor", ErrInvalidArgument)
		}
		for _, tip := range q.Cursor.Tips {
			// Full hashes only, which is all a cursor ever holds.
			if err := validateFullHash(tip); err != nil {
				return nil, fmt.Errorf("%w: malformed cursor tip %q", ErrInvalidArgument, tip)
			}
		}
	}

	refs, err := readRefs(dir)
	if err != nil {
		return nil, err
	}
	hasRemote := len(refs.remotes) > 0

	page := &HistoryPage{Commits: []Commit{}}
	tips, skip := scopeTips(refs, q.Scope), 0
	if q.Cursor != nil {
		tips, skip = q.Cursor.Tips, q.Cursor.Skip
	} else {
		count, err := unpushedCount(dir, tips, q.Scope, hasRemote)
		if err != nil {
			return nil, err
		}
		page.UnpushedCount = &count
		var defaultRefs []string
		page.DefaultBranch, defaultRefs = refs.defaultBranch()
		if q.Scope != ScopeMainline {
			if page.DefaultLine, err = defaultLine(dir, refs, defaultRefs, tips); err != nil {
				return nil, err
			}
		}
		if page.Shallow, err = isShallow(dir); err != nil {
			return nil, err
		}
	}
	// Before the first commit there is nothing to walk from, and git log would
	// fall back to HEAD and fail on it.
	if len(tips) == 0 {
		return page, nil
	}

	args := []string{
		"log", "--date-order",
		// log.showSignature would print each commit's verification between the
		// delimited blocks, where the parser takes it for part of the date.
		"--no-show-signature",
		"--max-count=" + strconv.Itoa(limit+1),
		"--skip=" + strconv.Itoa(skip),
		"--format=" + commitFormat,
		// log.follow turns on --follow whenever one path is given, and --follow
		// tracks a single line of history, not several branches at once.
		"--no-follow",
	}
	if q.Scope == ScopeMainline {
		args = append(args, "--first-parent")
	}
	if q.Grep != "" {
		args = append(args, "--regexp-ignore-case", "--fixed-strings", "--grep="+q.Grep)
	}
	// Tips go through stdin: ScopeAll has one per branch, which can outgrow
	// Windows' 32K command line.
	args = append(args, "--stdin", "--")
	if pathspec != "" {
		args = append(args, pathspec)
	}
	output, err := execGitInput(dir, []byte(strings.Join(tips, "\n")+"\n"), args...)
	if err != nil {
		return nil, err
	}

	if commits := parseLogOutput(output); len(commits) > 0 {
		page.Commits = commits
	}
	if len(page.Commits) > limit {
		page.Commits = page.Commits[:limit]
		page.Next = &HistoryCursor{Tips: tips, Skip: skip + limit}
	}

	refs.decorate(page.Commits)
	switch {
	case !hasRemote:
	case !refs.hasRemoteTracking():
		// A remote nothing was fetched from or pushed to yet: everything is
		// unpushed, and asking git would walk the whole history every page.
		for i := range page.Commits {
			page.Commits[i].Unpushed = true
		}
	default:
		if err := markUnpushed(dir, page.Commits); err != nil {
			return nil, err
		}
	}
	return page, nil
}

// scopeTips resolves scope to the commits History walks from, HEAD first and
// without repeats.
func scopeTips(refs *repoRefs, scope HistoryScope) []string {
	var tips []string
	seen := make(map[string]bool)
	add := func(hash string) {
		if hash != "" && !seen[hash] {
			seen[hash] = true
			tips = append(tips, hash)
		}
	}

	add(refs.head)
	switch scope {
	case ScopeAll:
		for _, ref := range refs.refs {
			if strings.HasPrefix(ref.name, "refs/heads/") {
				add(ref.hash)
				add(refs.byName[ref.upstream])
			}
		}
	case ScopeMainline:
		// HEAD alone: the first-parent chain of anything else is not this
		// branch's mainline.
	default:
		if refs.branch != "" {
			add(refs.byName[refs.upstreamOf("refs/heads/"+refs.branch)])
		}
		_, defaultRefs := refs.defaultBranch()
		for _, ref := range defaultRefs {
			add(refs.byName[ref])
		}
	}
	return tips
}

// defaultLine picks, of the default branch's full ref names, the ones walked
// from that HEAD does not contain, as the names Ref carries.
func defaultLine(dir string, refs *repoRefs, defaultRefs, tips []string) ([]string, error) {
	var names []string
	for _, ref := range defaultRefs {
		hash := refs.byName[ref]
		if !slices.Contains(tips, hash) {
			continue
		}
		if refs.head != "" {
			contained, err := isAncestor(dir, hash, refs.head)
			if err != nil {
				return nil, err
			}
			if contained {
				continue
			}
		}
		name, ok := strings.CutPrefix(ref, "refs/heads/")
		if !ok {
			name = strings.TrimPrefix(ref, "refs/remotes/")
		}
		names = append(names, name)
	}
	return names, nil
}

// isAncestor reports whether commit is in the history of descendant (or is
// it). Exit 1 is "no"; anything else that fails is an error.
func isAncestor(dir, commit, descendant string) (bool, error) {
	_, err := execGit(dir, "merge-base", "--is-ancestor", commit, descendant)
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return true, nil
	case errors.As(err, &exitErr) && exitErr.ExitCode() == 1:
		return false, nil
	default:
		return false, err
	}
}

// unpushedCount counts the commits reachable from tips that no remote-tracking
// ref contains, along the same parents History follows for scope.
func unpushedCount(dir string, tips []string, scope HistoryScope, hasRemote bool) (int, error) {
	if !hasRemote || len(tips) == 0 {
		return 0, nil
	}
	args := []string{"rev-list", "--count"}
	if scope == ScopeMainline {
		args = append(args, "--first-parent")
	}
	// Revisions read from stdin are positive whatever precedes --stdin, so the
	// exclusion is spelled after it.
	args = append(args, "--stdin", "--not", "--remotes")
	out, err := execGitInput(dir, []byte(strings.Join(tips, "\n")+"\n"), args...)
	if err != nil {
		return 0, err
	}
	count, err := strconv.Atoi(out)
	if err != nil {
		return 0, fmt.Errorf("unexpected rev-list count output: %q", out)
	}
	return count, nil
}

// markUnpushed sets Unpushed on the commits no remote-tracking ref contains.
//
// One rev-list for the whole page rather than a question per commit: git
// walks the page's commits and the remote-tracking refs together until they
// meet, which is milliseconds even deep into a long history.
func markUnpushed(dir string, commits []Commit) error {
	if len(commits) == 0 {
		return nil
	}
	args := []string{"rev-list"}
	for _, c := range commits {
		args = append(args, c.Hash)
	}
	args = append(args, "--not", "--remotes")
	unpushed, err := execGitLines(dir, args...)
	if err != nil {
		return err
	}
	set := make(map[string]bool, len(unpushed))
	for _, hash := range unpushed {
		set[hash] = true
	}
	for i := range commits {
		commits[i].Unpushed = set[commits[i].Hash]
	}
	return nil
}

func isShallow(dir string) (bool, error) {
	out, err := execGit(dir, "rev-parse", "--is-shallow-repository")
	return out == "true", err
}

// repoRefs is one reading of the repository's refs.
type repoRefs struct {
	head   string // HEAD's commit; empty before the first commit
	branch string // the branch HEAD is on; empty while detached
	// remotes are the configured remotes, longest name first (see
	// splitRemoteRef).
	remotes []string
	refs    []refEntry
	byName  map[string]string // full ref name -> commit
}

func (r *repoRefs) hasRemoteTracking() bool {
	return slices.ContainsFunc(r.refs, func(ref refEntry) bool {
		return strings.HasPrefix(ref.name, "refs/remotes/")
	})
}

type refEntry struct {
	name     string // full, "refs/heads/main"
	hash     string // the commit, an annotated tag peeled
	upstream string // full ref of a local branch's upstream, if any
	symref   string // target of a symbolic ref ("refs/remotes/origin/HEAD")
}

// readRefs reads HEAD and every branch, remote branch and tag in one pass, so
// the scope and the decorations of a page come from the same moment.
func readRefs(dir string) (*repoRefs, error) {
	refs := &repoRefs{byName: make(map[string]string)}

	head, err := execGit(dir, "rev-parse", "--verify", "--quiet", "HEAD")
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		refs.head = head
	case errors.As(err, &exitErr) && exitErr.ExitCode() == 1:
		// Unborn: the branch is named but has no commit yet.
	default:
		return nil, err
	}
	if refs.branch, err = CurrentBranch(dir); err != nil && !errors.Is(err, ErrDetachedHead) {
		return nil, err
	}
	if refs.remotes, err = execGitLines(dir, "remote"); err != nil {
		return nil, err
	}
	sort.Slice(refs.remotes, func(i, j int) bool { return len(refs.remotes[i]) > len(refs.remotes[j]) })

	// Ref names cannot contain control characters, so a tab cannot occur
	// inside a field. %(*objectname) peels one level, so a tag of a tag
	// decorates nothing; such chains are rare enough not to cost a second
	// command. The fields that may be empty are kept off both ends,
	// which the output's trimming would otherwise eat.
	lines, err := execGitLines(dir, "for-each-ref",
		"--format=%(objectname)%09%(*objectname)%09%(upstream)%09%(symref)%09%(refname)",
		"refs/heads", "refs/remotes", "refs/tags")
	if err != nil {
		return nil, err
	}
	for _, line := range lines {
		fields := strings.Split(line, "\t")
		if len(fields) != 5 {
			return nil, fmt.Errorf("unexpected for-each-ref output: %q", line)
		}
		entry := refEntry{hash: fields[0], upstream: fields[2], symref: fields[3], name: fields[4]}
		if fields[1] != "" {
			entry.hash = fields[1]
		}
		refs.refs = append(refs.refs, entry)
		refs.byName[entry.name] = entry.hash
	}
	return refs, nil
}

func (r *repoRefs) entry(name string) *refEntry {
	for i := range r.refs {
		if r.refs[i].name == name {
			return &r.refs[i]
		}
	}
	return nil
}

func (r *repoRefs) upstreamOf(branchRef string) string {
	if e := r.entry(branchRef); e != nil {
		return e.upstream
	}
	return ""
}

// defaultBranch returns the name of the repository's default branch and its
// existing refs: the local branch and the remote's one of the same name.
//
// The remote is the one the current branch tracks, else origin, else the only
// one there is. Its default branch is what its HEAD points at, which clone and
// `remote set-head` record; failing that, main or master, whichever exists.
// A repository with several remotes and none of these has no default branch
// worth guessing at, and the scope is HEAD and its upstream alone.
func (r *repoRefs) defaultBranch() (name string, refs []string) {
	var remote string
	if r.branch != "" {
		if short, name, ok := splitRemoteRef(r.upstreamOf("refs/heads/"+r.branch), r.remotes); ok {
			remote = strings.TrimSuffix(short, "/"+name)
		}
	}
	if remote == "" {
		if slices.Contains(r.remotes, "origin") {
			remote = "origin"
		} else if len(r.remotes) == 1 {
			remote = r.remotes[0]
		}
	}

	existing := func(name string) []string {
		candidates := []string{"refs/heads/" + name}
		if remote != "" {
			candidates = append(candidates, "refs/remotes/"+remote+"/"+name)
		}
		var result []string
		for _, ref := range candidates {
			if _, ok := r.byName[ref]; ok {
				result = append(result, ref)
			}
		}
		return result
	}

	if remote != "" {
		if e := r.entry("refs/remotes/" + remote + "/HEAD"); e != nil {
			if name, ok := strings.CutPrefix(e.symref, "refs/remotes/"+remote+"/"); ok {
				return name, existing(name)
			}
		}
	}
	for _, name := range []string{"main", "master"} {
		if refs := existing(name); len(refs) > 0 {
			return name, refs
		}
	}
	return "", nil
}

// decorate sets Refs on each commit some ref points at.
func (r *repoRefs) decorate(commits []Commit) {
	byHash := make(map[string][]Ref)
	if r.head != "" {
		byHash[r.head] = append(byHash[r.head], Ref{Name: "HEAD", Type: RefHead})
	}
	for _, ref := range r.refs {
		// origin/HEAD only repeats the remote branch it points at.
		if ref.symref != "" {
			continue
		}
		var decoration Ref
		if name, ok := strings.CutPrefix(ref.name, "refs/heads/"); ok {
			decoration = Ref{Name: name, Type: RefBranch, Current: name == r.branch}
		} else if name, ok := strings.CutPrefix(ref.name, "refs/remotes/"); ok {
			decoration = Ref{Name: name, Type: RefRemote}
		} else if name, ok := strings.CutPrefix(ref.name, "refs/tags/"); ok {
			decoration = Ref{Name: name, Type: RefTag}
		} else {
			continue
		}
		byHash[ref.hash] = append(byHash[ref.hash], decoration)
	}

	for i := range commits {
		refs := byHash[commits[i].Hash]
		// The client shows the first few and folds the rest, so the ones that
		// say most about the commit come first.
		sort.SliceStable(refs, func(a, b int) bool {
			return refRank(refs[a]) < refRank(refs[b])
		})
		commits[i].Refs = refs
	}
}

func refRank(ref Ref) int {
	switch {
	case ref.Type == RefHead:
		return 0
	case ref.Current:
		return 1
	case ref.Type == RefBranch:
		return 2
	case ref.Type == RefRemote:
		return 3
	default:
		return 4
	}
}
