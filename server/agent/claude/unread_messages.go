package claude

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/pockode/server/agent"
)

// discardedMessageCode marks the warning for a message a Stop threw away.
const discardedMessageCode = "message_discarded"

// excerptRunes is how much of a discarded message its warning quotes: enough to
// tell it apart from the others in the conversation, short enough for one line
// on a phone.
const excerptRunes = 60

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
// the life of the process, if none comes — the set only grows, by one excerpt
// per message: cheaper than following the CLI's per-message lifecycle frames,
// which are internal to it, to prune as it goes.
type unreadMessages struct {
	// sendMu covers the stdin write as well as byID, so that a message and the
	// interrupt reach the CLI in the order the set says.
	sendMu sync.Mutex
	byID   map[string]string // uuid -> excerpt
}

// send writes a message and remembers it. A message with no id cannot be
// recognised in a response, so it is written and forgotten.
func (u *unreadMessages) send(id, text string, write func() error) error {
	u.sendMu.Lock()
	defer u.sendMu.Unlock()
	if err := write(); err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	if u.byID == nil {
		u.byID = make(map[string]string)
	}
	u.byID[id] = excerpt(text)
	return nil
}

// takeAll hands everything remembered to write, which sends the interrupt
// that may discard it, and starts the set over.
func (u *unreadMessages) takeAll(write func(unread map[string]string) error) error {
	u.sendMu.Lock()
	defer u.sendMu.Unlock()
	unread := u.byID
	u.byID = nil
	return write(unread)
}

// discardedWarnings reports each message of ours among the uuids an interrupt
// cancelled. Anything else in the list is not a message Pockode sent — the CLI
// says the list may include uuids it enqueued itself — so it is only logged.
func discardedWarnings(log *slog.Logger, unread map[string]string, cancelled []string) []agent.AgentEvent {
	var events []agent.AgentEvent
	for _, id := range cancelled {
		text, ok := unread[id]
		if !ok {
			log.Debug("interrupt cancelled a command Pockode did not send", "uuid", id)
			continue
		}
		log.Info("interrupt discarded an unread message", "messageId", id)
		events = append(events, agent.WarningEvent{
			Message: fmt.Sprintf("Stopping the turn discarded a message the agent had not read yet, so it will not be answered: %s", text),
			Code:    discardedMessageCode,
		})
	}
	return events
}

func excerpt(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return "(attachments only)"
	}
	if r := []rune(text); len(r) > excerptRunes {
		text = string(r[:excerptRunes]) + "…"
	}
	return fmt.Sprintf("%q", text)
}
