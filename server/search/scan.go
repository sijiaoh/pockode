package search

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/fuzzy"
)

const (
	// Files above this size are skipped: grepping them would dominate the
	// search budget and they are not viewable in the editor UI anyway.
	maxFileSize = 1 << 20 // 1 MiB

	maxLinesPerFile = 20

	// contents.IsBinaryProbe sniffs at most this much.
	binaryProbeBytes = 512

	// Long lines (minified bundles, embedded data) are clipped to a window
	// around the first match instead of being sent whole.
	maxLineBytes     = 500
	clipContextBytes = 64

	// Files are scanned in ordered chunks so workers run in parallel while
	// results keep the listing's order for ranking ties, and the scan can stop
	// between chunks.
	chunkSize  = 256
	maxWorkers = 8
)

// fileScanner holds what a single worker reuses across every file it scans.
// Allocating a fresh buffer per file dominated the profile through GC
// pressure, and a worker only reads one file at a time.
//
// chars lives here too, rather than in a local, for the same reason: it is
// passed to the matchers through function values, so a local escapes to the
// heap once for every line.
type fileScanner struct {
	buf   []byte
	runes []rune
	chars fuzzy.Chars
	slab  *fuzzy.Slab
}

func newFileScanner() *fileScanner {
	return &fileScanner{slab: fuzzy.NewSlab()}
}

// contentMatch is a matching file with the score it ranks by: that of its
// best line.
type contentMatch struct {
	FileMatch
	score int
}

// searchContents matches the pattern against every line of files and returns
// the maxResults files with the best-scoring lines. Ties keep the listing's
// order. Ranking needs every file's score, so unlike a plain grep the scan
// cannot stop at the first maxResults matches; a timeout ranks what was
// scanned so far.
func searchContents(ctx context.Context, workDir string, files []string, pattern *fuzzy.Pattern, maxResults int) ([]FileMatch, bool) {
	var ranked []contentMatch
	truncated := false

	// Ties keep the listing's order, which is the order files are appended in,
	// so a stable sort is the whole tiebreak.
	rank := func() {
		slices.SortStableFunc(ranked, func(a, b contentMatch) int { return cmp.Compare(b.score, a.score) })
		if len(ranked) > maxResults {
			ranked = ranked[:maxResults]
			truncated = true
		}
	}

	// Allocated once for the whole search, not per chunk: these buffers are the
	// point of fileScanner, so rebuilding them each chunk would defeat it.
	scanners := make([]*fileScanner, min(runtime.NumCPU(), maxWorkers, len(files)))
	for i := range scanners {
		scanners[i] = newFileScanner()
	}

	for start := 0; start < len(files); start += chunkSize {
		if ctx.Err() != nil {
			truncated = true
			break
		}
		// A query of no terms matches every line with score 0, so no later
		// file can outrank the ones already found.
		if pattern.IsEmpty() && len(ranked) >= maxResults {
			truncated = true
			break
		}

		chunk := files[start:min(start+chunkSize, len(files))]
		found, more := scanChunk(ctx, workDir, chunk, pattern, scanners)
		if more {
			truncated = true
		}
		for _, cm := range found {
			if cm != nil {
				ranked = append(ranked, *cm)
			}
		}
		// Trimmed as the scan goes, so a query that matches nearly every file
		// does not hold every file's lines until the end.
		if len(ranked) >= 2*maxResults {
			rank()
		}
	}
	rank()

	// Checked after the loop too: a timeout during the last chunk skips files
	// without ever re-entering the loop, and must not look like a full scan.
	if ctx.Err() != nil {
		truncated = true
	}

	matches := make([]FileMatch, len(ranked))
	for i, cm := range ranked {
		matches[i] = cm.FileMatch
	}
	return matches, truncated
}

// scanChunk scans a chunk concurrently and returns results positioned by index,
// with nil for files that did not match. The bool reports that some file had
// more matching lines than were kept.
// Each worker owns scanners[w] for the duration of the chunk, so the buffers
// need no synchronization.
func scanChunk(ctx context.Context, workDir string, chunk []string, pattern *fuzzy.Pattern, scanners []*fileScanner) ([]*contentMatch, bool) {
	results := make([]*contentMatch, len(chunk))
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
				match, hasMore := fs.scanFile(filepath.Join(workDir, filepath.FromSlash(relPath)), relPath, pattern)
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

// lineHit is a matching line, located in the file buffer it was found in.
type lineHit struct {
	number     int
	score      int
	start, end int
}

// scanFile returns the matching lines of one file, or nil when the file does
// not match or is not searchable (unreadable, too large, binary). The bool
// reports that more lines matched than were kept.
//
// Matching is layered as fzf layers it, so that the costly scoring only runs
// where it is needed: a byte search over the whole file for the query's
// characters, then per line the linear FuzzyMatchV1 to decide whether it
// matches, and FuzzyMatchV2's score only for the lines that do. The positions
// are computed last, only for the lines that are kept.
func (fs *fileScanner) scanFile(fullPath, relPath string, pattern *fuzzy.Pattern) (*contentMatch, bool) {
	data, ok := fs.readFile(fullPath)
	if !ok || !pattern.MayMatchWithin(data) {
		return nil, false
	}

	// kept holds the best maxLinesPerFile lines, so the lines shown are the
	// ones that earned the file its rank rather than the first ones to match.
	var kept []lineHit
	more := false
	best := 0
	for number, start := 1, 0; start < len(data); number++ {
		end := len(data)
		next := len(data)
		if i := bytes.IndexByte(data[start:], '\n'); i >= 0 {
			end = start + i
			next = end + 1
		}
		// Lines split as bufio.ScanLines splits them: a trailing "\r" is part
		// of the line break.
		lineEnd := end
		if lineEnd > start && data[lineEnd-1] == '\r' {
			lineEnd--
		}
		lineStart := start
		start = next

		fs.chars, fs.runes = fuzzy.ToCharsBuffer(data[lineStart:lineEnd], fs.runes)
		if !pattern.Matches(fuzzy.DefaultScheme, &fs.chars, fs.slab) {
			continue
		}
		score, _, _ := pattern.Match(fuzzy.DefaultScheme, &fs.chars, false, fs.slab)
		hit := lineHit{number: number, score: score, start: lineStart, end: lineEnd}

		if len(kept) == 0 || score > best {
			best = score
		}
		if len(kept) < maxLinesPerFile {
			kept = append(kept, hit)
			continue
		}
		more = true
		// Every kept line comes earlier than this one, so it wins ties and
		// only a strictly better score displaces the worst of them.
		worst := 0
		for i := range kept {
			if kept[i].score < kept[worst].score ||
				kept[i].score == kept[worst].score && kept[i].number > kept[worst].number {
				worst = i
			}
		}
		if score > kept[worst].score {
			kept = append(kept[:worst], kept[worst+1:]...)
			kept = append(kept, hit)
		}
	}

	if len(kept) == 0 {
		return nil, false
	}

	byScore := make([]int, len(kept))
	for i := range byScore {
		byScore[i] = i
	}
	// kept is in line order, so a stable sort lets the earlier line win ties.
	slices.SortStableFunc(byScore, func(a, b int) int { return cmp.Compare(kept[b].score, kept[a].score) })

	lines := make([]Line, len(kept))
	for rank, i := range byScore {
		lines[i].Rank = rank
	}
	for i, hit := range kept {
		raw := data[hit.start:hit.end]
		fs.chars, fs.runes = fuzzy.ToCharsBuffer(raw, fs.runes)
		_, positions, _ := pattern.Match(fuzzy.DefaultScheme, &fs.chars, true, fs.slab)
		text, ranges := toClientText(clipLine(raw, positionsToByteRanges(raw, positions)))
		lines[i].Number, lines[i].Text, lines[i].Ranges = hit.number, text, ranges
	}

	return &contentMatch{
		FileMatch: FileMatch{Path: relPath, Name: path.Base(relPath), Lines: lines},
		score:     best,
	}, more
}

// readFile reads a whole regular file into fs.buf, reporting false for a file
// that cannot be read, is over maxFileSize or is binary. The result is valid
// until the next call.
func (fs *fileScanner) readFile(fullPath string) ([]byte, bool) {
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

	// One byte past the stat size, so a file that grew since is still read to
	// its end, and past maxFileSize so one that grew too much is noticed.
	if want := max(int(info.Size())+1, binaryProbeBytes); cap(fs.buf) < want {
		fs.buf = make([]byte, 0, want)
	}

	// The probe is read on its own first, so that a binary file — an image, an
	// archive — costs one small read rather than all of its bytes.
	buf := fs.buf[:binaryProbeBytes]
	n, err := io.ReadFull(f, buf)
	buf = buf[:n]
	fs.buf = buf
	if contents.IsBinaryProbe(buf) {
		return nil, false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return buf, true
	}
	if err != nil {
		return nil, false
	}

	for {
		if len(buf) == cap(buf) {
			buf = append(buf, 0)[:len(buf)]
		}
		n, err := f.Read(buf[len(buf):cap(buf)])
		buf = buf[:len(buf)+n]
		if len(buf) > maxFileSize {
			fs.buf = buf
			return nil, false
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fs.buf = buf
			return nil, false
		}
	}
	fs.buf = buf
	return buf, true
}

// clipLine extracts a window around the first match when the line is too long,
// dropping ranges outside the window and rebasing the rest onto the window. A
// line matched without any ranges (a query of only exclusions) keeps its start.
// Window edges are snapped to UTF-8 rune boundaries so no valid character is
// cut, and the window is taken from the raw bytes before toClientText
// substitutes invalid ones: both the limits and the ranges here are bytes.
//
// The returned string is a copy of only the window: line aliases the file
// buffer, which the next file overwrites, and copying a whole long line just to
// keep a window of it would dominate the allocations of a scan.
func clipLine(line []byte, ranges []Range) (string, []Range) {
	if len(line) <= maxLineBytes {
		return string(line), ranges
	}

	start := 0
	if len(ranges) > 0 {
		start = max(ranges[0].Start-clipContextBytes, 0)
	}
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
