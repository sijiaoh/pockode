package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Discard throws away the unstaged state of paths: a tracked file is restored
// from the index, an untracked file is deleted.
//
// Which of the two a path gets is decided here from a fresh status, never taken
// from the caller. The panel's file list is only as new as its last refresh,
// and the two branches are not interchangeable — taking the delete branch for a
// path that has since been added to the index would destroy work nobody asked
// to lose. Discarded worktree changes are not in the reflog, so there is no
// recovering from picking wrong.
//
// Neither branch touches the index: a file that was staged and then edited
// again keeps what was staged, which is what the panel offers — discard appears
// on unstaged rows only.
func Discard(dir string, paths []string) error {
	if len(paths) == 0 {
		return fmt.Errorf("no paths to discard")
	}

	// Everything is validated before anything runs, so a rejected path stops the
	// operation rather than leaving half of it applied.
	for _, path := range paths {
		if err := validatePath(path); err != nil {
			return err
		}
	}

	submodules := getSubmodulePaths(dir)
	status, err := statusWithSubmodules(dir, submodules)
	if err != nil {
		return fmt.Errorf("failed to read status: %w", err)
	}

	groups, err := groupForDiscard(status, submodules, dir, paths)
	if err != nil {
		return err
	}

	for _, group := range groups {
		if err := group.run(); err != nil {
			return err
		}
	}
	return nil
}

// discardPath is one file of a group, in the three forms the operation needs.
// They differ only for submodule paths, which is exactly where using the wrong
// one goes unnoticed.
type discardPath struct {
	// requested is the path as the client sent it, submodule prefix included.
	// It is what the panel's file list shows, so any message naming the file has
	// to use this form.
	requested string
	// relative is requested resolved into the repository the group runs in, which
	// is what git and the after-the-fact Lstat take.
	relative string
	// pathspec is relative with pathspec magic disabled. Built when the group is
	// assembled rather than when it runs, so a path git would read as something
	// other than itself is refused before any group has deleted anything.
	pathspec string
}

// discardGroup is one git invocation: the repository to run in, and whether its
// paths are to be deleted or restored.
type discardGroup struct {
	dir       string
	untracked bool
	paths     []discardPath
}

// groupForDiscard sorts paths into one group per (repository, kind), so
// discarding every unstaged change is a handful of git calls rather than one
// per file. Submodule paths resolve into the submodule the way Add and Reset
// already do, and arrive relative to it.
func groupForDiscard(status *GitStatus, submodules []string, dir string, paths []string) ([]*discardGroup, error) {
	var groups []*discardGroup
	byKey := make(map[string]*discardGroup)

	for _, path := range paths {
		actualDir, relativePath := resolveSubmodulePathWith(submodules, dir, path)
		pathspec, err := literalPathspec(relativePath)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", err, path)
		}
		untracked := status.IsUntracked(path)

		key := fmt.Sprintf("%t\x00%s", untracked, actualDir)
		group := byKey[key]
		if group == nil {
			group = &discardGroup{dir: actualDir, untracked: untracked}
			byKey[key] = group
			groups = append(groups, group)
		}
		group.paths = append(group.paths, discardPath{
			requested: path,
			relative:  relativePath,
			pathspec:  pathspec,
		})
	}

	return groups, nil
}

func (g *discardGroup) pathspecs() []string {
	specs := make([]string, len(g.paths))
	for i, p := range g.paths {
		specs[i] = p.pathspec
	}
	return specs
}

func (g *discardGroup) run() error {
	if !g.untracked {
		// --worktree alone restores from the index and leaves it untouched.
		_, err := execGit(g.dir, append([]string{"restore", "--worktree", "--"}, g.pathspecs()...)...)
		return err
	}

	// git clean rather than removing the files here, because it refuses to touch
	// anything git tracks: should a path be classified wrongly, the result is a
	// no-op instead of a deletion.
	//
	// Failures land on stderr (a permission error reads "warning: failed to
	// remove x: Permission denied" there and exits non-zero), as they do for
	// restore, so execGit reports both.
	if _, err := execGit(g.dir, append([]string{"clean", "-f", "--"}, g.pathspecs()...)...); err != nil {
		return err
	}
	return g.verifyRemoved()
}

// verifyRemoved reports the paths git clean left behind.
//
// A directory holding its own git repository is skipped in silence — exit 0,
// no output — and `git status -uall` keeps listing it as one untracked entry,
// so without this check the user would confirm a deletion and watch nothing
// happen. Forcing it through would take `-ff`, which overrides that protection
// for a repository whose commits may exist nowhere else.
func (g *discardGroup) verifyRemoved() error {
	var remaining []string
	for _, p := range g.paths {
		// Lstat on the group-relative form, but report the requested one: inside a
		// submodule they differ, and a message naming "nested/" for a file the
		// panel lists as "vendor/sdk/nested/" sends the user looking in the wrong
		// place.
		if _, err := os.Lstat(filepath.Join(g.dir, p.relative)); err == nil {
			remaining = append(remaining, p.requested)
		}
	}
	if len(remaining) == 0 {
		return nil
	}

	return fmt.Errorf(
		"git clean left %s in place: git does not delete a directory that contains its own repository",
		strings.Join(remaining, ", "),
	)
}
