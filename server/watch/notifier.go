package watch

import "context"

// Notification represents a message to be sent to a subscriber.
type Notification struct {
	Method string
	Params any
}

// Notifier abstracts the mechanism for sending notifications.
// WebSocket clients use JSONRPCNotifier; other clients can provide their own implementation.
type Notifier interface {
	Notify(ctx context.Context, n Notification) error
}
