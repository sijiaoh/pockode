package agent

import (
	"io"
	"strings"
	"testing"

	"github.com/pockode/server/filestore"
)

type scanned struct {
	line  string
	trunc bool
	full  int
}

func scanAll(t *testing.T, r io.Reader, max int) ([]scanned, error) {
	t.Helper()
	s := NewLineScanner(r, max)
	var got []scanned
	for s.Scan() {
		got = append(got, scanned{line: string(s.Bytes()), trunc: s.Truncated(), full: s.Len()})
	}
	return got, s.Err()
}

func TestLineScanner(t *testing.T) {
	tests := []struct {
		name  string
		input string
		max   int
		want  []scanned
	}{
		{
			name:  "splits on newlines",
			input: "a\nbb\nccc\n",
			max:   8,
			want:  []scanned{{"a", false, 1}, {"bb", false, 2}, {"ccc", false, 3}},
		},
		{
			name:  "returns a final line with no terminator",
			input: "a\nbb",
			max:   8,
			want:  []scanned{{"a", false, 1}, {"bb", false, 2}},
		},
		{
			name:  "strips a CRLF terminator",
			input: "a\r\n",
			max:   8,
			want:  []scanned{{"a", false, 1}},
		},
		{
			name:  "keeps a line of exactly max bytes whole",
			input: "abcd\n",
			max:   4,
			want:  []scanned{{"abcd", false, 4}},
		},
		{
			// The CR and the LF land in separate reads, so nothing sees the pair
			// at once. bufio.ScanLines never faces this: its buffer holds the
			// whole line by the time it splits.
			name:  "strips a CRLF split across two reads",
			input: strings.Repeat("x", lineReadBuffer-1) + "\r\n",
			max:   2 * lineReadBuffer,
			want: []scanned{
				{strings.Repeat("x", lineReadBuffer-1), false, lineReadBuffer - 1},
			},
		},
		{
			// The CR fits under the ceiling and the LF does not, so the line is
			// whole while the terminator is not. Len and Bytes have to agree, and
			// a stray CR must not reach a caller that parses what it is handed.
			name:  "strips a CRLF whose LF fell past the ceiling",
			input: "abc\r\n",
			max:   4,
			want:  []scanned{{"abc", false, 3}},
		},
		{
			// A line of exactly max bytes is not truncated, and the two bytes of
			// its terminator must not be counted as content that says it was.
			name:  "keeps a CRLF-terminated line of exactly max bytes whole",
			input: "abcd\r\n",
			max:   4,
			want:  []scanned{{"abcd", false, 4}},
		},
		{
			name:  "keeps reading past an oversized line",
			input: "a\n" + strings.Repeat("x", 10) + "\nb\n",
			max:   4,
			want: []scanned{
				{"a", false, 1},
				{"xxxx", true, 10},
				{"b", false, 1},
			},
		},
		{
			name:  "reports an oversized line that ends the stream",
			input: strings.Repeat("x", 10),
			max:   4,
			want:  []scanned{{"xxxx", true, 10}},
		},
		{
			name:  "survives an oversized line far past the read buffer",
			input: strings.Repeat("x", 4*lineReadBuffer) + "\ntail\n",
			max:   lineReadBuffer,
			want: []scanned{
				{strings.Repeat("x", lineReadBuffer), true, 4 * lineReadBuffer},
				{"tail", false, 4},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := scanAll(t, strings.NewReader(tt.input), tt.max)
			if err != nil {
				t.Fatalf("Err() = %v, want nil", err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %d lines, want %d: %+v", len(got), len(tt.want), got)
			}
			for i, w := range tt.want {
				if got[i].line != w.line || got[i].trunc != w.trunc || got[i].full != w.full {
					t.Errorf("line %d: got {%q trunc=%v len=%d}, want {%q trunc=%v len=%d}",
						i, got[i].line, got[i].trunc, got[i].full, w.line, w.trunc, w.full)
				}
			}
		})
	}
}

// failingReader hands out data once and then fails, which is how a broken pipe
// reaches the scanner.
type failingReader struct {
	data []byte
	err  error
}

func (r *failingReader) Read(p []byte) (int, error) {
	if len(r.data) > 0 {
		n := copy(p, r.data)
		r.data = r.data[n:]
		return n, nil
	}
	return 0, r.err
}

func TestLineScannerReportsReadError(t *testing.T) {
	want := io.ErrUnexpectedEOF
	got, err := scanAll(t, &failingReader{data: []byte("a\n"), err: want}, 8)
	if err != want {
		t.Fatalf("Err() = %v, want %v", err, want)
	}
	if len(got) != 1 || got[0].line != "a" {
		t.Errorf("lines before the error = %+v, want [a]", got)
	}
}

// ReadStderr shares the scanner, and its whole job is to explain why a CLI
// died: a stack trace printed on one long line must not cost us the lines
// after it.
func TestReadStderrSurvivesAnOverLongLine(t *testing.T) {
	stderr := strings.Repeat("x", MaxStderrLineBytes+10) + "\npanic: the real cause\n"
	got := <-ReadStderr(strings.NewReader(stderr), "test")

	if !strings.Contains(got, "panic: the real cause") {
		t.Error("the line after the over-long one was lost")
	}
	if !strings.Contains(got, "more bytes on this line") {
		t.Error("the truncation was not disclosed")
	}
}

// recordEnvelope is how much larger a history line may be than the CLI event it
// carries: the event's payload sits inside EventRecord's own JSON, which adds a
// type, ids and meta around it. A few hundred bytes in reality — the margin
// asserted below is far past that on purpose, because it costs nothing:
// filestore's ceiling is a limit and not an allocation (see jsonlReadBuffer).
const recordEnvelope = 1024 * 1024

// The two limits are written down in different packages because filestore sits
// below this one and cannot import it. They are not independent: every event
// that survives the stdout reader can be appended to history.jsonl, so a
// history reader that cannot take MaxLineBytes *plus its envelope* would write
// records it then refuses to load back — the loss surfacing much later, as
// "entries too large to load" on a session the user reopens.
//
// Equal limits are not enough, which is the part worth a test rather than a
// comment: they would leave exactly one envelope's worth of payload sizes
// writable and unreadable, and nothing in either package would say so.
func TestLineLimitsCoverHistory(t *testing.T) {
	if filestore.DefaultMaxLineBytes < MaxLineBytes+recordEnvelope {
		t.Errorf("filestore.DefaultMaxLineBytes = %d, too small to read back a %d-byte event wrapped in a record",
			filestore.DefaultMaxLineBytes, MaxLineBytes)
	}
}
