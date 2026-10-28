package git

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// The operations a repository can be left in the middle of. They are a
// contract: the client renders them, and the abort request names one back.
// Each is also the git subcommand that aborts it (`git <kind> --abort`).
const (
	OperationMerge      = "merge"
	OperationRebase     = "rebase"
	OperationCherryPick = "cherry-pick"
	OperationRevert     = "revert"
)

// IsOperationKind reports whether kind is one of the operations above.
func IsOperationKind(kind string) bool {
	switch kind {
	case OperationMerge, OperationRebase, OperationCherryPick, OperationRevert:
		return true
	}
	return false
}

// Operation is a merge, rebase, cherry-pick or revert the repository has been
// left in the middle of — by an AI session or by the user elsewhere, since the
// workspace starts none of them. Every field but Kind is what git could say
// about it, and absent when it could not.
type Operation struct {
	Kind string `json:"kind"`
	// Commit is the commit being brought in: the one merged (MERGE_HEAD), the
	// one a rebase is replaying (REBASE_HEAD), or the one picked or reverted.
	// A cherry-pick or revert of several commits that is between two of them
	// has none.
	Commit *OperationCommit `json:"commit,omitempty"`
	// Branch is the branch a rebase is rewriting, empty for a detached HEAD
	// and for the other kinds — whose branch is simply the current one.
	Branch string `json:"branch,omitempty"`
	// Onto is the commit a rebase replays onto.
	Onto *OperationCommit `json:"onto,omitempty"`
	// Step is a rebase's progress. Only a rebase keeps count: a sequence of
	// cherry-picks or reverts records what is left, not what is done.
	Step *OperationStep `json:"step,omitempty"`
}

// OperationCommit names a commit an operation involves.
type OperationCommit struct {
	Hash    string `json:"hash"`
	Subject string `json:"subject"`
	// Ref is a local or remote-tracking branch pointing exactly at the commit,
	// local branches first, empty when none does. It is how "merging feature"
	// is told from "merging 1a2b3c4": git records the commit, not the name the
	// user typed, so this is the branch that is there now.
	Ref string `json:"ref,omitempty"`
}

// OperationStep is "at step Current of Total", counted from 1: git's own count
// of the rebase's todo list, which is one step per commit replayed unless the
// list was edited to run commands too (exec, or the label/reset/merge lines of
// --rebase-merges).
type OperationStep struct {
	Current int `json:"current"`
	Total   int `json:"total"`
}

// OperationChangedError refuses an abort of an operation that is not the one
// in progress — it ended, or another started, since the user confirmed. A
// refusal rather than aborting whatever is there: what the user agreed to lose
// was the work of that one operation.
type OperationChangedError struct {
	Want string
	// Current is the operation in progress now, empty when there is none.
	Current string
}

func (e *OperationChangedError) Error() string {
	if e.Current == "" {
		return fmt.Sprintf("no %s is in progress", e.Want)
	}
	return fmt.Sprintf("no %s is in progress (a %s is)", e.Want, e.Current)
}

// OperationInProgressError refuses a write the workspace pauses while an
// operation is in progress. Each would finish or derail it rather than do what
// it says: a commit concludes a merge, pick or revert (the --continue left to
// whoever started it) and inserts a stray commit into a rebase; a checkout or
// a new branch leaves the operation's state behind on another branch; a pull
// moves HEAD under it. The client disables these controls too; this is the
// boundary for a client that has not yet seen the operation begin.
type OperationInProgressError struct {
	// Action is the refused write as a verb phrase ("commit", "switch branches").
	Action string
	Kind   string
}

func (e *OperationInProgressError) Error() string {
	return fmt.Sprintf("can't %s during a %s: finish or abort the %s first", e.Action, e.Kind, e.Kind)
}

// refuseDuringOperation returns an OperationInProgressError when dir's
// repository is in the middle of an operation. Called inside the write's lock:
// every operation that starts or ends one from here (Abort) takes the index
// lock, as these writes do, so the answer holds until the write has run.
func refuseDuringOperation(dir, action string) error {
	op, err := readOperation(context.Background(), dir)
	if err != nil {
		return err
	}
	if op != nil {
		return &OperationInProgressError{Action: action, Kind: op.Kind}
	}
	return nil
}

// Abort abandons the operation of the given kind, putting the branch, index
// and working tree back where they were before it started. Whatever was
// resolved so far is lost; the confirmation is the client's.
//
// headKept reports the one case where git ends the operation without putting
// the branch back: a sequence of picks or reverts whose HEAD was moved during
// it — in practice a conflict resolved with a plain `git commit` rather than
// --continue. git then only warns and exits 0, so without this the commits
// left on the branch would pass for an abort that undid them.
func Abort(dir, kind string) (headKept bool, err error) {
	err = withLock(dir, opAbort, func() error {
		ctx := context.Background()
		current, err := readOperation(ctx, dir)
		if err != nil {
			return err
		}
		if current == nil || current.Kind != kind {
			changed := &OperationChangedError{Want: kind}
			if current != nil {
				changed.Current = current.Kind
			}
			return changed
		}
		if kind == OperationCherryPick || kind == OperationRevert {
			if headKept, err = sequenceMovedHead(ctx, dir); err != nil {
				return err
			}
		}
		return execGitVerbose(dir, kind, "--abort")
	})
	return headKept, err
}

// sequenceMovedHead is the test git's sequencer makes before rolling a
// sequence back (rollback_is_safe in sequencer.c): HEAD has to be the commit
// recorded in sequencer/abort-safety after the last pick it made, a missing
// file counting as no commit. A single pick or revert keeps no sequencer
// directory, makes no commit and is always rolled back.
func sequenceMovedHead(ctx context.Context, dir string) (bool, error) {
	paths, err := gitPaths(ctx, dir, "sequencer")
	if err != nil {
		return false, err
	}
	if !isDir(paths["sequencer"]) {
		return false, nil
	}
	heads, err := resolveRefs(ctx, dir, "HEAD")
	if err != nil {
		return false, err
	}
	return heads["HEAD"] != readStateFile(paths["sequencer"], "abort-safety"), nil
}

// operationStatePaths are where git keeps what an operation in progress needs
// to go on, as files: the rebase and sequencer state directories.
var operationStatePaths = []string{"rebase-merge", "rebase-apply", "sequencer/todo"}

// operationHeads are the refs an operation in progress leaves behind. Asked of
// git by name rather than read as files, because under the reftable backend
// only MERGE_HEAD is still a file.
var operationHeads = []string{"REBASE_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"}

// shadowsOf are the refs git also tries for a bare name when no ref of that
// exact name exists (ref_rev_parse_rules in refs.c, after the name itself): a
// branch or tag called MERGE_HEAD would otherwise read as a merge in progress.
func shadowsOf(name string) []string {
	return []string{
		"refs/" + name,
		"refs/tags/" + name,
		"refs/heads/" + name,
		"refs/remotes/" + name,
		"refs/remotes/" + name + "/HEAD",
	}
}

// readOperationHeads resolves operationHeads by their exact names, leaving out
// the ones that do not exist. Still one process: the shadows are asked in the
// same batch. Only a name some shadow exists for is ambiguous, and then git's
// answer may be the shadow's; the head is believed only if its file is there
// (statePaths has every head's path). A reftable repository that keeps it out
// of a file and also has such a branch reads it as absent — rarer than rare,
// and the safe side: nothing is refused that git would allow.
func readOperationHeads(ctx context.Context, dir string, statePaths map[string]string) (map[string]string, error) {
	names := append([]string(nil), operationHeads...)
	for _, head := range operationHeads {
		names = append(names, shadowsOf(head)...)
	}
	resolved, err := resolveRefs(ctx, dir, names...)
	if err != nil {
		return nil, err
	}
	heads := make(map[string]string, len(operationHeads))
	for _, head := range operationHeads {
		hash := resolved[head]
		if hash == "" {
			continue
		}
		if slices.ContainsFunc(shadowsOf(head), func(shadow string) bool { return resolved[shadow] != "" }) &&
			!isFile(statePaths[head]) {
			continue
		}
		heads[head] = hash
	}
	return heads, nil
}

// readOperation is the operation dir's repository is in the middle of, nil
// when there is none. It follows how `git status` decides (wt-status.c), with
// rebase first: a rebase stopped on a merge it is recreating has MERGE_HEAD
// too, and aborting that merge alone would leave the rebase behind.
//
// `git am` also keeps its state in rebase-apply, and is not reported: nothing
// in the workspace leads to it.
func readOperation(ctx context.Context, dir string) (*Operation, error) {
	state, err := gitPaths(ctx, dir, append(operationStatePaths, operationHeads...)...)
	if err != nil {
		return nil, err
	}
	heads, err := readOperationHeads(ctx, dir, state)
	if err != nil {
		return nil, err
	}

	var op *Operation
	switch {
	case isDir(state["rebase-merge"]):
		op = readRebase(state["rebase-merge"], "msgnum", "end", heads["REBASE_HEAD"])
	case isDir(state["rebase-apply"]) && isFile(filepath.Join(state["rebase-apply"], "rebasing")):
		op = readRebase(state["rebase-apply"], "next", "last", heads["REBASE_HEAD"])
	case heads["MERGE_HEAD"] != "":
		op = &Operation{Kind: OperationMerge, Commit: commitRef(heads["MERGE_HEAD"])}
	case heads["CHERRY_PICK_HEAD"] != "":
		op = &Operation{Kind: OperationCherryPick, Commit: commitRef(heads["CHERRY_PICK_HEAD"])}
	case heads["REVERT_HEAD"] != "":
		op = &Operation{Kind: OperationRevert, Commit: commitRef(heads["REVERT_HEAD"])}
	default:
		// A sequence of picks or reverts between two of its commits: the one
		// that stopped it was resolved and committed, and the rest wait for
		// --continue. Still abortable, and still the user's to finish.
		switch sequencerCommand(state["sequencer/todo"]) {
		case "pick", "p":
			op = &Operation{Kind: OperationCherryPick}
		case "revert":
			op = &Operation{Kind: OperationRevert}
		}
	}
	if op == nil {
		return nil, nil
	}
	if err := describeCommits(ctx, dir, op.Commit, op.Onto); err != nil {
		return nil, err
	}
	return op, nil
}

// readRebase reads either backend's state directory. They keep the same facts
// under different names: the merge backend (the default, and every
// interactive rebase) counts in msgnum/end, the apply backend in next/last.
func readRebase(stateDir, currentFile, totalFile, rebaseHead string) *Operation {
	op := &Operation{Kind: OperationRebase, Commit: commitRef(rebaseHead)}
	// "detached HEAD" when the rebase did not start on a branch.
	if head := readStateFile(stateDir, "head-name"); strings.HasPrefix(head, "refs/heads/") {
		op.Branch = strings.TrimPrefix(head, "refs/heads/")
	}
	op.Onto = commitRef(readStateFile(stateDir, "onto"))

	current, currentErr := strconv.Atoi(readStateFile(stateDir, currentFile))
	total, totalErr := strconv.Atoi(readStateFile(stateDir, totalFile))
	if currentErr == nil && totalErr == nil && total > 0 {
		op.Step = &OperationStep{Current: current, Total: total}
	}
	return op
}

func commitRef(hash string) *OperationCommit {
	if hash == "" {
		return nil
	}
	return &OperationCommit{Hash: hash}
}

// readStateFile is one file of an operation's state directory, trimmed, or
// empty when it is missing: what it would have said is simply not reported.
func readStateFile(stateDir, name string) string {
	data, err := os.ReadFile(filepath.Join(stateDir, name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// sequencerCommand is the first word of the sequencer's todo list — the
// command the interrupted sequence was running — or empty when there is none.
func sequencerCommand(todoPath string) string {
	data, err := os.ReadFile(todoPath)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		return strings.Fields(line)[0]
	}
	return ""
}

// gitPaths resolves names inside dir's git directory, in one process.
//
// Through git rather than by joining ".git": in a linked worktree .git is a
// file pointing elsewhere, and the per-worktree state (a rebase, a sequence)
// lives in that worktree's own git directory, not the common one.
func gitPaths(ctx context.Context, dir string, names ...string) (map[string]string, error) {
	args := []string{"rev-parse"}
	for _, name := range names {
		args = append(args, "--git-path", name)
	}
	output, err := execGitRaw(ctx, dir, args...)
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimRight(output, "\r\n"), "\n")
	if len(lines) != len(names) {
		return nil, fmt.Errorf("git rev-parse --git-path: expected %d paths, got %d", len(names), len(lines))
	}
	paths := make(map[string]string, len(names))
	for i, name := range names {
		// Relative to dir unless git chose to make it absolute (a linked
		// worktree's), and always with forward slashes.
		path := filepath.FromSlash(strings.TrimRight(lines[i], "\r"))
		if !filepath.IsAbs(path) {
			path = filepath.Join(dir, path)
		}
		paths[name] = path
	}
	return paths, nil
}

// resolveRefs is the commit each named ref points at, in one process, with
// refs that do not exist left out.
func resolveRefs(ctx context.Context, dir string, names ...string) (map[string]string, error) {
	cmd := gitCommandContext(ctx, dir, "cat-file", "--batch-check=%(objectname) %(objecttype)")
	cmd.Stdin = strings.NewReader(strings.Join(names, "\n") + "\n")
	output, err := cmd.Output()
	if err != nil {
		return nil, newCommandError(cmd.Args[1:], stderrOf(err), err)
	}
	lines := strings.Split(strings.TrimRight(string(output), "\n"), "\n")
	if len(lines) != len(names) {
		return nil, fmt.Errorf("git cat-file --batch-check: expected %d answers, got %d", len(names), len(lines))
	}
	resolved := make(map[string]string, len(names))
	for i, name := range names {
		// "<name> missing" for a ref that does not exist.
		fields := strings.Fields(lines[i])
		if len(fields) == 2 && fields[1] == "commit" {
			resolved[name] = fields[0]
		}
	}
	return resolved, nil
}

// stderrOf is what git said on its way out; Output collects it into the
// ExitError when the command has no Stderr of its own.
func stderrOf(err error) string {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return string(exitErr.Stderr)
	}
	return ""
}

// describeCommits fills in the subject and branch of each commit given, two
// processes for all of them.
func describeCommits(ctx context.Context, dir string, commits ...*OperationCommit) error {
	var hashes []string
	for _, c := range commits {
		if c != nil {
			hashes = append(hashes, c.Hash)
		}
	}
	if len(hashes) == 0 {
		return nil
	}

	// --ignore-missing because onto is read from a file rather than resolved:
	// a commit git cannot find leaves its subject unknown, and must not take
	// the whole status down with it.
	logArgs := append([]string{"log", "--no-walk=unsorted", "--ignore-missing", "--format=%H%x00%s"}, hashes...)
	subjects, err := execGitRaw(ctx, dir, logArgs...)
	if err != nil {
		return err
	}
	subjectOf := make(map[string]string, len(hashes))
	for _, line := range strings.Split(subjects, "\n") {
		if hash, subject, ok := strings.Cut(line, "\x00"); ok {
			subjectOf[hash] = subject
		}
	}

	// Sorted by full refname, so refs/heads/ comes before refs/remotes/.
	refArgs := []string{"for-each-ref", "--format=%(objectname)%00%(refname:short)%00%(symref)"}
	for _, hash := range hashes {
		refArgs = append(refArgs, "--points-at", hash)
	}
	refArgs = append(refArgs, "refs/heads", "refs/remotes")
	refs, err := execGitRaw(ctx, dir, refArgs...)
	if err != nil {
		return err
	}
	refOf := make(map[string]string, len(hashes))
	for _, line := range strings.Split(refs, "\n") {
		fields := strings.Split(line, "\x00")
		// A symbolic ref (origin/HEAD) names a branch rather than being one.
		if len(fields) != 3 || fields[2] != "" {
			continue
		}
		if _, taken := refOf[fields[0]]; !taken {
			refOf[fields[0]] = fields[1]
		}
	}

	for _, c := range commits {
		if c != nil {
			c.Subject = subjectOf[c.Hash]
			c.Ref = refOf[c.Hash]
		}
	}
	return nil
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func isFile(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
