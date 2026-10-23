package filetransfer

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/iotest"
)

func TestMultipartBody(t *testing.T) {
	// One byte per read splits the closing delimiter across every read there
	// is, so a whole body still has to be recognised as whole.
	t.Run("sees a closing delimiter split across reads", func(t *testing.T) {
		req := newUploadRequest(t, "", uploadFile{name: "a.txt", content: []byte("x")})
		req.Body = io.NopCloser(iotest.OneByteReader(req.Body))

		body, err := newMultipartBody(req)
		if err != nil {
			t.Fatal(err)
		}
		part, err := body.NextPart()
		if err != nil {
			t.Fatalf("first part: %v", err)
		}
		if _, err := io.Copy(io.Discard, part); err != nil {
			t.Fatal(err)
		}
		if _, err := body.NextPart(); !errors.Is(err, io.EOF) {
			t.Errorf("got %v at the end of a whole body, want io.EOF", err)
		}
	})

	// A boundary picked by hand can be short enough to occur in a file; only
	// one at a line start closes the body.
	t.Run("does not take the delimiter inside a part for the end", func(t *testing.T) {
		raw := "--b\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\r\n\r\nx--b--x\r\n--b\r\n"
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(raw))
		req.Header.Set("Content-Type", "multipart/form-data; boundary=b")

		body, err := newMultipartBody(req)
		if err != nil {
			t.Fatal(err)
		}
		part, err := body.NextPart()
		if err != nil {
			t.Fatalf("first part: %v", err)
		}
		if _, err := io.Copy(io.Discard, part); err != nil {
			t.Fatal(err)
		}
		if _, err := body.NextPart(); !errors.Is(err, errBodyCutShort) {
			t.Errorf("got %v, want errBodyCutShort", err)
		}
	})

	// The first boundary line says which line ending a delimiter starts with,
	// as multipart.Reader reads it.
	ends := []struct {
		name string
		raw  string
		want error
	}{
		{
			name: "a bare-LF line in a CRLF body is a line of the file",
			raw:  "--b\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\r\n\r\nx\n--b--\r\n--b\r\n",
			want: errBodyCutShort,
		},
		{
			name: "a bare-LF body ends on a bare-LF delimiter",
			raw:  "--b\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\n\nx\n--b--\n",
			want: io.EOF,
		},
		{
			name: "a preamble line that only starts like the closing delimiter is preamble",
			raw:  "--b--\n--b\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\r\n\r\nx\r\n--b\r\n",
			want: errBodyCutShort,
		},
		{
			name: "a preamble comes before the first boundary line",
			raw:  "preamble\r\n--b\r\nContent-Disposition: form-data; name=\"files\"; filename=\"a.txt\"\r\n\r\nx\r\n--b--",
			want: io.EOF,
		},
	}
	for _, tc := range ends {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/", iotest.OneByteReader(strings.NewReader(tc.raw)))
			req.Header.Set("Content-Type", "multipart/form-data; boundary=b")

			body, err := newMultipartBody(req)
			if err != nil {
				t.Fatal(err)
			}
			part, err := body.NextPart()
			if err != nil {
				t.Fatalf("first part: %v", err)
			}
			if _, err := io.Copy(io.Discard, part); err != nil {
				t.Fatal(err)
			}
			if _, err := body.NextPart(); !errors.Is(err, tc.want) {
				t.Errorf("got %v, want %v", err, tc.want)
			}
		})
	}

	t.Run("a body with no parts is whole on its closing delimiter alone", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("--b--"))
		req.Header.Set("Content-Type", "multipart/form-data; boundary=b")

		body, err := newMultipartBody(req)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := body.NextPart(); !errors.Is(err, io.EOF) {
			t.Errorf("got %v, want io.EOF", err)
		}
	})
}
