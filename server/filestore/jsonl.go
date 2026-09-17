package filestore

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// DefaultMaxLineBytes bounds a single JSONL line while reading.
//
// Where: it covers agent.MaxLineBytes (8 MiB), the ceiling on one CLI event and
// therefore on the payload of one record we ever append — a reader smaller than
// the writer would append history it then refuses to load back, and the loss
// would surface much later, as "entries too large to load" on a session the
// user reopens. Not equal to it but a megabyte past it: the record is the event
// wrapped in EventRecord's own JSON, so it is the larger of the two by an
// envelope, and two equal ceilings would leave exactly that envelope of
// payloads writable and unreadable. Not imported from there either — this
// package sits under the agent layer, not beside it — so
// agent.TestLineLimitsCoverHistory holds the two together instead.
//
// The margin is free because this is a limit and not an allocation: ReadJSONL
// assembles a line above a small read buffer (jsonlReadBuffer) rather than
// buffering the whole ceiling.
const DefaultMaxLineBytes = 9 * 1024 * 1024

// jsonlReadBuffer is the read-ahead under ReadJSONL. Lines are assembled above
// it, so it bounds one read rather than one line.
//
// Why not size the buffer to the ceiling, which is the obvious thing: the
// ceiling is what one record may reach, not what one is, and a history of
// few-kilobyte records is the normal case. Buffering the ceiling made reading
// one cost the whole of it — measured at 20ms and 8.4 MB for an 8 KiB file,
// against 1ms and 91 KB here — on a path the user waits on, since GetHistory
// runs when a session is opened and again for every page scrolled back.
//
// Sizing the buffer to the *file* is the other obvious saving and is wrong:
// GetHistory reads without a lock while a turn appends, so a record written
// after the size was taken would be counted oversized and reported to the user,
// in the chat, as history too large to load.
const jsonlReadBuffer = 64 * 1024

// JSONLStats reports records ReadJSONL could not return, so callers can
// surface the loss instead of silently dropping history.
type JSONLStats struct {
	// Corrupted counts lines that were not valid JSON — typically the partial
	// tail left behind when a crash interrupts an append.
	Corrupted int
	// Oversized counts lines longer than maxLineBytes. They are skipped so the
	// remaining records still load.
	Oversized int
}

func (s JSONLStats) Damaged() bool {
	return s.Corrupted > 0 || s.Oversized > 0
}

// AppendJSONL appends record to path as a single JSON line, creating the file
// and its parent directory as needed.
//
// Crash behaviour: the record goes out in one write syscall, so a killed
// process can never split it, and any damage a power loss leaves is confined to
// the trailing line — the next append terminates it with a newline instead of
// gluing a fresh record onto it, and ReadJSONL skips it rather than failing the
// whole file.
//
// Why no fsync: this is the streaming path (one call per agent event) and an
// fsync costs a full disk round-trip — up to ~150ms on a slow disk, which would
// stall every message on its way to the UI. Records already handed to the
// kernel survive a kill -9; only a power loss can drop the not-yet-flushed
// tail, which the reader degrades over. Files that must not lose their last
// update (index files) use WriteFileAtomic instead.
func AppendJSONL(path string, record any) error {
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal record: %w", err)
	}
	data = append(data, '\n')

	if err := os.MkdirAll(filepath.Dir(path), dirPerm); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}

	// O_RDWR (not O_WRONLY) so the trailing byte can be inspected below.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_RDWR, filePerm)
	if err != nil {
		return fmt.Errorf("open jsonl file: %w", err)
	}

	if err := appendLine(f, data); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close jsonl file: %w", err)
	}
	return nil
}

func appendLine(f *os.File, data []byte) error {
	unterminated, err := endsWithoutNewline(f)
	if err != nil {
		return err
	}
	if unterminated {
		// A previous append was cut short. Without this separator the new
		// record would be glued onto the broken line and lost as well.
		data = append([]byte{'\n'}, data...)
	}

	// One Write call: under O_APPEND the offset reservation is atomic, so
	// concurrent appenders never interleave a record.
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("append record: %w", err)
	}
	return nil
}

func endsWithoutNewline(f *os.File) (bool, error) {
	info, err := f.Stat()
	if err != nil {
		return false, fmt.Errorf("stat jsonl file: %w", err)
	}
	if info.Size() == 0 {
		return false, nil
	}

	var last [1]byte
	if _, err := f.ReadAt(last[:], info.Size()-1); err != nil {
		return false, fmt.Errorf("read last byte: %w", err)
	}
	return last[0] != '\n', nil
}

// ReadJSONL reads every well-formed JSON line from path, skipping lines a crash
// or an oversized write made unreadable and reporting them in JSONLStats.
// Returns an empty slice when the file does not exist. Pass 0 for maxLineBytes
// to use DefaultMaxLineBytes.
func ReadJSONL(path string, maxLineBytes int) ([]json.RawMessage, JSONLStats, error) {
	if maxLineBytes <= 0 {
		maxLineBytes = DefaultMaxLineBytes
	}

	var stats JSONLStats

	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return []json.RawMessage{}, stats, nil
	}
	if err != nil {
		return nil, stats, err
	}
	defer f.Close()

	records := []json.RawMessage{}
	reader := bufio.NewReaderSize(f, jsonlReadBuffer)

	// What has been read of the current line, while it is arriving in more than
	// one piece. Empty whenever the last read finished a line.
	var pending []byte

	for {
		chunk, err := reader.ReadSlice('\n')

		if errors.Is(err, bufio.ErrBufferFull) {
			if len(pending)+len(chunk) <= maxLineBytes {
				pending = append(pending, chunk...)
				continue
			}
			// Past the ceiling. Stop assembling and walk to the end of the line,
			// so the next record is read as a record and not as this one's tail.
			stats.Oversized++
			pending = pending[:0]
			err = discardLine(reader)
			if err != nil && !errors.Is(err, io.EOF) {
				return records, stats, err
			}
			if errors.Is(err, io.EOF) {
				break
			}
			continue
		}
		if err != nil && !errors.Is(err, io.EOF) {
			return records, stats, err
		}

		line := chunk
		if len(pending) > 0 {
			pending = append(pending, chunk...)
			line = pending
		}

		// The last chunk can still carry the line past the ceiling: only what
		// was assembled before it was checked against one.
		if len(line) > maxLineBytes {
			stats.Oversized++
		} else {
			line = bytes.TrimRight(line, "\r\n")
			if len(line) > 0 {
				if json.Valid(line) {
					record := make(json.RawMessage, len(line))
					copy(record, line)
					records = append(records, record)
				} else {
					stats.Corrupted++
				}
			}
		}
		pending = pending[:0]

		if errors.Is(err, io.EOF) {
			break
		}
	}

	return records, stats, nil
}

func discardLine(r *bufio.Reader) error {
	for {
		if _, err := r.ReadSlice('\n'); !errors.Is(err, bufio.ErrBufferFull) {
			return err
		}
	}
}
