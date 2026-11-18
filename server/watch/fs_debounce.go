package watch

import (
	"sync"
	"time"
)

// keyDebouncer coalesces bursts of touches per key into one call of fire.
//
// A key fires once it has been quiet for `quiet`, or `maxWait` after the first
// touch of the burst, whichever comes first: without the cap, something touched
// more often than `quiet` — a file being written continuously — would push its
// call back forever.
type keyDebouncer struct {
	quiet   time.Duration
	maxWait time.Duration
	fire    func(key string)

	pendingMu sync.Mutex
	pending   map[string]*pendingFire
	stopped   bool
}

type pendingFire struct {
	timer    *time.Timer
	deadline time.Time
}

func newKeyDebouncer(quiet, maxWait time.Duration, fire func(key string)) *keyDebouncer {
	return &keyDebouncer{
		quiet:   quiet,
		maxWait: maxWait,
		fire:    fire,
		pending: make(map[string]*pendingFire),
	}
}

func (d *keyDebouncer) touch(key string) {
	d.pendingMu.Lock()
	defer d.pendingMu.Unlock()
	if d.stopped {
		return
	}

	if p, ok := d.pending[key]; ok {
		// Reset on a timer whose callback has already started schedules it once
		// more; flush tells the two runs apart by identity, so the extra one is a
		// no-op. The run that did go ahead fires after this touch, so it covers it.
		p.timer.Reset(min(d.quiet, time.Until(p.deadline)))
		return
	}

	p := &pendingFire{deadline: time.Now().Add(d.maxWait)}
	p.timer = time.AfterFunc(d.quiet, func() { d.flush(key, p) })
	d.pending[key] = p
}

func (d *keyDebouncer) flush(key string, p *pendingFire) {
	d.pendingMu.Lock()
	if d.pending[key] != p {
		d.pendingMu.Unlock()
		return
	}
	delete(d.pending, key)
	d.pendingMu.Unlock()

	d.fire(key)
}

// cancel drops a pending call for key, if any.
func (d *keyDebouncer) cancel(key string) {
	d.pendingMu.Lock()
	defer d.pendingMu.Unlock()
	if p, ok := d.pending[key]; ok {
		p.timer.Stop()
		delete(d.pending, key)
	}
}

// stop drops every pending call and ignores touches from then on. A callback
// already past flush's check may still run.
func (d *keyDebouncer) stop() {
	d.pendingMu.Lock()
	defer d.pendingMu.Unlock()
	d.stopped = true
	for key, p := range d.pending {
		p.timer.Stop()
		delete(d.pending, key)
	}
}
