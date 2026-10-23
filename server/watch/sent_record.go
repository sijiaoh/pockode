package watch

import "sync"

// sentRecord is what a detail watcher last told each of its subscriptions about
// the parts of a detail that a noisy trigger rarely moves — a work item's usage,
// activity and questions, a schedule's run page — so that a change leaving them
// as they were sends nothing. Keyed by subscription id, and judged per subscription rather than per
// item: two clients can be on the same item at different states, and telling one
// must not leave the other stale.
//
// The event loop records what it sends (remember) and Subscribe what its reply
// carries (rememberReply), and two rules keep the record true:
//
//   - A reply only fills an empty entry. A subscription is registered before
//     Subscribe reads the store, so the loop can send it a notification built
//     from an earlier read than the reply's, and that notification can still
//     reach the client after the reply. The client then holds the older state;
//     recording the reply over the loop's entry would claim it holds the newer
//     one, and the change that corrects it would be dropped as already sent.
//     When the order is the other way round this costs one repeated
//     notification.
//   - Every write checks the subscription after writing. The loop works from a
//     snapshot of the subscriptions, so an unsubscribe can land between the
//     snapshot and the write. If it came first, the check finds the subscription
//     gone and deletes what was just written; if it comes after, it deletes the
//     entry itself. Either way nothing outlives the subscription.
type sentRecord[T any] struct {
	watcher *BaseWatcher

	sentMu sync.Mutex
	sent   map[string]T
}

func newSentRecord[T any](watcher *BaseWatcher) *sentRecord[T] {
	return &sentRecord[T]{watcher: watcher, sent: make(map[string]T)}
}

// get reports what subID was last sent, and whether anything was recorded for
// it — nothing recorded is never "already sent".
func (r *sentRecord[T]) get(subID string) (T, bool) {
	r.sentMu.Lock()
	defer r.sentMu.Unlock()
	sent, found := r.sent[subID]
	return sent, found
}

// remember records what the event loop is sending subID.
func (r *sentRecord[T]) remember(subID string, value T) {
	r.sentMu.Lock()
	defer r.sentMu.Unlock()
	r.sent[subID] = value
	r.dropIfGone(subID)
}

// rememberReply records what Subscribe's reply carries, unless the loop has
// already sent subID something.
func (r *sentRecord[T]) rememberReply(subID string, value T) {
	r.sentMu.Lock()
	defer r.sentMu.Unlock()
	if _, sent := r.sent[subID]; sent {
		return
	}
	r.sent[subID] = value
	r.dropIfGone(subID)
}

// forget drops subID's entry. Called after the subscription is removed, so no
// write can land after it: any later one finds the subscription gone.
func (r *sentRecord[T]) forget(subID string) {
	r.sentMu.Lock()
	defer r.sentMu.Unlock()
	delete(r.sent, subID)
}

func (r *sentRecord[T]) dropIfGone(subID string) {
	if r.watcher.GetSubscription(subID) == nil {
		delete(r.sent, subID)
	}
}
