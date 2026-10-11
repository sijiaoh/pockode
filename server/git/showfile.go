package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"

	"github.com/pockode/server/contents"
)

// ErrInvalidArgument marks a commit hash or a path refused before git was run,
// so a caller can answer it as the client's mistake rather than a fault here.
var ErrInvalidArgument = errors.New("invalid argument")

// ShowFile returns the content of path as it stood in commit hash, described
// exactly the way contents.GetContents describes a file in the working tree so
// that a client renders a historical version with the code it already has.
//
// A path that the commit does not contain is contents.ErrNotFound, which a
// caller following a commit's file list reaches by asking a deleting commit for
// what it deleted. A path that names a directory or a submodule there is
// contents.ErrInvalidPath: there is no listing to fall back on the way file.get
// has for a directory. A malformed hash or path is ErrInvalidArgument.
//
// A raster image is described without its content (contents.EncodingHTTP);
// OpenFile is what streams its bytes.
func ShowFile(dir, hash, path string) (*contents.FileContent, error) {
	spec, err := fileSpec(dir, hash, path)
	if err != nil {
		return nil, err
	}

	// The head decides before the rest is read, as file.get's does: an image's
	// bytes are not going to be sent, so they are not worth reading either.
	size, content, err := readBlobBounded(dir, spec, func(head []byte) bool {
		return contents.IsRasterImage(path, head)
	})
	if err != nil {
		return nil, fmt.Errorf("failed to read %s in commit %s: %w", path, hash, err)
	}

	return contents.NewFileContent(path, size, content), nil
}

// fileSpec names the blob path holds in commit hash, refusing it the ways
// ShowFile documents.
func fileSpec(dir, hash, path string) (string, error) {
	if err := validateCommitHash(hash); err != nil {
		return "", fmt.Errorf("%w: %w", ErrInvalidArgument, err)
	}
	if err := validatePath(path); err != nil {
		return "", fmt.Errorf("%w: %w", ErrInvalidArgument, err)
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
		return "", fmt.Errorf("%w: %s in commit %s: %w", contents.ErrNotFound, path, hash, err)
	}
	if objectType != "blob" {
		return "", fmt.Errorf("%w: %s is not a file in commit %s (git object type %s)", contents.ErrInvalidPath, path, hash, objectType)
	}
	return spec, nil
}

// Blob streams the content of one file as it stood in a commit. Close it: it
// holds a running git process.
type Blob struct {
	// Size is the whole blob's, known before any of it is read.
	Size   int64
	stdout io.ReadCloser
	cmd    *exec.Cmd
	stderr *bytes.Buffer
	args   []string
	eof    bool
}

// OpenFile streams path as it stood in commit hash, refusing it exactly as
// ShowFile does. It serves the bytes ShowFile leaves out — a raster image's,
// which travel over HTTP rather than in a JSON-RPC message, and any file the
// user downloads — so unlike ShowFile it applies no size ceiling: the content
// is copied through, never held.
//
// Cancelling ctx stops git, which is what keeps a client that went away from
// leaving a process behind.
func OpenFile(ctx context.Context, dir, hash, path string) (*Blob, error) {
	spec, err := fileSpec(dir, hash, path)
	if err != nil {
		return nil, err
	}
	size, err := blobSize(dir, spec)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s in commit %s: %w", path, hash, err)
	}

	args := []string{"cat-file", "blob", spec}
	cmd := gitCommandContext(ctx, dir, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &Blob{Size: size, stdout: stdout, cmd: cmd, stderr: &stderr, args: args}, nil
}

func (b *Blob) Read(p []byte) (int, error) {
	n, err := b.stdout.Read(p)
	if errors.Is(err, io.EOF) {
		b.eof = true
	}
	return n, err
}

// Close stops git and reports how it ended. A blob closed before it was read
// to the end reports nothing: git then dies on the closed pipe, which is the
// expected way for it to stop and says nothing about the content — the same
// reasoning as readBlob's partial read.
func (b *Blob) Close() error {
	b.stdout.Close()
	err := b.cmd.Wait()
	if err != nil && b.eof {
		return newCommandError(b.args, b.stderr.String(), err)
	}
	return nil
}

// readBlobBounded is contents.ReadBounded for the git object named by spec: the
// whole blob when it is within contents.MaxFileSize, otherwise only its first
// contents.SniffLen bytes, with size always the blob's full size. It also stops
// at the head when headOnly, which may be nil, says the head is all that is
// needed.
func readBlobBounded(dir, spec string, headOnly func(head []byte) bool) (size int64, content []byte, err error) {
	size, err = blobSize(dir, spec)
	if err != nil {
		return 0, nil, err
	}

	// A blob over the limit is never read past its head: the content is not
	// going to be sent, and the object may be gigabytes.
	oversized := size > contents.MaxFileSize
	limit := size
	if oversized {
		limit = contents.SniffLen
	}

	content, err = readBlob(dir, spec, limit, oversized, headOnly)
	if err != nil {
		return 0, nil, err
	}
	return size, content, nil
}

func blobSize(dir, spec string) (int64, error) {
	sizeOutput, err := execGit(dir, "cat-file", "-s", spec)
	if err != nil {
		return 0, err
	}
	size, err := strconv.ParseInt(sizeOutput, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("unreadable object size %q: %w", sizeOutput, err)
	}
	return size, nil
}

// readBlob reads the object named by spec, at most limit bytes of it, and only
// its first contents.SniffLen when headOnly (which may be nil) says so.
//
// partial says the object is known to be longer than limit, so git is stopped
// on a closed pipe rather than buffered in full — and its exit status then says
// nothing, since dying on that pipe is the expected end. Only a read that was
// meant to reach the object's end can hold git to exiting cleanly; stopping at
// the head is not one.
func readBlob(dir, spec string, limit int64, partial bool, headOnly func(head []byte) bool) ([]byte, error) {
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

	content, readErr := io.ReadAll(io.LimitReader(stdout, min(limit, contents.SniffLen)))
	if readErr == nil && int64(len(content)) < limit {
		if headOnly != nil && headOnly(content) {
			partial = true
		} else {
			var rest []byte
			rest, readErr = io.ReadAll(io.LimitReader(stdout, limit-int64(len(content))))
			content = append(content, rest...)
		}
	}
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
