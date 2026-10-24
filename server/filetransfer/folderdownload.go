package filetransfer

import (
	"archive/zip"
	"compress/flate"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"github.com/pockode/server/contents"
)

// MaxFolderDownloadSize caps the content of the files one folder download
// archives, and MaxFolderDownloadEntries the files, folders and links in it.
// Memory gives no reason for either: the archive streams, and what a download
// keeps per entry is gone once its directory is done. They catch a folder
// picked by mistake — the work directory of a project whose build output or
// dependencies run to gigabytes — before it streams for an hour over a phone's
// connection. They sit above a project with its dependencies installed, which
// a user downloads on purpose.
const (
	MaxFolderDownloadSize    = 2 << 30 // 2 GiB
	MaxFolderDownloadEntries = 100_000
)

// DownloadFolder streams a directory of the work directory as a zip archive,
// named after the folder — the work directory's own name for the work
// directory itself — and holding everything under one top-level folder of that
// name, so unpacking it gives back the folder rather than scattering its
// contents.
//
// What the archive leaves out, and why — all a root raw capability withholds
// and more, so that a link to a folder's archive reaches no more than a page
// could:
//   - Everything whose name starts with a dot, beneath the folder: .env and
//     its kin hold secrets; .git holds the repository token with --git
//     (.git-credentials) and objects that can be most of a project's size,
//     and a repository is cloned rather than downloaded; .pockode is
//     Pockode's own data. A folder that is itself a dot directory, asked for
//     by name, is downloaded, less the dot entries beneath it.
//   - Pockode's data directory and every other worktree, wherever settings put
//     them (withheldDirs), which may be under names with no dot: the one holds
//     session tokens, the others are checkouts of their own. Asked for by
//     name, either is downloaded, as a single file in it is.
//   - What is neither a file, a folder nor a link — a fifo, a socket, a
//     device — since it has no content to archive.
//
// A symlink — or on Windows a junction — is archived as a link, holding its
// target, and never followed: a
// link out of the folder reads nothing outside it, and a link to a folder
// inside it neither duplicates that folder nor loops. Every entry is opened
// through the folder's own directory handles, never by joined path, for the
// same reason.
//
// The folder is walked twice: once before the response starts, so that the
// limits, an unreadable file and a missing folder are answered as JSON errors
// the client can show, and once to write the archive. What changes in between
// is archived as it is at the second walk — a file removed is left out, one
// created is taken in, each file holds at most the bytes it had when opened.
// A failure once the archive has started cannot be an error response any more,
// so it aborts the connection rather than finish a well-formed archive missing
// what failed: the client sees the download fail instead of keeping a zip that
// looks complete.
//
// GET /api/files/download-folder?path=<relative dir>&worktree=<name>
//
// The app saves through a folder raw capability instead (RawScopeFolder),
// which a link can carry; both serve serveFolderArchive.
func (h *Handler) DownloadFolder(w http.ResponseWriter, r *http.Request) {
	workDir, resolveErr := h.workDir(r)
	if resolveErr != nil {
		h.writeError(w, resolveErr, nil)
		return
	}
	h.serveFolderArchive(w, r, workDir, r.URL.Query().Get("path"))
}

// serveFolderArchive streams the folder at relPath in workDir as a zip
// archive, as DownloadFolder describes.
func (h *Handler) serveFolderArchive(w http.ResponseWriter, r *http.Request, workDir, relPath string) {
	if err := contents.ValidatePath(workDir, relPath); err != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "invalid path: %s", relPath), nil)
		return
	}

	root, apiErr := h.openDir(workDir, relPath, "folder")
	if apiErr != nil {
		h.writeError(w, apiErr, nil)
		return
	}
	defer root.Close()

	// The archive's top-level folder is named too, so the rule walk applies to
	// every name beneath holds for this one: on unix a folder — or the work
	// directory — can be called "..\evil".
	name := archiveName(workDir, relPath)
	if strings.ContainsRune(name, '\\') {
		h.writeError(w, backslashName(contents.DisplayDir(relPath)), nil)
		return
	}

	walk := &folderWalk{
		h:         h,
		ctx:       r.Context(),
		folderRel: filepath.ToSlash(relPath),
		withheld:  h.withheldDirs(),
	}
	if apiErr := walk.run(root, walk.survey); apiErr != nil {
		h.writeError(w, apiErr, nil)
		return
	}

	setContentHeaders(w, name+".zip")
	if r.Method == http.MethodHead {
		// Written rather than left to net/http, which would send it on the
		// writer beneath a wrapper — /api/raw's, whose headers it would lack.
		w.WriteHeader(http.StatusOK)
		return
	}
	// Sent now rather than with the first buffer of the archive, so a browser
	// starts the download, under its name, while the first files compress.
	// Apart from a writer that cannot flush, which only delays the headers, a
	// flush fails when the client has gone, and so would every write.
	if err := http.NewResponseController(w).Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return
	}
	if h.folderSurveyed != nil {
		h.folderSurveyed()
	}

	zw := zip.NewWriter(w)
	// The fastest level: over the relay the bytes cost more than the CPU, and
	// source text shrinks to a fraction at any level, while media and archives
	// shrink at none — the default level would spend several times the CPU on
	// them for nothing.
	zw.RegisterCompressor(zip.Deflate, newPooledFlate)
	archive := &folderArchive{walk: walk, zw: zw, prefix: name + "/"}
	if top, err := root.Stat("."); err != nil {
		apiErr = h.internalFailure("stat", walk.display(""), err)
	} else {
		apiErr = archive.writeDir(top, "")
	}
	if apiErr == nil {
		apiErr = walk.run(root, archive.write)
	}
	if apiErr == nil {
		if err := zw.Close(); err != nil {
			apiErr = archive.sendFailure(err)
		}
	}
	if apiErr != nil {
		// A read failure has been logged where it happened, and one with the
		// client gone is no fault here.
		if apiErr.code != CodeInternal && r.Context().Err() == nil {
			h.log.Warn("folder download failed after the archive started", "path", walk.folderRel, "error", apiErr.message)
		}
		// Not zw.Close: that would write the central directory and turn what
		// was sent into a valid archive that silently lacks the rest.
		panic(http.ErrAbortHandler)
	}
}

// archiveName names the archive of the folder at relPath: the folder's own
// name, or the work directory's for the work directory itself.
func archiveName(workDir, relPath string) string {
	name := filepath.Base(filepath.Join(workDir, relPath))
	// A work directory at the root of a file system has no name to give.
	if name == "." || name == string(filepath.Separator) {
		return "workspace"
	}
	return name
}

// archiveEntry is one file, folder or link a folder walk meets.
type archiveEntry struct {
	// dir is the directory holding the entry, and name its name there.
	dir  *os.Root
	name string
	// rel is its path in the folder, with forward slashes.
	rel  string
	info os.FileInfo
	// link marks an entry archived as a link: a symlink, or a Windows mount
	// point (a junction), which Lstat reports as irregular rather than as one.
	link bool
}

// folderWalk is one folder download's walk of its folder, and what it has
// counted against the limits.
type folderWalk struct {
	h   *Handler
	ctx context.Context
	// folderRel is the folder's path in the work directory, which errors name
	// entries by.
	folderRel string
	withheld  withheld
	entries   int
	size      int64
}

// run walks the folder open in root, calling visit for every entry in it, and
// counts them afresh against the limits.
func (fw *folderWalk) run(root *os.Root, visit func(archiveEntry) *apiError) *apiError {
	fw.entries, fw.size = 0, 0
	return fw.walk(root, "", visit)
}

// walk visits the entries of dir, the folder's directory at rel, in name
// order, a folder before what is in it.
func (fw *folderWalk) walk(dir *os.Root, rel string, visit func(archiveEntry) *apiError) *apiError {
	list, apiErr := fw.list(dir, rel)
	if apiErr != nil {
		return apiErr
	}
	for _, name := range list {
		if err := fw.ctx.Err(); err != nil {
			return errf(http.StatusInternalServerError, CodeInternal, "download cancelled: %v", err)
		}
		if strings.HasPrefix(name, ".") {
			continue
		}
		entryRel := path.Join(rel, name)
		// Refused rather than archived: zip separates with "/" alone, but an
		// unarchiver on Windows also splits a name at "\", so "..\x" would
		// unpack outside the folder it is unpacked into. Only a unix name can
		// hold one.
		if strings.ContainsRune(name, '\\') {
			return backslashName(fw.display(entryRel))
		}
		info, err := dir.Lstat(name)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return fw.h.internalFailure("stat", fw.display(entryRel), err)
		}
		entry := archiveEntry{dir: dir, name: name, rel: entryRel, info: info}

		switch info.Mode().Type() {
		case fs.ModeDir:
			sub, apiErr := fw.openSubdir(entry)
			if apiErr != nil {
				return apiErr
			}
			if sub == nil {
				continue
			}
			apiErr = fw.count(entry, visit)
			if apiErr == nil {
				apiErr = fw.walk(sub, entryRel, visit)
			}
			sub.Close()
			if apiErr != nil {
				return apiErr
			}
		case 0:
			if apiErr := fw.count(entry, visit); apiErr != nil {
				return apiErr
			}
		case fs.ModeSymlink:
			entry.link = true
			if apiErr := fw.count(entry, visit); apiErr != nil {
				return apiErr
			}
		default:
			// A fifo, socket or device fails Readlink and is left out; a mount
			// point reads as the link it is.
			if _, err := dir.Readlink(name); err != nil {
				continue
			}
			entry.link = true
			if apiErr := fw.count(entry, visit); apiErr != nil {
				return apiErr
			}
		}
	}
	return nil
}

// list reads the names in dir, sorted so that the archive is the same for the
// same folder.
func (fw *folderWalk) list(dir *os.Root, rel string) ([]string, *apiError) {
	f, err := dir.Open(".")
	if err != nil {
		return nil, fw.h.internalFailure("open", fw.display(rel), err)
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		return nil, fw.h.internalFailure("read", fw.display(rel), err)
	}
	slices.Sort(names)
	return names, nil
}

// openSubdir opens the directory entry names, or returns nil for one the
// archive leaves out: withheld, or gone since it was listed.
//
// OpenRoot follows a link on the name, so what it opened is checked against
// what Lstat found there: had the directory been swapped for a link since, the
// walk would go on wherever the link points.
func (fw *folderWalk) openSubdir(entry archiveEntry) (*os.Root, *apiError) {
	sub, err := entry.dir.OpenRoot(entry.name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fw.h.internalFailure("open", fw.display(entry.rel), err)
	}
	opened, err := sub.Stat(".")
	if err != nil {
		sub.Close()
		return nil, fw.h.internalFailure("stat", fw.display(entry.rel), err)
	}
	if !os.SameFile(opened, entry.info) {
		sub.Close()
		return nil, fw.changed(entry.rel)
	}
	if fw.withheld.has(opened) {
		sub.Close()
		return nil, nil
	}
	return sub, nil
}

// count holds entry against the entry limit before visiting it.
func (fw *folderWalk) count(entry archiveEntry, visit func(archiveEntry) *apiError) *apiError {
	if fw.entries >= fw.h.maxFolderDownloadEntries {
		tooMany := errf(http.StatusRequestEntityTooLarge, CodeTooManyEntries,
			"%s holds more than %d files and folders, the most a folder download takes", fw.display(""), fw.h.maxFolderDownloadEntries)
		tooMany.limit = int64(fw.h.maxFolderDownloadEntries)
		return tooMany
	}
	fw.entries++
	return visit(entry)
}

// spend holds size bytes of content against the size limit.
func (fw *folderWalk) spend(size int64) *apiError {
	fw.size += size
	if fw.size > fw.h.maxFolderDownload {
		tooLarge := errf(http.StatusRequestEntityTooLarge, CodeTooLarge,
			"%s holds more than %s of files, the most a folder download takes", fw.display(""), formatSize(fw.h.maxFolderDownload))
		tooLarge.limit = fw.h.maxFolderDownload
		return tooLarge
	}
	return nil
}

// survey is the first walk's visit: it settles, before anything is sent, that
// the folder is within the limits and that every file in it can be read.
//
// An open and nothing more: no header goes out until the survey is done, and
// the relay's local proxy gives a response 30 seconds to start
// (localResponseHeaderTimeout), so it costs no more than the readability it
// settles. What the open finds there is checked when the
// archive opens the file again.
func (fw *folderWalk) survey(entry archiveEntry) *apiError {
	if !entry.info.Mode().IsRegular() {
		return nil
	}
	f, err := entry.dir.OpenFile(entry.name, os.O_RDONLY|openNonBlock, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fw.h.internalFailure("open", fw.display(entry.rel), err)
	}
	f.Close()
	return fw.spend(entry.info.Size())
}

// open opens the regular file entry names, or returns nil for one gone since
// it was listed.
//
// The name is looked at again once it is open, and has to be the regular file
// opened: a fifo swapped in after the Lstat would be opened (without blocking)
// and refused, and a link swapped in would be followed — within dir, but
// possibly into a directory the archive leaves out.
func (fw *folderWalk) open(entry archiveEntry) (*os.File, os.FileInfo, *apiError) {
	display := fw.display(entry.rel)
	f, err := entry.dir.OpenFile(entry.name, os.O_RDONLY|openNonBlock, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, fw.h.internalFailure("open", display, err)
	}
	opened, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, fw.h.internalFailure("stat", display, err)
	}
	onName, err := entry.dir.Lstat(entry.name)
	if err != nil {
		f.Close()
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil, nil
		}
		return nil, nil, fw.h.internalFailure("stat", display, err)
	}
	if !opened.Mode().IsRegular() || !os.SameFile(opened, onName) {
		f.Close()
		return nil, nil, fw.changed(entry.rel)
	}
	return f, opened, nil
}

func backslashName(display string) *apiError {
	return errf(http.StatusBadRequest, CodeInvalidPath,
		"%s has a backslash in its name, which unpacks as a path on Windows; rename it to download this folder", display)
}

func (fw *folderWalk) changed(rel string) *apiError {
	return errf(http.StatusConflict, CodeConflict, "%s changed while the download was reading it; try again", fw.display(rel))
}

// display names rel, a path in the folder, by its path in the work directory.
func (fw *folderWalk) display(rel string) string {
	return contents.DisplayDir(path.Join(fw.folderRel, rel))
}

// folderArchive is the second walk of a folder download, writing the archive.
type folderArchive struct {
	walk *folderWalk
	zw   *zip.Writer
	// prefix is the archive's top-level folder, with its trailing slash.
	prefix string
}

func (a *folderArchive) write(entry archiveEntry) *apiError {
	switch {
	case entry.link:
		return a.writeLink(entry)
	case entry.info.IsDir():
		return a.writeDir(entry.info, entry.rel)
	default:
		return a.writeFile(entry)
	}
}

// writeDir writes the entry of the folder at rel ("" for the top-level one),
// so that one with nothing in it is unpacked too.
func (a *folderArchive) writeDir(info os.FileInfo, rel string) *apiError {
	header := &zip.FileHeader{Name: a.prefix, Method: zip.Store, Modified: info.ModTime()}
	if rel != "" {
		header.Name += rel + "/"
	}
	header.SetMode(info.Mode())
	if _, err := a.zw.CreateHeader(header); err != nil {
		return a.sendFailure(err)
	}
	return nil
}

// writeLink writes a symlink as one: its target, flagged as a link, which an
// unarchiver on unix makes a link of again.
func (a *folderArchive) writeLink(entry archiveEntry) *apiError {
	target, err := entry.dir.Readlink(entry.name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return a.walk.h.internalFailure("read link", a.walk.display(entry.rel), err)
	}
	header := &zip.FileHeader{Name: a.prefix + entry.rel, Method: zip.Store, Modified: entry.info.ModTime()}
	// Not the entry's own mode, which for a mount point is a directory's.
	header.SetMode(fs.ModeSymlink | 0777)
	out, err := a.zw.CreateHeader(header)
	if err != nil {
		return a.sendFailure(err)
	}
	if _, err := io.WriteString(out, filepath.ToSlash(target)); err != nil {
		return a.sendFailure(err)
	}
	return nil
}

func (a *folderArchive) writeFile(entry archiveEntry) *apiError {
	f, info, apiErr := a.walk.open(entry)
	if apiErr != nil || f == nil {
		return apiErr
	}
	defer f.Close()
	if apiErr := a.walk.spend(info.Size()); apiErr != nil {
		return apiErr
	}

	// The mode carries the executable bit, so a script unpacks runnable.
	header := &zip.FileHeader{Name: a.prefix + entry.rel, Method: zip.Deflate, Modified: info.ModTime()}
	header.SetMode(info.Mode())
	out, err := a.zw.CreateHeader(header)
	if err != nil {
		return a.sendFailure(err)
	}
	// No more than the size it was opened at, which is what the limit counted.
	// A file that shrank since is archived as it now is: the entry's size is
	// written after its content, so a short one is no less well-formed.
	src := &readTracker{r: f}
	if _, err := io.CopyN(out, src, info.Size()); err != nil && !errors.Is(err, io.EOF) {
		// Told apart because only a file that failed to read is a fault here
		// worth logging as one; a send fails whenever the client goes away.
		if src.err != nil {
			return a.walk.h.internalFailure("read", a.walk.display(entry.rel), src.err)
		}
		return a.sendFailure(err)
	}
	return nil
}

// readTracker remembers the error its reader failed with, other than its end.
type readTracker struct {
	r   io.Reader
	err error
}

func (t *readTracker) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		t.err = err
	}
	return n, err
}

func (a *folderArchive) sendFailure(err error) *apiError {
	return errf(http.StatusInternalServerError, CodeInternal, "failed to send the archive: %v", err)
}

// flatePool holds the compressors of every folder download. One costs a large
// state to allocate and clear, and archive/zip asks for one per entry: built
// afresh each time, a folder of tens of thousands of small files spends most
// of a minute doing that alone. archive/zip pools its own default compressor
// for the same reason.
var flatePool sync.Pool

func newPooledFlate(out io.Writer) (io.WriteCloser, error) {
	if fw, ok := flatePool.Get().(*flate.Writer); ok {
		fw.Reset(out)
		return pooledFlate{fw}, nil
	}
	fw, err := flate.NewWriter(out, flate.BestSpeed)
	if err != nil {
		return nil, err
	}
	return pooledFlate{fw}, nil
}

// pooledFlate returns its compressor to flatePool once the entry is closed.
type pooledFlate struct{ *flate.Writer }

func (p pooledFlate) Close() error {
	err := p.Writer.Close()
	flatePool.Put(p.Writer)
	return err
}
