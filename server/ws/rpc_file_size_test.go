package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// Two ceilings govern file.write, and these tests hold the order between them
// as well as the fact that both are still installed: the method's own
// (contents.MaxFileSize) has to be the one a client meets, and the
// connection's (maxClientMessage) has to stay above it and out of the way.
// They were the wrong way round for a long time — nothing raised
// coder/websocket's 32 KiB default — and an inverted transport limit does not
// produce a bad response, it produces no response: the library closed the
// connection out from under the handler.

// The write is at the method's ceiling exactly, in the encoding that costs the
// most on the wire: U+0001 escapes to six bytes, so 2 MiB of it leaves as a
// ~12 MiB message. That is deliberately the hardest accepted write there is,
// which makes this a test of maxClientMessage's relationship to MaxFileSize
// rather than of its value — lower the backstop far enough and an acceptable
// write goes back to being a disconnect.
func TestFileWrite_AcceptsTheCeilingEvenWhenEveryByteEscapes(t *testing.T) {
	workDir := t.TempDir()
	env := newTestEnvWithWorkDir(t, &mockAgent{}, workDir)

	content := strings.Repeat("\x01", contents.MaxFileSize)

	resp := env.call("file.write", rpc.FileWriteParams{Path: "escaped.txt", Content: content})
	if resp.Error != nil {
		t.Fatalf("file.write failed: %v", resp.Error)
	}

	written, err := os.ReadFile(filepath.Join(workDir, "escaped.txt"))
	if err != nil {
		t.Fatalf("failed to read written file: %v", err)
	}
	if string(written) != content {
		t.Errorf("wrote %d bytes, want %d identical ones", len(written), len(content))
	}
}

func TestFileWrite_OverTheCeilingRepliesAndKeepsTheConnection(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("file.write", rpc.FileWriteParams{
		Path:    "toobig.txt",
		Content: strings.Repeat("a", contents.MaxFileSize+1),
	})
	if resp.Error == nil {
		t.Fatal("expected an error for content over MaxFileSize")
	}
	// Named so the test cannot be satisfied by an unrelated write failure.
	if resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, "too large") {
		t.Errorf("got code %d %q, want CodeInvalidParams naming the size", resp.Error.Code, resp.Error.Message)
	}

	// env.call fails the test outright if the read fails, so a second exchange
	// over the same connection is what says the refusal was a reply and not a
	// close.
	if resp := env.call("file.get", rpc.FileGetParams{Path: ""}); resp.Error != nil {
		t.Fatalf("connection unusable after a refused write: %v", resp.Error)
	}
}

// The other side of the bracket. AcceptsTheCeilingEvenWhenEveryByteEscapes
// only says the backstop is high enough to stay out of the method's way, which
// SetReadLimit(-1) would satisfy just as well; this one says it is there at
// all. Nothing else notices if it stops being installed, because removing a
// ceiling breaks nothing until a peer decides to spend the memory.
func TestClientMessage_PastTheBackstopClosesTheConnection(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	req := rpcRequest{JSONRPC: "2.0", ID: env.nextID(), Method: "file.write",
		Params: rpc.FileWriteParams{Path: "x.txt", Content: strings.Repeat("a", maxClientMessage+1)}}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("failed to marshal request: %v", err)
	}

	// A write that big can fail on its own once the peer starts closing, so
	// the close can surface on either call; both are the outcome under test.
	ctx, cancel := env.opCtx()
	defer cancel()
	failure := env.conn.Write(ctx, websocket.MessageText, data)
	if failure == nil {
		_, _, failure = env.conn.Read(ctx)
	}
	if got := websocket.CloseStatus(failure); got != websocket.StatusMessageTooBig {
		t.Fatalf("got close status %v (err %v), want StatusMessageTooBig", got, failure)
	}
}
