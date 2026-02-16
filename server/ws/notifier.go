package ws

import (
	"context"

	"github.com/pockode/server/watch"
	"github.com/sourcegraph/jsonrpc2"
)

// JSONRPCNotifier adapts jsonrpc2.Conn to watch.Notifier interface.
type JSONRPCNotifier struct {
	conn *jsonrpc2.Conn
}

var _ watch.Notifier = (*JSONRPCNotifier)(nil)

func NewJSONRPCNotifier(conn *jsonrpc2.Conn) *JSONRPCNotifier {
	return &JSONRPCNotifier{conn: conn}
}

func (n *JSONRPCNotifier) Notify(ctx context.Context, notif watch.Notification) error {
	return n.conn.Notify(ctx, notif.Method, notif.Params)
}
