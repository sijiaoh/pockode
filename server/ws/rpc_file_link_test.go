package ws

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/internal/symlinktest"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// The wire side of docs/symlinks.md: a link that cannot be followed is a
// "link" result rather than an error, and a refusal on the way out reads as
// invalid params whose message names the project path, never the host's.
func TestFileGet_Links(t *testing.T) {
	workDir := t.TempDir()
	outside := t.TempDir()
	symlinktest.Make(t, filepath.Join(outside, "secret.txt"), filepath.Join(workDir, "ofile"))
	symlinktest.Make(t, outside, filepath.Join(workDir, "odir"))
	env := newTestEnvWithWorkDir(t, &mockAgent{}, workDir)

	resp := env.call("file.get", rpc.FileGetParams{Path: "ofile"})
	if resp.Error != nil {
		t.Fatalf("file.get failed: %v", resp.Error)
	}
	var result rpc.FileGetResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.Type != "link" || result.Link == nil || result.Link.Type != contents.TypeLink || result.Link.Link.State != contents.LinkOutside {
		t.Errorf("got %+v, want an outside link result", result)
	}

	resp = env.call("file.get", rpc.FileGetParams{Path: "odir/secret.txt"})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("got %+v, want invalid params", resp.Error)
	}
	if want := `"odir/secret.txt" leads outside the project`; resp.Error.Message != want {
		t.Errorf("message = %q, want %q", resp.Error.Message, want)
	}
	if strings.Contains(resp.Error.Message, outside) {
		t.Errorf("message %q names a host path", resp.Error.Message)
	}
}
