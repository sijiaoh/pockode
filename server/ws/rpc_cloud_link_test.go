package ws

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/cloudcred"
	"github.com/pockode/server/cloudlogin"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/internal/cloudlinktest"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// subscribeCloudLink returns the subscription id and the status it answered
// with.
func (e *testEnv) subscribeCloudLink() (string, cloudlogin.Status) {
	e.t.Helper()
	id := e.nextSubID()
	resp := e.call("cloud_link.subscribe", rpc.SubscribeParams{ID: id})
	if resp.Error != nil {
		e.t.Fatalf("cloud_link.subscribe: %s", resp.Error.Message)
	}
	var result rpc.CloudLinkSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("unmarshal cloud_link.subscribe: %v", err)
	}
	return id, result.Status
}

func (e *testEnv) callCloudLinkFlow(method string, params any) cloudlogin.Flow {
	e.t.Helper()
	resp := e.call(method, params)
	if resp.Error != nil {
		e.t.Fatalf("%s: %s", method, resp.Error.Message)
	}
	assertNoCloudSecret(e.t, resp.Result)
	var result rpc.CloudLinkFlowResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("unmarshal %s: %v", method, err)
	}
	return result.Flow
}

// awaitCloudLink reads cloud_link.changed until the status satisfies ok.
// Notifications carry the whole status, and changes close together may reach
// the client as one, so a test waits for a state rather than counting them.
func (e *testEnv) awaitCloudLink(subID string, ok func(cloudlogin.Status) bool) cloudlogin.Status {
	e.t.Helper()
	for {
		notif := e.awaitNotification("cloud_link.changed")
		assertNoCloudSecret(e.t, notif.Params)
		var params struct {
			ID     string            `json:"id"`
			Status cloudlogin.Status `json:"status"`
		}
		if err := json.Unmarshal(notif.Params, &params); err != nil {
			e.t.Fatalf("unmarshal notification: %v", err)
		}
		if params.ID != subID {
			e.t.Fatalf("notification for subscription %q, want %q", params.ID, subID)
		}
		if ok(params.Status) {
			return params.Status
		}
	}
}

// machineToken is the token cloud.json holds in the tests that link; like the
// device code, it never leaves the server.
const machineToken = "machine-token-never-sent-to-a-client"

func assertNoCloudSecret(t *testing.T, data []byte) {
	t.Helper()
	for _, secret := range []string{cloudlinktest.DeviceCode, machineToken} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("a secret reached the client: %s", data)
		}
	}
}

// A link flow as a client drives it: the status before, start, the code and
// the link pushed, cancel — and the flow's end pushed too. How the service
// runs a flow is pinned in package cloudlogin; this pins what reaches the
// client, by wire name.
func TestCloudLink_Flow(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	subID, before := env.subscribeCloudLink()
	want := cloudlogin.Status{CloudURL: env.cloud.URL, Credential: cloudlogin.CredentialNone, Relay: cloudlogin.RelayDisabled}
	if before != want {
		t.Fatalf("status before linking = %+v, want %+v", before, want)
	}
	// Pushed again after the reply, so a notification that overtook the reply
	// cannot leave the client holding the older status.
	if again := env.awaitCloudLink(subID, func(cloudlogin.Status) bool { return true }); again != want {
		t.Fatalf("status pushed after the subscribe reply = %+v, want %+v", again, want)
	}

	started := env.callCloudLinkFlow("cloud_link.start", nil)
	if started.ID == "" || started.Phase.Ended() {
		t.Fatalf("cloud_link.start = %+v, want a running flow", started)
	}

	waiting := env.awaitCloudLink(subID, func(s cloudlogin.Status) bool {
		return s.Flow != nil && s.Flow.Phase == cloudlogin.FlowWaiting
	}).Flow
	if waiting.ID != started.ID || waiting.UserCode != cloudlinktest.UserCode || waiting.VerificationURL != cloudlinktest.VerificationURL {
		t.Errorf("waiting flow = %+v, want %s showing %s at %s", waiting, started.ID, cloudlinktest.UserCode, cloudlinktest.VerificationURL)
	}
	if waiting.ExpiresAt.IsZero() {
		t.Error("the waiting flow reached the client without expires_at")
	}

	canceled := env.callCloudLinkFlow("cloud_link.cancel", rpc.CloudLinkCancelParams{FlowID: started.ID})
	if canceled.Phase != cloudlogin.FlowCanceled || canceled.UserCode != "" || canceled.VerificationURL != "" {
		t.Errorf("cloud_link.cancel = %+v, want canceled with its code cleared", canceled)
	}
	env.awaitCloudLink(subID, func(s cloudlogin.Status) bool {
		return s.Flow != nil && s.Flow.Phase == cloudlogin.FlowCanceled
	})
}

func TestCloudLink_Unlink(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	if err := env.cloudCredential.Save(&cloudcred.Credential{CloudURL: env.cloud.URL, MachineToken: machineToken}); err != nil {
		t.Fatalf("save cloud.json: %v", err)
	}

	subID, before := env.subscribeCloudLink()
	if before.Credential != cloudlogin.CredentialLinked {
		t.Fatalf("status before unlinking = %+v, want linked", before)
	}

	resp := env.call("cloud_link.unlink", nil)
	if resp.Error != nil {
		t.Fatalf("cloud_link.unlink: %s", resp.Error.Message)
	}
	assertNoCloudSecret(t, resp.Result)
	var result rpc.CloudLinkUnlinkResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if want := (cloudlogin.Unlinked{WasLinked: true, CloudURL: env.cloud.URL}); result.Unlinked != want {
		t.Errorf("cloud_link.unlink = %+v, want %+v", result.Unlinked, want)
	}
	env.awaitCloudLink(subID, func(s cloudlogin.Status) bool { return s.Credential == cloudlogin.CredentialNone })
}

func TestCloudLink_Cancel_Refusals(t *testing.T) {
	tests := []struct {
		name    string
		params  any
		wantMsg string
	}{
		{"flow_id missing", rpc.CloudLinkCancelParams{}, "flow_id is required"},
		{"no such flow", rpc.CloudLinkCancelParams{FlowID: "not-a-flow"}, "no such link flow"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			resp := env.call("cloud_link.cancel", tt.params)
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, tt.wantMsg) {
				t.Errorf("got %+v, want invalid params containing %q", resp.Error, tt.wantMsg)
			}
		})
	}
}

// A process with nowhere to keep cloud.json says so to every request, with a
// code the client can show "unavailable" by — even one it would otherwise
// refuse as malformed. newMinimalTestHandler serves no cloud link service.
func TestCloudLink_Unavailable(t *testing.T) {
	h := newMinimalTestHandler(t, testPassword, func() string { return "" }, authsessiontest.New(), authsession.NewTickets())
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	conn, err := dialTestClient(ctx, server.URL)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	if resp := exchange(t, ctx, conn, 1, "auth", rpc.AuthParams{Password: testPassword}); resp.Error != nil {
		t.Fatalf("auth failed: %v", resp.Error)
	}

	requests := []struct {
		method string
		params any
	}{
		{"cloud_link.subscribe", rpc.SubscribeParams{ID: "link-1"}},
		{"cloud_link.unsubscribe", rpc.SubscribeParams{ID: "link-1"}},
		{"cloud_link.start", nil},
		{"cloud_link.cancel", rpc.CloudLinkCancelParams{}},
		{"cloud_link.unlink", nil},
	}
	for i, req := range requests {
		resp := exchange(t, ctx, conn, i+2, req.method, req.params)
		if resp.Error == nil || resp.Error.Code != rpc.CodeCloudLinkUnavailable {
			t.Errorf("%s: got %+v, want CodeCloudLinkUnavailable", req.method, resp.Error)
		}
	}
}
