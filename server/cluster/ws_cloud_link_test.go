package cluster

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/cloudcred"
	"github.com/pockode/server/cloudlogin"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/internal/cloudlinktest"
	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/internal/restarttest"
	"github.com/pockode/server/rpc"
)

// What cloud_link.* answers is pinned against the server in package ws, which
// serves both; this pins that the cluster mounts it, pushes changes to a
// subscribed connection, and gives the subscription back when the connection
// closes.
func TestClusterCloudLink(t *testing.T) {
	cloud := cloudlinktest.New(t)
	cloudLinks := cloudlogin.NewService(cloud.URL, cloudcred.NewStore(t.TempDir()), nil, slog.New(slog.DiscardHandler))
	t.Cleanup(cloudLinks.Close)
	server := newTestServerWithCloudLinks(t, authsessiontest.New(), restart.New(restarttest.Executable(t.TempDir())), cloudLinks)

	const subID = "link-1"
	resp, conn := authenticatedCall(t, server.URL, "cloud_link.subscribe", rpc.SubscribeParams{ID: subID})
	if resp.Error != nil {
		t.Fatalf("cloud_link.subscribe: %v", resp.Error)
	}
	var subscribed rpc.CloudLinkSubscribeResult
	if err := json.Unmarshal(resp.Result, &subscribed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if subscribed.Status.CloudURL != cloud.URL || subscribed.Status.Credential != cloudlogin.CredentialNone {
		t.Fatalf("status = %+v, want unlinked from %s", subscribed.Status, cloud.URL)
	}

	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	send(t, ctx, conn, 2, "cloud_link.start", nil)
	for waiting := false; !waiting; {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for the flow to show its code: %v", err)
		}
		var frame struct {
			Method string `json:"method"`
			Params struct {
				ID     string            `json:"id"`
				Status cloudlogin.Status `json:"status"`
			} `json:"params"`
		}
		if err := json.Unmarshal(data, &frame); err != nil {
			t.Fatalf("unmarshal %s: %v", data, err)
		}
		if frame.Method != "cloud_link.changed" {
			continue // the reply to start
		}
		if frame.Params.ID != subID {
			t.Fatalf("notification for %q, want %q", frame.Params.ID, subID)
		}
		flow := frame.Params.Status.Flow
		waiting = flow != nil && flow.Phase == cloudlogin.FlowWaiting && flow.UserCode == cloudlinktest.UserCode
	}

	// The subscription goes with the connection, which frees its id.
	conn.CloseNow()
	deadline := time.Now().Add(opTimeout)
	for {
		resp, _ := authenticatedCall(t, server.URL, "cloud_link.subscribe", rpc.SubscribeParams{ID: subID})
		if resp.Error == nil {
			break
		}
		if !strings.Contains(resp.Error.Message, "already in use") || time.Now().After(deadline) {
			t.Fatalf("subscribing again after the connection closed: %v", resp.Error)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func send(t *testing.T, ctx context.Context, conn *websocket.Conn, id int, method string, params any) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send %s: %v", method, err)
	}
}
