package git

import (
	"bytes"
	"fmt"
	"io"
	"strconv"

	"github.com/pockode/server/contents"
)

// ShowFile returns the content of path as it stood in commit hash, described
// exactly the way contents.GetContents describes a file in the working tree so
// that a client renders a historical version with the code it already has.
//
// A path that the commit does not contain is contents.ErrNotFound, which a
// caller following a commit's file list reaches by asking a deleting commit for
// what it deleted. A path that names a directory or a submodule there is
// contents.ErrInvalidPath: there is no listing to fall back on the way file.get
// has for a directory.
func ShowFile(dir, hash, path string) (*contents.FileContent, error) {
	if err := validateCommitHash(hash); err != nil {
		return nil, err
	}
	if err := validatePath(path); err != nil {
		return nil, err
	}

	// git resolves <rev>:<path> against the repository root, so no pathspec is
	// involved and none of literalPathspec's magic applies.
	spec := hash + ":" + path

	objectType, err := execGit(dir, "cat-file", "-t", spec)
	if err != nil {
		// git's own message is kept because it is the only thing that separates
		// the ordinary case — the commit does not have this path — from a commit
		// that does not exist or a directory that is not a repository. Both
		// arrive here as the same non-zero exit.
		return nil, fmt.Errorf("%w: %s in commit %s: %w", contents.ErrNotFound, path, hash, err)
	}
	if objectType != "blob" {
		return nil, fmt.Errorf("%w: %s is not a file in commit %s (git object type %s)", contents.ErrInvalidPath, path, hash, objectType)
	}

	sizeOutput, err := execGit(dir, "cat-file", "-s", spec)
	if err != nil {
		return nil, fmt.Errorf("git cat-file -s failed for %s in commit %s: %w", path, hash, err)
	}
	size, err := strconv.ParseInt(sizeOutput, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("unreadable object size %q for %s in commit %s: %w", sizeOutput, path, hash, err)
	}

	// A blob over the limit is never read past its head: the content is not
	// going to be sent, and the object may be gigabytes.
	oversized := size > contents.MaxFileSize
	limit := size
	if oversized {
		limit = contents.SniffLen
	}

	content, err := readBlob(dir, spec, limit, oversized)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s in commit %s: %w", path, hash, err)
	}

	return contents.NewFileContent(path, size, content), nil
}

// readBlob reads the object named by spec, at most limit bytes of it.
//
// partial says the object is known to be longer than limit, so git is stopped
// on a closed pipe rather than buffered in full — and its exit status then says
// nothing, since dying on that pipe is the expected end. Only a read that was
// meant to reach the object's end can hold git to exiting cleanly.
func readBlob(dir, spec string, limit int64, partial bool) ([]byte, error) {
	args := []string{"cat-file", "blob", spec}
	cmd := gitCommand(dir, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	content, readErr := io.ReadAll(io.LimitReader(stdout, limit))
	stdout.Close()
	waitErr := cmd.Wait()

	if readErr != nil {
		return nil, readErr
	}
	if waitErr != nil && !partial {
		return nil, newCommandError(args, stderr.String(), waitErr)
	}
	return content, nil
}
