package search

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/pockode/server/contents"
)

const (
	// Files above this size are skipped: grepping them would dominate the
	// search budget and they are not viewable in the editor UI anyway.
	maxFileSize = 1 << 20 // 1 MiB

	maxLinesPerFile  = 20
	maxRangesPerLine = 20

	// contents.IsBinaryProbe sniffs at most this much, so a larger probe would
	// only buy a longer UTF-8 check on bytes the scanner is about to read anyway.
	binaryProbeBytes = 512

	// Long lines (minified bundles, embedded data) are clipped to a window
	// around the first match instead of being sent whole.
	maxLineBytes     = 500
	clipContextBytes = 64

	// Files are scanned in ordered chunks so workers run in parallel while
	// results stay in a deterministic order and the scan can stop early.
	chunkSize  = 256
	maxWorkers = 8

	// Per-worker buffer sizes. Big enough that all but pathological files reuse
	// them instead of forcing bufio to allocate and grow per file.
	readerBufBytes = 32 * 1024
	tokenBufBytes  = 64 * 1024
)

// fileScanner holds the buffers reused across every file a single worker
// scans. Allocating a fresh reader and token buffer per file dominated the
// profile through GC pressure, and a worker only reads one file at a time.
type fileScanner struct {
	reader *bufio.Reader
	buf    []byte
}

func newFileScanner() *fileScanner {
	return &fileScanner{
		reader: bufio.NewReaderSize(strings.NewReader(""), readerBufBytes),
		buf:    make([]byte, tokenBufBytes),
	}
}

// searchContents greps files for the query, preserving the order of files.
func searchContents(ctx context.Context, workDir string, files []string, m *matcher, maxResults int) ([]FileMatch, bool) {
	matches := make([]FileMatch, 0, min(len(files), maxResults))
	truncated := false

	// Allocated once for the whole search, not per chunk: these buffers are the
	// point of fileScanner, so rebuilding them each chunk would defeat it.
	scanners := make([]*fileScanner, min(runtime.NumCPU(), maxWorkers, len(files)))
	for i := range scanners {
		scanners[i] = newFileScanner()
	}

	for start := 0; start < len(files); start += chunkSize {
		if ctx.Err() != nil {
			return matches, true
		}

		chunk := files[start:min(start+chunkSize, len(files))]
		found, more := scanChunk(ctx, workDir, chunk, m, scanners)
		if more {
			truncated = true
		}

		for _, fm := range found {
			if fm == nil {
				continue
			}
			if len(matches) >= maxResults {
				return matches, true
			}
			matches = append(matches, *fm)
		}
	}

	// Checked after the loop too: a timeout during the last chunk skips files
	// without ever re-entering the loop, and must not look like a full scan.
	if ctx.Err() != nil {
		return matches, true
	}
	return matches, truncated
}

// scanChunk scans a chunk concurrently and returns results positioned by index,
// with nil for files that did not match. The bool reports that some file had
// more matching lines than were kept.
// Each worker owns scanners[w] for the duration of the chunk, so the buffers
// need no synchronization.
func scanChunk(ctx context.Context, workDir string, chunk []string, m *matcher, scanners []*fileScanner) ([]*FileMatch, bool) {
	results := make([]*FileMatch, len(chunk))
	var more atomic.Bool

	// Work is split by stride rather than handed out per file: one goroutine per
	// file, gated by a semaphore, spends most of its time parking and waking
	// because scanning a single small file is far cheaper than scheduling it.
	workers := min(len(scanners), len(chunk))
	var wg sync.WaitGroup
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fs := scanners[w]
			for i := w; i < len(chunk); i += workers {
				if ctx.Err() != nil {
					return
				}
				relPath := chunk[i]
				match, hasMore := fs.scanFile(filepath.Join(workDir, filepath.FromSlash(relPath)), relPath, m)
				results[i] = match
				if hasMore {
					more.Store(true)
				}
			}
		}()
	}
	wg.Wait()

	return results, more.Load()
}

// scanFile returns the matching lines of one file, or nil when the file does
// not match or is not searchable (unreadable, too large, binary).
func (fs *fileScanner) scanFile(fullPath, relPath string, m *matcher) (*FileMatch, bool) {
	// Lstat rather than Stat: a symlink must not be followed, or a link listed
	// by git could leak content from outside the work directory.
	info, err := os.Lstat(fullPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxFileSize {
		return nil, false
	}

	f, err := os.Open(fullPath)
	if err != nil {
		return nil, false
	}
	defer f.Close()

	fs.reader.Reset(f)
	// Peek returns io.EOF for files shorter than the probe; that is not a failure.
	head, err := fs.reader.Peek(binaryProbeBytes)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, false
	}
	if contents.IsBinaryProbe(head) {
		return nil, false
	}

	scanner := bufio.NewScanner(fs.reader)
	// The ceiling is above maxFileSize so a single-line file can never overflow
	// the token limit; bufio only allocates beyond fs.buf for such lines.
	scanner.Buffer(fs.buf, maxFileSize+1)

	var lines []Line
	more := false
	for number := 1; scanner.Scan(); number++ {
		// Bytes, not Text: the token aliases the scanner buffer, so no string is
		// allocated for the overwhelming majority of lines that never match.
		// clipLine copies the window it keeps.
		line := scanner.Bytes()
		ranges := m.find(line, maxRangesPerLine)
		if len(ranges) == 0 {
			continue
		}
		if len(lines) >= maxLinesPerFile {
			more = true
			break
		}

		clippedText, clippedRanges := clipLine(line, ranges)
		lines = append(lines, Line{Number: number, Text: clippedText, Ranges: clippedRanges})
	}

	if len(lines) == 0 {
		return nil, false
	}
	return &FileMatch{Path: relPath, Name: path.Base(relPath), Lines: lines}, more
}

// clipLine extracts a window around the first match when the line is too long,
// dropping ranges outside the window and rebasing the rest onto the window.
// Window edges are snapped to UTF-8 rune boundaries so the text stays valid.
//
// The returned string is a copy, so it stays valid after the caller's scanner
// buffer is overwritten by the next line.
func clipLine(line []byte, ranges []Range) (string, []Range) {
	if len(line) <= maxLineBytes {
		return string(line), ranges
	}

	start := max(ranges[0].Start-clipContextBytes, 0)
	for start < len(line) && !utf8.RuneStart(line[start]) {
		start++
	}
	end := start + maxLineBytes
	if end >= len(line) {
		end = len(line)
	} else {
		for end > start && !utf8.RuneStart(line[end]) {
			end--
		}
	}

	clipped := make([]Range, 0, len(ranges))
	for _, r := range ranges {
		if r.Start < start || r.End > end {
			continue
		}
		clipped = append(clipped, Range{Start: r.Start - start, End: r.End - start})
	}
	return string(line[start:end]), clipped
}
