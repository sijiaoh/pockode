package contents

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/pockode/server/internal/pathutil"
)

// LinkState is what following a symlink leads to. The server decides it; a
// client never works it out for itself (docs/symlinks.md#link-states).
type LinkState string

const (
	// LinkOK resolves to a regular file or a directory inside the work
	// directory.
	LinkOK LinkState = "ok"
	// LinkCycle is a directory link, in a listing, that leads back into a
	// directory the listed path already passes through. Only listings report
	// it: a path is finite, so opening one is served like LinkOK.
	LinkCycle LinkState = "cycle"
	// LinkBroken leads, inside the work directory, to nothing.
	LinkBroken LinkState = "broken"
	// LinkLoop never stops resolving (a -> b, b -> a).
	LinkLoop LinkState = "loop"
	// LinkOutside leaves the work directory at some step. Decided from where
	// resolution leads, before anything there is looked up, so it says
	// nothing about whether the target exists.
	LinkOutside LinkState = "outside"
	// LinkUnsupported resolves inside, to something that is neither a regular
	// file nor a directory (a fifo, a device).
	LinkUnsupported LinkState = "unsupported"
)

// Link describes a symlink on the entry it names.
type Link struct {
	// Target is the link's own content, verbatim: project data, not host
	// information, so it is sent even for LinkOutside.
	Target string    `json:"target"`
	State  LinkState `json:"state"`
	// Resolved is the project-relative real path, slash-separated, sent only
	// for LinkOK and LinkCycle: it never names anything outside.
	Resolved *string `json:"resolved,omitempty"`
}

// Followable reports whether a route may act on what the link points at.
func (l *Link) Followable() bool {
	return l.State == LinkOK || l.State == LinkCycle
}

// maxLinkHops bounds one resolution. The kernels' own bounds are of the same
// order (40 on Linux, 32 on macOS); the walk below never asks the kernel to
// follow anything, so it needs one of its own.
const maxLinkHops = 40

// resolver walks paths beneath one work directory with Lstat and Readlink,
// following every link itself so that it can stop the moment resolution leaves
// the work directory — nothing past the boundary is ever looked up, so whether
// something exists out there is never revealed (docs/symlinks.md#the-boundary).
//
// What it finds is a path with no link left in it. That is not trusted on its
// own — a link can be swapped in after the walk — so whoever acts on it opens
// through the work directory's os.Root and checks the opened handle with
// ResolvedName (openWithin).
type resolver struct {
	workDir string
	// spellings are the ways an absolute link target may name the work
	// directory: as it was given and with its own links resolved. macOS opens
	// /var/… as /private/var/…, and a target spelled either way is the same
	// place.
	spellings []string
}

func newResolver(workDir string) *resolver {
	r := &resolver{workDir: workDir}
	if abs, err := filepath.Abs(workDir); err == nil {
		r.spellings = append(r.spellings, abs)
	}
	if real, err := filepath.EvalSymlinks(workDir); err == nil {
		r.spellings = append(r.spellings, real)
	}
	return r
}

// walkResult is where a walk ended. real is the real path beneath the work
// directory, as components; info is what Lstat found there, set only for
// LinkOK and LinkUnsupported.
type walkResult struct {
	state LinkState
	real  []string
	info  os.FileInfo
}

// realPath is real as a native path beneath the work directory, "." for the
// work directory itself so that it can be handed to an os.Root as is.
func realPath(real []string) string {
	if len(real) == 0 {
		return "."
	}
	return filepath.Join(real...)
}

// walk resolves target starting from the real directory from, following links
// in every component including the last. hops is shared across the walks of
// one resolution so that the bound holds for the whole chain.
//
// An error is returned only for a failure to look something up (permission,
// I/O); every way a path can fail to lead somewhere usable is a state.
func (r *resolver) walk(from []string, target string, hops *int) (walkResult, error) {
	cur := append([]string(nil), from...)
	comps, ok := r.start(&cur, target)
	if !ok {
		return walkResult{state: LinkOutside}, nil
	}

	var info os.FileInfo
	for len(comps) > 0 {
		c := comps[0]
		comps = comps[1:]
		switch c {
		case "", ".":
			continue
		case "..":
			if len(cur) == 0 {
				return walkResult{state: LinkOutside}, nil
			}
			cur = cur[:len(cur)-1]
			info = nil
			continue
		}

		full := filepath.Join(r.workDir, realPath(append(cur, c)))
		fi, err := os.Lstat(full)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
				return walkResult{state: LinkBroken}, nil
			}
			return walkResult{}, err
		}

		if target, isLink := readLink(full, fi); isLink {
			if target == "" {
				return walkResult{state: LinkBroken}, nil
			}
			*hops++
			if *hops > maxLinkHops {
				return walkResult{state: LinkLoop}, nil
			}
			next, ok := r.start(&cur, target)
			if !ok {
				return walkResult{state: LinkOutside}, nil
			}
			comps = append(next, comps...)
			info = nil
			continue
		}

		if !fi.IsDir() && hasMore(comps) {
			return walkResult{state: LinkBroken}, nil
		}
		cur = append(cur, c)
		info = fi
	}

	if info == nil {
		// Ended on a directory reached by "..", a link or nothing at all:
		// stat it. Every component is real, so nothing is followed — but the
		// work directory itself may be reached through a link of the user's
		// own, which is where the project is, not a link in it.
		stat := os.Lstat
		if len(cur) == 0 {
			stat = os.Stat
		}
		fi, err := stat(filepath.Join(r.workDir, realPath(cur)))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return walkResult{state: LinkBroken}, nil
			}
			return walkResult{}, err
		}
		info = fi
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		return walkResult{state: LinkUnsupported, real: cur, info: info}, nil
	}
	return walkResult{state: LinkOK, real: cur, info: info}, nil
}

// start turns target into components to walk, resetting cur to the work
// directory for an absolute target. It reports false for an absolute target
// outside the work directory.
func (r *resolver) start(cur *[]string, target string) ([]string, bool) {
	if !pathutil.IsAnchored(target) {
		return splitPath(target), true
	}
	// Anchored without being absolute (Windows' `\etc`, `C:etc`): relative to
	// a drive or its working directory, which is no place inside.
	if !filepath.IsAbs(target) {
		return nil, false
	}
	for _, base := range r.spellings {
		if rest, ok := beneath(target, base); ok {
			*cur = (*cur)[:0]
			return rest, true
		}
	}
	return nil, false
}

// beneath returns the components of the absolute path target that follow the
// spelling base, if target starts with it. Matched component by component and
// never cleaned: a ".." in what follows has to be applied after the links
// before it are followed, as the kernel applies it, and cleaning would apply
// it to the text instead ("/w/l/../secret", l a link out, is not /w/secret).
// A ".." inside the prefix itself is not matched, which only ever errs
// towards "outside".
func beneath(target, base string) ([]string, bool) {
	if !pathutil.Equal(filepath.VolumeName(target), filepath.VolumeName(base)) {
		return nil, false
	}
	comps := splitPath(target[len(filepath.VolumeName(target)):])
	i := 0
	for _, want := range splitPath(base[len(filepath.VolumeName(base)):]) {
		for i < len(comps) && comps[i] == "." {
			i++
		}
		if i == len(comps) || !pathutil.Equal(comps[i], want) {
			return nil, false
		}
		i++
	}
	return comps[i:], true
}

// readLink reports what fi, found by Lstat at full, points at, if it is a link.
// Windows junctions are reparse points that Lstat reports as irregular rather
// than as symlinks, and they lead elsewhere all the same; Readlink reads both.
func readLink(full string, fi os.FileInfo) (string, bool) {
	if fi.Mode()&(os.ModeSymlink|os.ModeIrregular) == 0 {
		return "", false
	}
	target, err := os.Readlink(full)
	if err != nil {
		return "", fi.Mode()&os.ModeSymlink != 0
	}
	return target, true
}

func splitPath(p string) []string {
	// Only an ASCII rune can be a separator: narrowing a wider one to a byte
	// would split 港 (U+6E2F) on its low byte, '/'.
	return strings.FieldsFunc(p, func(r rune) bool {
		return r == '/' || (r < utf8.RuneSelf && os.IsPathSeparator(byte(r)))
	})
}

func hasMore(comps []string) bool {
	for _, c := range comps {
		if c != "" && c != "." {
			return true
		}
	}
	return false
}

// classify describes the link named name in the real directory dir.
// ancestors are the directories the listed path passed through and all of
// their ancestors (passedThrough), for LinkCycle; nil when the link is opened
// rather than listed.
func (r *resolver) classify(dir []string, name string, ancestors []os.FileInfo) (*Link, walkResult) {
	full := filepath.Join(r.workDir, realPath(append(append([]string(nil), dir...), name)))
	target, err := os.Readlink(full)
	link := &Link{Target: target}
	if err != nil {
		link.State = LinkBroken
		return link, walkResult{state: LinkBroken}
	}

	hops := 1
	res, err := r.walk(dir, target, &hops)
	if err != nil {
		// Something on the way could not be looked up. The link is still
		// there to list and delete; it just does not lead anywhere usable.
		res = walkResult{state: LinkBroken}
	}
	link.State = res.state
	if res.state != LinkOK {
		return link, res
	}

	resolved := filepath.ToSlash(filepath.Join(res.real...))
	link.Resolved = &resolved
	if res.info.IsDir() {
		for _, a := range ancestors {
			if os.SameFile(res.info, a) {
				link.State = LinkCycle
				break
			}
		}
	}
	return link, res
}

// passedThrough is every directory a listing whose path resolved through
// visited has passed through, together with all of their ancestors up to the
// work directory: a directory link whose target is one of these is, or
// contains, a directory on the way (docs/symlinks.md#cycles). Matched by
// identity, not by name: on a case-insensitive file system "../A" is a.
func (r *resolver) passedThrough(visited [][]string) []os.FileInfo {
	seen := map[string]bool{}
	var infos []os.FileInfo
	for _, v := range visited {
		for k := 0; k <= len(v); k++ {
			p := realPath(v[:k])
			if seen[p] {
				continue
			}
			seen[p] = true
			if info, err := os.Stat(filepath.Join(r.workDir, p)); err == nil {
				infos = append(infos, info)
			}
		}
	}
	return infos
}

// dirChain resolves rel, a path the client sent, to the real directory it
// names, returning the real directory of every prefix on the way ("" first):
// the directories a listing of rel has passed through.
//
// mkdir creates a component that is missing, for the routes that create their
// parents; it is never asked to create through a link.
func (r *resolver) dirChain(rel string, mkdir func(real string) error) ([][]string, error) {
	chain := [][]string{nil}
	cur := []string(nil)
	comps := splitPath(rel)
	for i, c := range comps {
		if c == "." {
			continue
		}
		last := !hasMore(comps[i+1:])
		hops := 0
		res, err := r.walk(cur, c, &hops)
		if err != nil {
			return nil, opFailed("failed to read "+filepath.ToSlash(rel), err)
		}
		if res.state == LinkBroken && mkdir != nil {
			next := append(append([]string(nil), cur...), c)
			// Only a name that is plainly not there is created. A link on it
			// that leads nowhere is left alone: Mkdir refuses a taken name.
			if err := mkdir(realPath(next)); err == nil {
				cur = next
				chain = append(chain, cur)
				continue
			} else if !errors.Is(err, fs.ErrExist) {
				return nil, opFailed("failed to create parent directories of "+filepath.ToSlash(rel), err)
			}
		}
		switch res.state {
		case LinkOK, LinkUnsupported:
			if !res.info.IsDir() {
				// Something other than a directory is ErrNotADirectory where
				// rel names it, and nothing to be found on the way to it.
				if !last {
					return nil, fmt.Errorf("%w: %s", ErrNotFound, filepath.ToSlash(rel))
				}
				return nil, fmt.Errorf("%w: %s", ErrNotADirectory, filepath.ToSlash(rel))
			}
		case LinkOutside:
			return nil, outsideError(rel)
		case LinkLoop:
			return nil, linkRefusal(rel, LinkLoop)
		default:
			return nil, fmt.Errorf("%w: %s", ErrNotFound, filepath.ToSlash(rel))
		}
		cur = res.real
		chain = append(chain, cur)
	}
	return chain, nil
}

// Resolution is a path the client sent, resolved beneath its work directory.
type Resolution struct {
	// Real is the native path beneath the work directory, with no link in
	// it, that the request acts on; "." for the work directory. For a final
	// link that cannot be followed it is the link itself.
	Real string
	// Info is what is at Real, the link's target when it was followed.
	Info os.FileInfo
	// Link is set when the last component is a symlink.
	Link *Link

	visited [][]string
}

// Resolve resolves rel beneath workDir the way every file route does: links
// on the way are followed only inside the work directory, and a link in the
// last component is classified rather than followed, so the caller decides
// what to do with one that is not LinkOK (Link.Followable).
//
// Returns ErrInvalidPath for a path that is not local or leads outside (with a
// message that names no host path; see PublicMessage), ErrNotFound for
// nothing at rel, and ErrNotADirectory for a file on the way.
func Resolve(workDir, rel string) (Resolution, error) {
	if err := ValidatePath(workDir, rel); err != nil {
		return Resolution{}, err
	}
	return newResolver(workDir).resolve(rel)
}

func (r *resolver) resolve(rel string) (Resolution, error) {
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." {
		chain := [][]string{nil}
		info, err := os.Stat(r.workDir)
		if err != nil {
			return Resolution{}, opFailed("failed to read the work directory", err)
		}
		return Resolution{Real: ".", Info: info, visited: chain}, nil
	}

	chain, err := r.dirChain(filepath.Dir(clean), nil)
	if err != nil {
		if errors.Is(err, ErrNotADirectory) {
			return Resolution{}, fmt.Errorf("%w: %s", ErrNotFound, rel)
		}
		return Resolution{}, retarget(err, rel)
	}
	parent := chain[len(chain)-1]
	name := filepath.Base(clean)
	own := append(append([]string(nil), parent...), name)

	info, err := os.Lstat(filepath.Join(r.workDir, realPath(own)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
			return Resolution{}, fmt.Errorf("%w: %s", ErrNotFound, rel)
		}
		return Resolution{}, opFailed("failed to read "+rel, err)
	}

	res := Resolution{Real: realPath(own), Info: info, visited: chain}
	if _, isLink := readLink(filepath.Join(r.workDir, res.Real), info); !isLink {
		res.visited = append(chain, own)
		return res, nil
	}

	link, walked := r.classify(parent, name, nil)
	res.Link = link
	if link.Followable() {
		res.Real = realPath(walked.real)
		res.Info = walked.info
		res.visited = append(chain, walked.real)
	}
	return res, nil
}

// retarget names rel, the path the client asked about, in an error dirChain
// raised about one of its parents.
func retarget(err error, rel string) error {
	switch {
	case errors.Is(err, errOutside):
		return outsideError(rel)
	case errors.Is(err, errLoop):
		return linkRefusal(rel, LinkLoop)
	case errors.Is(err, ErrNotFound):
		return fmt.Errorf("%w: %s", ErrNotFound, rel)
	}
	return err
}

// openWithin opens real, a path Resolve produced, through the work directory's
// root and checks that what was opened is still inside it: a link swapped in
// since the walk is refused rather than believed. flag is os.OpenFile's.
func openWithin(work *os.Root, rel, real string, flag int, perm os.FileMode) (*os.File, error) {
	f, err := work.OpenFile(real, flag, perm)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, rel)
		}
		return nil, opFailed("failed to open "+rel, err)
	}
	if _, err := ResolvedName(work, real, f); err != nil {
		f.Close()
		// Gone between the open and the check, rather than found outside.
		if errors.Is(err, fs.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, rel)
		}
		return nil, fmt.Errorf("%w: %w", outsideError(rel), err)
	}
	return f, nil
}

// OpenWithin opens what res names for reading, through work, checked the way
// every route here checks it.
//
// Opened without blocking, and a file checked by its opened descriptor: what
// Resolve found to be a regular file may since have been swapped for a fifo,
// whose open — and read — would otherwise hang the request.
func OpenWithin(work *os.Root, rel string, res Resolution) (*os.File, error) {
	f, err := openWithin(work, rel, res.Real, os.O_RDONLY|OpenNonBlock, 0)
	if err != nil {
		return nil, err
	}
	if err := checkOpenedKind(f, rel, res.Info.IsDir()); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// checkOpenedKind refuses f, opened at rel, unless it is still what the walk
// found there: a directory, or a regular file.
func checkOpenedKind(f *os.File, rel string, dir bool) error {
	info, err := f.Stat()
	if err != nil {
		return opFailed("failed to read "+filepath.ToSlash(rel), err)
	}
	switch {
	case !dir && !info.Mode().IsRegular():
		return notRegularError(rel)
	case dir && !info.IsDir():
		return &publicError{
			public: fmt.Sprintf("%q changed while it was opened", filepath.ToSlash(rel)),
			cause:  fmt.Errorf("%w: a directory was swapped for something else", ErrInvalidPath),
		}
	}
	return nil
}

var (
	errOutside = errors.New("leads outside the project")
	errLoop    = errors.New("is a link loop")
)

// publicError is an error whose message is split in two: Public is what a
// client may read, naming only project-relative paths, and the cause — which
// can hold host paths — is for a log.
type publicError struct {
	public string
	cause  error
}

func (e *publicError) Error() string { return e.public + ": " + e.cause.Error() }
func (e *publicError) Unwrap() error { return e.cause }

func opFailed(public string, cause error) error {
	return &publicError{public: public, cause: cause}
}

// notRegularError refuses rel for holding something a route cannot read or
// write as a file: a fifo, a device.
func notRegularError(rel string) error {
	reason := errors.New("is not a regular file")
	return &publicError{
		public: fmt.Sprintf("%q %s", filepath.ToSlash(rel), reason),
		cause:  fmt.Errorf("%w: %w", ErrInvalidPath, reason),
	}
}

func outsideError(rel string) error {
	return &publicError{
		public: fmt.Sprintf("%q %s", filepath.ToSlash(rel), errOutside),
		cause:  fmt.Errorf("%w: %w", ErrInvalidPath, errOutside),
	}
}

// LinkRefusal refuses to act through the link at rel, given what it leads to:
// ErrInvalidPath, with a message (PublicMessage) that names no host path.
func LinkRefusal(rel string, state LinkState) error {
	return linkRefusal(rel, state)
}

func linkRefusal(rel string, state LinkState) error {
	var reason error
	switch state {
	case LinkOutside:
		return outsideError(rel)
	case LinkLoop:
		reason = errLoop
	case LinkBroken:
		reason = errors.New("is a broken link")
	default:
		reason = errors.New("is a link to something that is not a file or folder")
	}
	return &publicError{
		public: fmt.Sprintf("%q %s", filepath.ToSlash(rel), reason),
		cause:  fmt.Errorf("%w: %w", ErrInvalidPath, reason),
	}
}

// PublicMessage is err as a client may read it. The routes here can fail with
// an OS error that names host paths; that one goes to the log, and the client
// gets the project-relative path and what went wrong (docs/symlinks.md#the-boundary).
func PublicMessage(err error) string {
	var pe *publicError
	if errors.As(err, &pe) {
		return pe.public
	}
	for _, known := range []error{ErrNotFound, ErrExists, ErrTooLarge, ErrNotADirectory, ErrDestinationNotFound, ErrIntoItself} {
		if errors.Is(err, known) {
			// Built here from sentinels and the client's own path.
			return err.Error()
		}
	}
	if errors.Is(err, ErrInvalidPath) {
		return "invalid path"
	}
	return "internal error"
}
