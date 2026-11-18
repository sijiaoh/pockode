package watch

import (
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

// These run in a synctest bubble, so the debouncer's timers count fake time:
// every duration below is exact, and a loaded machine cannot stretch it.

type fireRecorder struct {
	firesMu sync.Mutex
	fires   []time.Time
}

func (r *fireRecorder) fire(string) {
	r.firesMu.Lock()
	defer r.firesMu.Unlock()
	r.fires = append(r.fires, time.Now())
}

func (r *fireRecorder) times() []time.Time {
	r.firesMu.Lock()
	defer r.firesMu.Unlock()
	return append([]time.Time{}, r.fires...)
}

const (
	testQuiet   = 100 * time.Millisecond
	testMaxWait = 500 * time.Millisecond
)

func TestKeyDebouncer_BurstFiresOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var r fireRecorder
		d := newKeyDebouncer(testQuiet, testMaxWait, r.fire)
		defer d.stop()

		start := time.Now()
		const burst = 200 * time.Millisecond
		for time.Since(start) < burst {
			d.touch("sub")
			time.Sleep(time.Millisecond)
		}
		time.Sleep(2 * testMaxWait)
		synctest.Wait()

		fires := r.times()
		if len(fires) != 1 {
			t.Fatalf("fired %d times for one burst, want 1", len(fires))
		}
		if got, want := fires[0].Sub(start), burst+testQuiet; got > want {
			t.Errorf("fired %v after the burst began, want by %v", got, want)
		}
	})
}

func TestKeyDebouncer_ContinuousTouchesFireWithinMaxWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var r fireRecorder
		d := newKeyDebouncer(testQuiet, testMaxWait, r.fire)
		defer d.stop()

		// Touched more often than quiet: without the cap it would never fire.
		var touches []time.Time
		start := time.Now()
		const span = 2 * time.Second
		for time.Since(start) < span {
			d.touch("sub")
			touches = append(touches, time.Now())
			time.Sleep(testQuiet / 2)
		}
		time.Sleep(2 * testMaxWait)
		synctest.Wait()

		fires := r.times()
		if len(fires) < 2 {
			t.Fatalf("fired %d times during %v of continuous touches, want it to keep firing", len(fires), span)
		}
		for _, touched := range touches {
			if !slices.ContainsFunc(fires, func(fired time.Time) bool {
				return !fired.Before(touched) && fired.Sub(touched) <= testMaxWait
			}) {
				t.Errorf("touch at %v was not followed by a fire within %v (fires at %v)",
					touched.Sub(start), testMaxWait, offsets(fires, start))
			}
		}
	})
}

func offsets(times []time.Time, start time.Time) []time.Duration {
	out := make([]time.Duration, len(times))
	for i, at := range times {
		out[i] = at.Sub(start)
	}
	return out
}

func TestKeyDebouncer_KeysAreIndependent(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var firedMu sync.Mutex
		fired := map[string]int{}
		d := newKeyDebouncer(testQuiet, testMaxWait, func(key string) {
			firedMu.Lock()
			defer firedMu.Unlock()
			fired[key]++
		})
		defer d.stop()

		d.touch("a")
		d.touch("b")
		d.touch("a")
		time.Sleep(2 * testQuiet)
		synctest.Wait()

		firedMu.Lock()
		defer firedMu.Unlock()
		if fired["a"] != 1 || fired["b"] != 1 {
			t.Errorf("fired = %v, want each key once", fired)
		}
	})
}

func TestKeyDebouncer_CancelAndStopDropPendingFires(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var r fireRecorder
		d := newKeyDebouncer(testQuiet, testMaxWait, r.fire)

		d.touch("cancelled")
		d.cancel("cancelled")
		d.touch("stopped")
		d.stop()
		d.touch("after-stop")
		time.Sleep(2 * testMaxWait)
		synctest.Wait()

		if n := len(r.times()); n != 0 {
			t.Errorf("fired %d times, want none", n)
		}
	})
}
