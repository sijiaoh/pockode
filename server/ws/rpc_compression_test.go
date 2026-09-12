package ws

import (
	"bufio"
	"bytes"
	"compress/flate"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
)

// browserOffer is what Chrome and Firefox put on the upgrade request. Its
// parameters are the reason these tests drive a hand-rolled client rather than
// coder/websocket's dialer, which offers a bare "permessage-deflate": a server
// that will not accept a parameter answers with no extension at all, and every
// gain here disappears with nothing else looking wrong.
const browserOffer = "permessage-deflate; client_max_window_bits"

// rawClient speaks RFC 6455 and RFC 7692 directly so tests can look at what is
// actually on the wire: the RSV1 bit, the compressed frame length, and the
// dictionary shared between messages.
type rawClient struct {
	t    *testing.T
	conn net.Conn
	br   *bufio.Reader
	resp *http.Response

	// dict carries the last 32 KiB of decompressed output, which is the
	// receiving half of context takeover.
	dict []byte
}

func dialRaw(t *testing.T, serverURL, extensions string) *rawClient {
	t.Helper()

	u, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse server url: %v", err)
	}
	conn, err := net.Dial("tcp", u.Host)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatalf("set deadline: %v", err)
	}

	var key [16]byte
	if _, err := rand.Read(key[:]); err != nil {
		t.Fatalf("read random: %v", err)
	}
	req := "GET / HTTP/1.1\r\n" +
		"Host: " + u.Host + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString(key[:]) + "\r\n"
	if extensions != "" {
		req += "Sec-WebSocket-Extensions: " + extensions + "\r\n"
	}
	req += "\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("handshake status = %d, want 101", resp.StatusCode)
	}

	return &rawClient{t: t, conn: conn, br: br, resp: resp}
}

func (c *rawClient) negotiatedExtensions() string {
	return c.resp.Header.Get("Sec-WebSocket-Extensions")
}

// send writes a masked, uncompressed text frame. RFC 7692 lets a client send
// uncompressed messages even with the extension negotiated, so these tests
// never need a client-side deflate.
func (c *rawClient) send(payload []byte) {
	c.t.Helper()

	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		c.t.Fatalf("read random: %v", err)
	}

	var hdr bytes.Buffer
	hdr.WriteByte(0x81) // FIN | text
	switch n := len(payload); {
	case n < 126:
		hdr.WriteByte(byte(0x80 | n))
	case n < 1<<16:
		hdr.WriteByte(0x80 | 126)
		binary.Write(&hdr, binary.BigEndian, uint16(n))
	default:
		hdr.WriteByte(0x80 | 127)
		binary.Write(&hdr, binary.BigEndian, uint64(n))
	}
	hdr.Write(mask[:])

	masked := make([]byte, len(payload))
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	if _, err := c.conn.Write(append(hdr.Bytes(), masked...)); err != nil {
		c.t.Fatalf("write frame: %v", err)
	}
}

type wireMessage struct {
	compressed bool
	// wireLen sums the frame payloads and excludes the frame headers, so it is
	// a lower bound on what the message cost on the link. The gates here only
	// ask whether compression happened at all, which a lower bound answers.
	wireLen int
	frames  int
	data    []byte
}

// receive reads one whole message, inflating it against the shared dictionary
// when the server marked it compressed.
func (c *rawClient) receive() wireMessage {
	c.t.Helper()

	var payload []byte
	var compressed bool
	var frames int
	for first := true; ; first = false {
		fin, rsv1, opcode, frame := c.readFrame()
		if opcode == 0x8 {
			c.t.Fatalf("server closed the connection: %q", frame)
		}
		if opcode == 0x9 || opcode == 0xA { // ping/pong carry no message data
			continue
		}
		if first {
			compressed = rsv1
		}
		payload = append(payload, frame...)
		frames++
		if fin {
			break
		}
	}

	msg := wireMessage{compressed: compressed, wireLen: len(payload), frames: frames, data: payload}
	if !compressed {
		return msg
	}

	// RFC 7692 §7.2.1 has the sender drop the trailing empty deflate block from
	// every message; put it back so the reader terminates.
	fr := flate.NewReaderDict(io.MultiReader(
		bytes.NewReader(payload),
		strings.NewReader("\x00\x00\xff\xff"),
	), c.dict)
	out, err := io.ReadAll(fr)
	if err != nil && err != io.ErrUnexpectedEOF {
		c.t.Fatalf("inflate: %v", err)
	}
	msg.data = out

	c.dict = append(c.dict, out...)
	if len(c.dict) > 32768 {
		c.dict = c.dict[len(c.dict)-32768:]
	}
	return msg
}

// receiveNotification skips anything that is not the expected notification, so
// a test that measures message sizes cannot silently measure the wrong ones.
func (c *rawClient) receiveNotification(method string) wireMessage {
	c.t.Helper()
	for {
		msg := c.receive()
		var n rpcNotification
		if err := json.Unmarshal(msg.data, &n); err != nil {
			c.t.Fatalf("unmarshal notification: %v (%q)", err, truncate(msg.data))
		}
		if n.Method == method {
			return msg
		}
	}
}

func (c *rawClient) readFrame() (fin, rsv1 bool, opcode byte, payload []byte) {
	c.t.Helper()

	var hdr [2]byte
	if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
		c.t.Fatalf("read frame header: %v", err)
	}
	fin = hdr[0]&0x80 != 0
	rsv1 = hdr[0]&0x40 != 0
	opcode = hdr[0] & 0x0F

	if hdr[1]&0x80 != 0 {
		c.t.Fatal("server must not mask frames")
	}
	length := uint64(hdr[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			c.t.Fatalf("read extended length: %v", err)
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			c.t.Fatalf("read extended length: %v", err)
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	payload = make([]byte, length)
	if _, err := io.ReadFull(c.br, payload); err != nil {
		c.t.Fatalf("read frame payload: %v", err)
	}
	return fin, rsv1, opcode, payload
}

// call sends a request and returns the matching response, skipping
// notifications that arrive first.
func (c *rawClient) call(id int, method string, params any) wireMessage {
	c.t.Helper()

	body, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		c.t.Fatalf("marshal %s: %v", method, err)
	}
	c.send(body)

	for {
		msg := c.receive()
		var resp rpcResponse
		if err := json.Unmarshal(msg.data, &resp); err != nil {
			c.t.Fatalf("unmarshal %s response: %v (%q)", method, err, truncate(msg.data))
		}
		if resp.ID != id {
			continue
		}
		if resp.Error != nil {
			c.t.Fatalf("%s failed: %s", method, resp.Error.Message)
		}
		return msg
	}
}

func truncate(b []byte) string {
	if len(b) > 120 {
		return string(b[:120]) + "..."
	}
	return string(b)
}

// compressibleFile writes a file whose contents look like the repetitive JSON
// the real workload is made of, and returns its path relative to workDir.
// Callers size it near the 48 KB a real file.get was measured at: large enough
// that the response crosses many frames, small enough not to pay for bytes that
// prove nothing.
func compressibleFile(t *testing.T, workDir string, lines int) string {
	t.Helper()

	var b strings.Builder
	for i := 0; i < lines; i++ {
		fmt.Fprintf(&b, "{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_%08d\",\"tool_result\":\"file saved\"}\n", i)
	}
	name := "sample.jsonl"
	if err := os.WriteFile(filepath.Join(workDir, name), []byte(b.String()), 0644); err != nil {
		t.Fatalf("write sample file: %v", err)
	}
	return name
}

// incompressibleFile writes size bytes of base64 over random data: the shape
// file.get gives any binary file in a worktree, and returns its path relative to
// workDir. Deflate can only shave the two wasted bits per character off it, so
// the response stays near its full size. Writing the base64 rather than the raw
// bytes is what keeps that size exactly size — file.get would otherwise expand
// the file itself and the caller could not reason about the result.
func incompressibleFile(t *testing.T, workDir string, size int) string {
	t.Helper()

	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		t.Fatalf("read random: %v", err)
	}
	name := "attachment.b64"
	content := []byte(base64.StdEncoding.EncodeToString(raw))[:size]
	if err := os.WriteFile(filepath.Join(workDir, name), content, 0644); err != nil {
		t.Fatalf("write attachment file: %v", err)
	}
	return name
}

// TestOfferVariantsAllNegotiateContextTakeover covers the parameter forms real
// clients put on the extension, since a server answers each one on its own
// terms. It is the only test here that asserts on the handshake instead of on
// bytes, because the failure described on browserOffer leaves no other trace.
func TestOfferVariantsAllNegotiateContextTakeover(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	for _, offer := range []string{
		browserOffer,
		"permessage-deflate",
		"permessage-deflate; client_max_window_bits=15",
		"permessage-deflate; server_max_window_bits=15",
	} {
		t.Run(offer, func(t *testing.T) {
			c := dialRaw(t, env.server.URL, offer)
			got := c.negotiatedExtensions()
			if !strings.Contains(got, "permessage-deflate") {
				t.Fatalf("offer %q was answered with Sec-WebSocket-Extensions = %q", offer, got)
			}
			if strings.Contains(got, "no_context_takeover") {
				t.Fatalf("offer %q was answered with %q, want context takeover", offer, got)
			}
		})
	}
}

// TestAppFlowOverACompressedConnection is the one place the bulk path is
// checked end to end. It walks the sequence the app opens with and pins three
// things, all of which need that same sequence over one connection — splitting
// them would pay for the fixture and the transfer several times over:
//
//   - deflate is applied to the largest response and not merely negotiated,
//     which a handshake assertion cannot tell apart, and the byte count is what
//     says "applied";
//   - across the flow, frame payloads land on both sides of 125 bytes, where
//     the length moves into an extended field;
//   - every response still decodes, which is what makes the frame reader
//     trustworthy as the instrument the byte gate relies on.
func TestAppFlowOverACompressedConnection(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sample := compressibleFile(t, env.getMainWorktree().WorkDir, 500)

	c := dialRaw(t, env.server.URL, browserOffer)

	var shortest, longest int
	for i, step := range []struct {
		method string
		params any
	}{
		{"auth", rpc.AuthParams{Token: "test-token"}},
		{"worktree.list", struct{}{}},
		{"session.create", nil},
		// An empty result stays under 126 bytes whatever the compression mode,
		// so the range below is a property of the flow and not of deflate.
		{"settings.unsubscribe", unsubscribeParams{ID: "none"}},
		{"file.get", rpc.FileGetParams{Path: sample}},
	} {
		msg := c.call(i+1, step.method, step.params)
		if shortest == 0 || msg.wireLen < shortest {
			shortest = msg.wireLen
		}
		if msg.wireLen > longest {
			longest = msg.wireLen
		}
		if step.method != "file.get" {
			continue
		}

		if !msg.compressed {
			t.Fatal("file.get response arrived with RSV1 clear: deflate is negotiated but not applied")
		}
		// Measured ratio is 0.033x; the gate is loose on purpose so that it
		// fails on "not compressed" rather than on compression getting a little
		// worse.
		if limit := len(msg.data) / 8; msg.wireLen >= limit {
			t.Fatalf("file.get carried %d bytes for a %d byte message, want under %d",
				msg.wireLen, len(msg.data), limit)
		}

		var resp rpcResponse
		if err := json.Unmarshal(msg.data, &resp); err != nil {
			t.Fatalf("unmarshal file.get response: %v", err)
		}
		var result rpc.FileGetResult
		if err := json.Unmarshal(resp.Result, &result); err != nil {
			t.Fatalf("unmarshal file.get result: %v", err)
		}
		if result.Type != "file" {
			t.Fatalf("file.get returned %q, want file", result.Type)
		}
	}

	if shortest >= 126 || longest < 126 {
		t.Fatalf("frame payloads ranged %d..%d bytes; the flow has to cross 125 bytes "+
			"for this to say anything about extended length fields", shortest, longest)
	}
}

// TestALargeResponseLeavesAsASingleFrame keeps every receiver's fragment limit
// out of play: a response leaves as one frame no matter how large it is. It goes
// red on a coder/websocket older than v1.8.15, which emitted a frame per deflate
// flush; what that used to cost, and why no browser was hurt by it, is in
// docs/websocket-rpc-design.md.
//
// The gate is the frame count and not a throughput number on purpose. How much
// fragmentation costs turned out to be a property of the receiver, and measured
// receivers differed by three orders of magnitude; the frame count is the part
// that is the same for all of them.
//
// Two things about the payload. It is base64 because that is what file.get makes
// of a binary file, and because that is where a fragment cap binds first — text
// compresses far enough that the same message size costs an order of magnitude
// fewer frames. It is 256 KiB, rather than reusing the cheaper compressibleFile,
// because the claim is that frame count does not track size: this compresses to
// ~197 KB, so any chunking under that shows up, where a 48 KB text sample would
// only catch chunking under ~2 KB.
func TestALargeResponseLeavesAsASingleFrame(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sample := incompressibleFile(t, env.getMainWorktree().WorkDir, 256*1024)

	c := dialRaw(t, env.server.URL, browserOffer)
	c.call(1, "auth", rpc.AuthParams{Token: "test-token"})
	msg := c.call(2, "file.get", rpc.FileGetParams{Path: sample})

	if !msg.compressed {
		t.Fatal("file.get response arrived with RSV1 clear: this says nothing about " +
			"compressed framing unless the response is actually compressed")
	}
	if msg.frames != 1 {
		t.Fatalf("a %d byte response arrived in %d frames; the frame count is tracking the "+
			"message size again, which is what caps how large a /ws response can be",
			len(msg.data), msg.frames)
	}
}

// TestStreamedNotificationsShareACompressionWindow is what pins context
// takeover in effect rather than in the handshake, and it is also the only
// place the compression threshold is pinned.
//
// Both assertions depend on the event being *small*. Streamed chat events in a
// recorded real session have a median size of 444 bytes, and the mode exists
// because messages that size only compress against the ones before them. A
// test built on a multi-kilobyte event would pass with the window unshared and
// with the threshold raised well past what real traffic looks like.
func TestStreamedNotificationsShareACompressionWindow(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	c := dialRaw(t, env.server.URL, browserOffer)
	c.call(1, "auth", rpc.AuthParams{Token: "test-token"})

	sessionID := "01a06f8e-0000-7000-8000-000000000001"
	wt := env.getMainWorktree()
	if _, err := wt.SessionStore.Create(bgCtx, sessionID, session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	c.call(2, "chat.messages.subscribe", rpc.ChatMessagesSubscribeParams{SessionID: sessionID})

	const events = 20
	event := agent.TextEvent{Content: strings.Repeat("a streamed chat event. ", 6)}
	var first, last int
	for i := 0; i < events; i++ {
		wt.ChatMessagesWatcher.OnChatMessage(process.ChatMessage{SessionID: sessionID, Event: event})
		msg := c.receiveNotification("chat.text")
		if len(msg.data) >= 444 {
			t.Fatalf("notification is %d bytes, which is at or above the median real event; "+
				"this test only says something about the threshold if it stays under it", len(msg.data))
		}
		if !msg.compressed {
			t.Fatalf("notification %d (%d bytes) arrived with RSV1 clear: events of the size that "+
				"dominate real traffic are not being compressed", i, len(msg.data))
		}
		if i == 0 {
			first = msg.wireLen
		}
		last = msg.wireLen
	}

	if last*4 >= first {
		t.Fatalf("last notification was %d bytes and the first %d: the deflate window is not shared "+
			"across messages, so the negotiated mode is not context takeover", last, first)
	}
}

// TestClientThatOffersNoCompressionIsServedUncompressed is the executable form
// of the compatibility promise: a client without the extension — Safari, a
// stripped-down proxy, a scripted client — must get a working connection rather
// than a failed handshake or frames it cannot read.
//
// It catches no mutation the other tests here miss, and that is expected: the
// negotiation it relies on lives in the library, not in the one option this
// package sets. It is kept because the promise is the first thing anyone asks
// about this change, and a promise with no executable form is the kind that
// quietly stops being true.
func TestClientThatOffersNoCompressionIsServedUncompressed(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sample := compressibleFile(t, env.getMainWorktree().WorkDir, 500)

	c := dialRaw(t, env.server.URL, "")
	if got := c.negotiatedExtensions(); got != "" {
		t.Fatalf("Sec-WebSocket-Extensions = %q, want empty", got)
	}

	c.call(1, "auth", rpc.AuthParams{Token: "test-token"})
	msg := c.call(2, "file.get", rpc.FileGetParams{Path: sample})
	if msg.compressed {
		t.Fatal("server compressed for a client that did not offer the extension")
	}
	if msg.wireLen != len(msg.data) {
		t.Fatalf("wire length %d != message length %d", msg.wireLen, len(msg.data))
	}
}
