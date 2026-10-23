package filetransfer

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
)

// errBodyCutShort is a multipart body that ended without its closing
// delimiter. multipart.Reader reports that as the ordinary end of the body
// whenever the cut falls just after a part's boundary rather than inside a
// part, which would answer 200 for a request whose later files never came.
var errBodyCutShort = errors.New("the body ended before its closing boundary; the upload was cut short")

// multipartBody is a multipart.Reader whose NextPart tells a body that was
// cut short from one that ended.
type multipartBody struct {
	*multipart.Reader
	watch *closingWatch
}

// newMultipartBody reads r's body as multipart/form-data. It takes r.Body as
// it is now, so a caller that bounds the body wraps it first.
func newMultipartBody(r *http.Request) (*multipartBody, error) {
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" {
		return nil, http.ErrNotMultipart
	}
	boundary := params["boundary"]
	if boundary == "" {
		return nil, http.ErrMissingBoundary
	}
	watch := &closingWatch{
		r:                r.Body,
		dashBoundary:     []byte("--" + boundary),
		dashBoundaryDash: []byte("--" + boundary + "--"),
	}
	return &multipartBody{Reader: multipart.NewReader(watch, boundary), watch: watch}, nil
}

// NextPart is multipart.Reader's, except that the end of a body that never
// carried the closing delimiter is errBodyCutShort rather than io.EOF.
func (b *multipartBody) NextPart() (*multipart.Part, error) {
	part, err := b.Reader.NextPart()
	if errors.Is(err, io.EOF) && !b.watch.seen {
		return nil, errBodyCutShort
	}
	return part, err
}

// closingWatch passes a body through, noting whether the closing delimiter
// went past. A delimiter cannot occur inside a part — that is what makes it a
// delimiter — so having seen one means the body was whole.
//
// What counts as one is multipart.Reader's rule: the line ending of the first
// boundary line, CRLF or a bare LF, is the one every later delimiter starts
// with. Matching a bare LF in a CRLF body would take a line of a file for the
// end, which a short boundary picked by hand can spell.
//
// A part whose headers end in bare LFs in a CRLF body, with nothing after
// them, is closed by "--boundary--" directly; that is not watched for, so such
// a hand-made body is refused as cut short rather than risk taking a line of a
// file for the end.
type closingWatch struct {
	r                io.Reader
	dashBoundary     []byte
	dashBoundaryDash []byte
	// head holds the body until its first boundary line has ended, which is
	// what says which line ending the delimiters use; at most maxHead bytes.
	head []byte
	// lines is how much of head decide has already read line by line.
	lines int
	// closing is the delimiter to look for, nil until it is known.
	closing []byte
	// tail is the end of what has been scanned, one byte short of closing, so
	// a delimiter split across two reads is still found.
	tail []byte
	seen bool
}

// maxHead bounds the preamble closingWatch holds while it waits for the first
// boundary line. Browsers send none; a body with more than this before its
// first boundary is taken to use CRLF, the line ending RFC 2046 specifies.
const maxHead = 64 << 10

func (w *closingWatch) Read(p []byte) (int, error) {
	n, err := w.r.Read(p)
	if w.seen {
		return n, err
	}
	if w.closing != nil {
		if n > 0 {
			w.scan(p[:n])
		}
		return n, err
	}
	w.head = append(w.head, p[:n]...)
	w.decide(errors.Is(err, io.EOF))
	return n, err
}

// decide looks for the first boundary line in head, the way multipart.Reader
// reads the preamble: line by line, the first "--boundary" line ending the
// preamble — or the closing delimiter, for a body with no parts. Any other
// line, one merely starting with "--boundary--" included, is preamble. ended
// says the body has nothing after head.
func (w *closingWatch) decide(ended bool) {
	for {
		rest := w.head[w.lines:]
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			// The closing delimiter may end the body with no line ending.
			if ended && bytes.HasPrefix(rest, w.dashBoundaryDash) &&
				len(bytes.TrimLeft(rest[len(w.dashBoundaryDash):], " \t")) == 0 {
				w.seen = true
			}
			break
		}
		line := rest[:i+1]
		w.lines += i + 1
		if bytes.HasPrefix(line, w.dashBoundaryDash) {
			// Before the first part, a delimiter line ends in CRLF.
			if string(bytes.TrimLeft(line[len(w.dashBoundaryDash):], " \t")) == "\r\n" {
				w.seen = true
				return
			}
			continue
		}
		if !bytes.HasPrefix(line, w.dashBoundary) {
			continue
		}
		after := line[len(w.dashBoundary):]
		switch string(bytes.TrimLeft(after, " \t")) {
		case "\n":
			w.start([]byte("\n"))
			return
		case "\r\n":
			w.start([]byte("\r\n"))
			return
		}
	}
	if len(w.head) > maxHead {
		w.start([]byte("\r\n"))
	}
}

func (w *closingWatch) start(newline []byte) {
	w.closing = append(append([]byte(nil), newline...), w.dashBoundaryDash...)
	head := w.head
	w.head = nil
	w.scan(head)
}

func (w *closingWatch) scan(chunk []byte) {
	keep := len(w.closing) - 1
	// Only the seam is copied: a delimiter is either across it or in chunk.
	seam := append(append([]byte(nil), w.tail...), chunk[:min(len(chunk), keep)]...)
	if bytes.Contains(seam, w.closing) || bytes.Contains(chunk, w.closing) {
		w.seen = true
		return
	}
	joined := append(w.tail, chunk[max(0, len(chunk)-keep):]...)
	w.tail = append([]byte(nil), joined[max(0, len(joined)-keep):]...)
}
