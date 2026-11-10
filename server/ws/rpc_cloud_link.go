package ws

import (
	"context"
	"log/slog"

	"github.com/pockode/server/cloudlogin"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/watch"
	"github.com/sourcegraph/jsonrpc2"
)

// CloudLink serves the cloud_link namespace — cloud_link.subscribe,
// cloud_link.unsubscribe, cloud_link.start, cloud_link.cancel and
// cloud_link.unlink — for whichever process owns the cloudlogin.Service. A
// pockode server and a cluster share it.
//
// Nothing a client sends names a cloud: a flow links to the process's own
// -cloud-url, and an unlink revokes at the cloud cloud.json names.
type CloudLink struct {
	// service and watcher are nil on a process that cannot keep a cloud
	// credential, which answers every request with CodeCloudLinkUnavailable.
	service *cloudlogin.Service
	watcher *watch.CloudLinkWatcher
}

// NewCloudLink serves service, which is nil when the process has no cloud
// credential store. Stop it when the connections are gone.
func NewCloudLink(service *cloudlogin.Service) *CloudLink {
	if service == nil {
		return &CloudLink{}
	}
	watcher := watch.NewCloudLinkWatcher(service)
	watcher.Start()
	return &CloudLink{service: service, watcher: watcher}
}

func (c *CloudLink) Stop() {
	if c.watcher != nil {
		c.watcher.Stop()
	}
}

// HandleSubscribe answers with the status now and follows it over notifier;
// subs gives the subscription back when the connection closes.
func (c *CloudLink) HandleSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, notifier watch.Notifier, subs *Subscriptions, log *slog.Logger) {
	if !c.available(ctx, conn, req, log) {
		return
	}
	var params rpc.SubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		sendError(ctx, conn, log, req.ID, jsonrpc2.CodeInvalidParams, "invalid params", nil)
		return
	}

	status, err := c.watcher.Subscribe(params.ID, notifier)
	if err != nil {
		sendSubscriptionError(ctx, conn, log, req.ID, err, "failed to read the cloud link status")
		return
	}
	subs.Track(params.ID, c.watcher)

	if err := conn.Reply(ctx, req.ID, rpc.CloudLinkSubscribeResult{Status: status}); err != nil {
		log.Error("failed to send cloud_link.subscribe response", "error", err)
	}
	c.watcher.Resend()
}

func (c *CloudLink) HandleUnsubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, subs *Subscriptions, log *slog.Logger) {
	if !c.available(ctx, conn, req, log) {
		return
	}
	handleUnsubscribe(ctx, conn, req, c.watcher, subs, "cloud link", log)
}

// HandleStart starts a flow, or answers with the one already running. The
// flow is the process's, not this connection's: it carries on if the client
// goes away, and cloud_link.subscribe finds it again.
func (c *CloudLink) HandleStart(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, log *slog.Logger) {
	if !c.available(ctx, conn, req, log) {
		return
	}
	flow, err := c.service.Start()
	replyCloudLinkFlow(ctx, conn, req.ID, flow, err, log)
}

func (c *CloudLink) HandleCancel(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, log *slog.Logger) {
	if !c.available(ctx, conn, req, log) {
		return
	}
	var params rpc.CloudLinkCancelParams
	if err := unmarshalParams(req, &params); err != nil || params.FlowID == "" {
		sendError(ctx, conn, log, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: flow_id is required", nil)
		return
	}
	flow, err := c.service.Cancel(params.FlowID)
	replyCloudLinkFlow(ctx, conn, req.ID, flow, err, log)
}

// HandleUnlink is `pockode logout`. It can take as long as the cloud client's
// timeout, and as long again while a flow that the user has just approved
// saves its token.
func (c *CloudLink) HandleUnlink(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, log *slog.Logger) {
	if !c.available(ctx, conn, req, log) {
		return
	}
	unlinked, err := c.service.Unlink()
	if err != nil {
		sendInternalError(ctx, conn, log, req.ID, "failed to unlink", err)
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.CloudLinkUnlinkResult{Unlinked: unlinked}); err != nil {
		log.Error("failed to send cloud_link.unlink response", "error", err)
	}
}

func (c *CloudLink) available(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, log *slog.Logger) bool {
	if c.service != nil {
		return true
	}
	sendError(ctx, conn, log, req.ID, rpc.CodeCloudLinkUnavailable,
		"linking to a cloud account is unavailable: this process cannot locate the OS user's configuration directory to keep the cloud credential in", nil)
	return false
}

func replyCloudLinkFlow(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, flow cloudlogin.Flow, err error, log *slog.Logger) {
	if err != nil {
		sendReasonError(ctx, conn, log, id, err, cloudlogin.ErrFlowNotFound)
		return
	}
	if err := conn.Reply(ctx, id, rpc.CloudLinkFlowResult{Flow: flow}); err != nil {
		log.Error("failed to send cloud link flow response", "error", err)
	}
}
