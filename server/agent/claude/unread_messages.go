package claude

import (
	"log/slog"
	"sync"

	"github.com/pockode/server/agent"
)

// unreadMessages remembers the messages handed to the CLI since the last Stop,
// by the uuid each was sent with, so a Stop that discards some can say which.
//
// A Stop's interrupt carries cancel_queued, and that drops every message the
// CLI has taken in but not yet folded into the turn it stops — typically one
// sent while a long foreground tool runs. Nothing about it reaches the
// transcript on its own: the interrupt's response lists the uuids under
// `cancelled`, and only a sender that stamped them can tell whose they are.
//
// The whole set is taken at each Stop rather than pruned as messages are read.
// The CLI queues a message as it reads it from stdin, so one written before
// the interrupt has by then been answered, is in the turn the interrupt
// aborts, or is among those it cancels: no later Stop can discard it. (One the
// CLI is still admitting when the interrupt lands survives it, and runs as the
// work after the Stop — so it is not discarded either.) Between Stops — for
// the life of the process, if none comes — the set only grows, by one id per
// message: cheaper than following the CLI's per-message lifecycle frames,
// which are internal to it, to prune as it goes.
type unreadMessages struct {
	// sendMu covers the stdin write as well as ids, so that a message and the
	// interrupt reach the CLI in the order the set says.
	sendMu sync.Mutex
	ids    map[string]struct{}
}

// send writes a message and remembers it. A message with no id cannot be
// recognised in a response, so it is written and forgotten.
func (u *unreadMessages) send(id string, write func() error) error {
	u.sendMu.Lock()
	defer u.sendMu.Unlock()
	if err := write(); err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	if u.ids == nil {
		u.ids = make(map[string]struct{})
	}
	u.ids[id] = struct{}{}
	return nil
}

// takeAll hands everything remembered to write, which sends the interrupt
// that may discard it, and starts the set over.
func (u *unreadMessages) takeAll(write func(unread map[string]struct{}) error) error {
	u.sendMu.Lock()
	defer u.sendMu.Unlock()
	unread := u.ids
	u.ids = nil
	return write(unread)
}

// discardedMessages records each message of ours among the uuids an interrupt
// cancelled. Anything else in the list is not a message Pockode sent — the CLI
// says the list may include uuids it enqueued itself — so it is only logged.
//
// The uuid a message went out with is its record's id (agent.Prompt.ID), so the
// record written for it names that message and nothing needs translating.
func discardedMessages(log *slog.Logger, unread map[string]struct{}, cancelled []string) []agent.AgentEvent {
	var events []agent.AgentEvent
	for _, id := range cancelled {
		if _, ok := unread[id]; !ok {
			log.Debug("interrupt cancelled a command Pockode did not send", "uuid", id)
			continue
		}
		log.Info("interrupt discarded an unread message", "messageId", id)
		events = append(events, agent.MessageDiscardedEvent{MessageID: id})
	}
	return events
}
