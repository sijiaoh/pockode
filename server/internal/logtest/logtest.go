// Package logtest captures what code logged, for the tests whose subject is the
// log line itself.
//
// Those exist because some failures have nowhere else to surface: a CLI that
// reports its usage in a shape Pockode's arithmetic no longer describes produces
// numbers that look ordinary, and the warning is the only thing that says
// otherwise. A test that cannot see the warning cannot tell that case from a
// healthy one.
package logtest

import (
	"context"
	"log/slog"
	"sync"
)

// Recorder is an slog.Handler that keeps the records at or above Level.
// Safe for concurrent use: the code under test may log from its own goroutine.
type Recorder struct {
	// Level is the lowest level kept. The zero value keeps warnings and errors,
	// which is what these tests are about; set it lower to keep more.
	Level slog.Level

	mu      sync.Mutex
	records []slog.Record
}

// NewWarnRecorder returns a recorder keeping warnings and above, and a logger
// writing to it.
func NewWarnRecorder() (*Recorder, *slog.Logger) {
	r := &Recorder{Level: slog.LevelWarn}
	return r, slog.New(r)
}

func (r *Recorder) Enabled(_ context.Context, level slog.Level) bool {
	return level >= r.Level
}

func (r *Recorder) Handle(_ context.Context, record slog.Record) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Cloned because the record is retained past Handle, and slog only guarantees
	// a Record's attributes for the duration of the call.
	r.records = append(r.records, record.Clone())
	return nil
}

// WithAttrs and WithGroup return the recorder unchanged: these tests assert on
// messages, and dropping the grouping keeps one list to look at.
func (r *Recorder) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *Recorder) WithGroup(string) slog.Handler      { return r }

// Messages returns the recorded messages, oldest first.
func (r *Recorder) Messages() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	messages := make([]string, len(r.records))
	for i, record := range r.records {
		messages[i] = record.Message
	}
	return messages
}
