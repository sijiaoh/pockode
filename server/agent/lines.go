package agent

import (
	"bufio"
	"errors"
	"io"
)

// MaxLineBytes is the largest single line of a CLI's stdout Pockode keeps in
// memory. One JSON event per line, so this is a ceiling on one event.
//
// Where 8 MiB comes from: the lines that push on this ceiling are tool results
// — an image's base64, the text of a large Read, a command's output — and they
// arrive whole, on one line. 1 MiB proved too low in practice; 8 MiB is sized
// for a screenshot handed over as base64, a few MB of it, with room left over
// rather than sitting just above the case that failed. It is still a bound: a
// session holds one line at a time, so a runaway tool result costs this much
// and not the machine.
const MaxLineBytes = 8 * 1024 * 1024

// MaxStderrLineBytes is the same ceiling for a subprocess's stderr, and is
// deliberately far smaller.
//
// Why not MaxLineBytes: stderr never carries a payload. Its whole job is the
// CLI's own account of why it died — a message, a stack trace — and 64 KiB is
// past the end of any of those. Sizing it for base64 that cannot arrive would
// only buy a bigger buffer for a process already failing. 64 KiB is also what
// bufio.Scanner allowed here before, so nothing that used to be readable stops
// being readable; what changed is that the line after an over-long one is no
// longer lost with it.
const MaxStderrLineBytes = 64 * 1024

// lineReadBuffer is the read-ahead size underneath a LineScanner. Lines are
// assembled above it, so it bounds a single read, not a line.
const lineReadBuffer = 64 * 1024

// LineScanner reads newline-delimited lines like bufio.Scanner, with one
// difference that matters: a line too long to buffer does not end the scan.
//
// bufio.Scanner stops for good on bufio.ErrTooLong. A CLI's stdout is the only
// channel a session has, so one oversized line — a Read of an image whose
// base64 runs to megabytes — took every later event with it, including the one
// that ends the turn. Nothing was left to report the tool call's outcome or the
// turn's, and the transcript spun on a result that was never coming.
//
// An oversized line is truncated rather than dropped: its first max bytes are
// still returned by Bytes, with Truncated set and Len giving the size it
// arrived at. The head of a CLI line is where the event type and the
// tool_use_id sit, which is enough for a caller to say which call it lost.
type LineScanner struct {
	r     *bufio.Reader
	max   int
	line  []byte
	full  int
	trunc bool
	err   error
	done  bool
}

func NewLineScanner(r io.Reader, max int) *LineScanner {
	size := max
	if size > lineReadBuffer {
		size = lineReadBuffer
	}
	return &LineScanner{r: bufio.NewReaderSize(r, size), max: max}
}

// Scan advances to the next line, reporting false at EOF or on a read error.
func (s *LineScanner) Scan() bool {
	if s.done {
		return false
	}
	s.line = s.line[:0]
	s.full = 0
	s.trunc = false

	// Length of the terminator this line ended with, measured on the raw bytes
	// rather than on the buffer: an over-long line stops at the ceiling, so its
	// terminator may never be buffered at all, and a CRLF split across two
	// reads puts the CR out of reach of the chunk that carries the LF.
	terminator := 0
	var prev byte
	for {
		chunk, err := s.r.ReadSlice('\n')
		s.full += len(chunk)
		if err == nil {
			terminator = 1
			if len(chunk) >= 2 && chunk[len(chunk)-2] == '\r' {
				terminator = 2
			} else if len(chunk) == 1 && prev == '\r' {
				terminator = 2
			}
		}
		if len(chunk) > 0 {
			prev = chunk[len(chunk)-1]
		}
		if room := s.max - len(s.line); room > 0 {
			if len(chunk) > room {
				chunk = chunk[:room]
			}
			s.line = append(s.line, chunk...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			s.done = true
			if !errors.Is(err, io.EOF) {
				s.err = err
			}
			if s.full == 0 {
				return false
			}
		}
		break
	}

	// Both counts still include the terminator. Taking it off full is enough to
	// also take it off the buffer, because the buffer is a prefix of the line:
	// whatever of the terminator it holds is exactly what now sits past full.
	s.full -= terminator
	if len(s.line) > s.full {
		s.line = s.line[:s.full]
	}

	s.trunc = s.full > s.max
	return true
}

// Bytes is the line just read, at most max bytes of it. Only valid until the
// next Scan.
func (s *LineScanner) Bytes() []byte { return s.line }

// Truncated reports that the line was longer than max and Bytes holds its head
// alone.
func (s *LineScanner) Truncated() bool { return s.trunc }

// Len is the line's length as it arrived, terminator excluded — the same as
// len(Bytes()) unless the line was truncated.
func (s *LineScanner) Len() int { return s.full }

// Err is the read error that ended the scan, if it was not a clean EOF.
func (s *LineScanner) Err() error { return s.err }
