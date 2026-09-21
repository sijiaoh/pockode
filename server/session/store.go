package session

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/attachments"
	"github.com/pockode/server/filestore"
)

type Store interface {
	// Session metadata (memory only)
	List() ([]SessionMeta, error)
	Get(sessionID string) (SessionMeta, bool, error)

	// Session metadata (with I/O)
	Create(ctx context.Context, sessionID string, spec CreateSpec) (SessionMeta, error)
	// CreateFork creates a session that begins life as a copy of another one.
	CreateFork(ctx context.Context, sessionID string, fork ForkSpec) (SessionMeta, error)
	Delete(ctx context.Context, sessionID string) error
	Update(ctx context.Context, sessionID string, title string) error
	Activate(ctx context.Context, sessionID string) error
	SetAgentType(ctx context.Context, sessionID string, agentType AgentType) error
	SetMode(ctx context.Context, sessionID string, mode Mode) error
	SetModel(ctx context.Context, sessionID string, model string) error
	SetEffort(ctx context.Context, sessionID string, effort string) error
	// ApplyTurn folds one thing that happened into the session's TurnState and
	// returns what changed. It is the only way turn state is ever written; see
	// ReduceTurn.
	ApplyTurn(ctx context.Context, sessionID string, in TurnInput) (TurnTransition, error)
	SetUnread(ctx context.Context, sessionID string, unread bool) error
	// AddUsage folds one agent report into the session's running consumption.
	// A report that says nothing (UsageReport.IsEmpty) is a no-op; any other
	// report for a session that no longer exists returns ErrSessionNotFound.
	AddUsage(ctx context.Context, sessionID string, report UsageReport) error

	// History persistence
	GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error)
	// AppendToHistory appends a JSON-serializable record to history (does not
	// update timestamp) and returns the record's sequence number: its 1-based
	// position in the history GetHistory returns. Sending that number to clients
	// is the only way they can name a record — see HistorySeq.
	AppendToHistory(ctx context.Context, sessionID string, record any) (HistorySeq, error)
	// WriteHistory replaces a session's whole history with records.
	//
	// For a session nothing is streaming to yet — a fork's copied history, written
	// once rather than appended record by record. It does not coordinate with
	// AppendToHistory, so it must not be called on a session that has a live
	// process.
	WriteHistory(ctx context.Context, sessionID string, records []json.RawMessage) error
	// Touch updates the session's UpdatedAt and notifies listeners.
	Touch(ctx context.Context, sessionID string) error

	// Change notification
	AddOnChangeListener(listener OnChangeListener)
}

type indexData struct {
	// Version is the generation of the file on disk, and is here so that a
	// one-time repair of what is already stored can run once instead of on every
	// start. An index written before the field existed reads back as 0, which is
	// exactly the set of files a first repair has to reach.
	Version  int           `json:"version"`
	Sessions []SessionMeta `json:"sessions"`
}

// indexVersion is the generation this build writes. Bump it when a stored value
// has to be repaired rather than merely defaulted — a missing field can be
// filled in unconditionally (see readIndexFromDisk), a wrong one cannot be told
// from a right one without knowing which build wrote it.
const indexVersion = 1

// FileStore is NOT safe for multiple instances sharing the same dataDir.
// Use a single instance per data directory (e.g., via dependency injection).
type FileStore struct {
	dataDir   string
	mu        sync.RWMutex
	sessions  []SessionMeta // in-memory cache
	listeners []OnChangeListener

	// historyMu guards historyLen and is held across the append itself, so two
	// concurrent appends cannot take sequence numbers in one order and reach the
	// file in the other — which would make a sequence number name the wrong
	// record.
	//
	// Lock order is mu then historyMu (Delete takes both). Never take mu while
	// holding this one.
	historyMu  sync.Mutex
	historyLen map[string]int // sessionID -> records written so far
}

func NewFileStore(dataDir string) (*FileStore, error) {
	sessionsDir := filepath.Join(dataDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		return nil, err
	}

	store := &FileStore{dataDir: dataDir, historyLen: make(map[string]int)}

	idx, err := store.readIndexFromDisk()
	if err != nil {
		return nil, err
	}
	store.sessions = idx.Sessions
	store.abortTurnsTheLastRunLeftOpen()

	return store, nil
}

// HistoryTypeProcessEnded is the record that says a session's agent process is
// gone. Spelled out here rather than imported: the agent package owns the event
// vocabulary but is built on top of this one, so the dependency cannot go that
// way. It is exported so that agent's own test can assert the two spellings are
// the same — see agent.TestProcessEndedRecordTypeMatchesTheSessionStores.
const HistoryTypeProcessEnded = "process_ended"

// abortTurnsTheLastRunLeftOpen repairs the sessions that were mid-turn when the
// server stopped, and is why there is no migration script for the session index.
//
// Nothing survives a restart: every process is gone, so every blocker one of
// them raised is unanswerable and every turn one of them was carrying was
// aborted. The stored state still says otherwise, because the server had no
// chance to write anything on the way out — and after a crash or a kill there is
// nothing else to learn it from either. The CLI's own transcript cannot be
// asked: it is killed with SIGKILL, so it may hold a question's tool_use with no
// answer, a half-written last line, or no trace of the question at all.
//
// So the repair is Pockode's own record, in two parts. The state is reduced with
// SignalProcessEnded — the same rule that handles a process dying while the
// server runs, which is the point of there being one rule — and the history gets
// the process_ended record that the killed run never wrote. That record is what
// a client replaying the transcript reads to mark a pending permission card or
// question expired; without it a restarted server shows prompts that look
// answerable and are not.
//
// Sessions that were idle are left completely alone, which is nearly all of
// them, and the ones written before turn state existed are idle by definition.
//
// Runs during construction and takes no lock: nothing else can reach the store
// yet, and there are no listeners to notify.
func (s *FileStore) abortTurnsTheLastRunLeftOpen() {
	now := time.Now()
	repaired := 0

	for i := range s.sessions {
		transition := NormalizeTurn(s.sessions[i].Turn, now)
		// Assigned before the Changed check, not after it: an entry written by a
		// build from before turn state existed reads back with an empty phase,
		// which the reducer treats as idle without calling that a change. The
		// phase is on the wire now, so the in-memory session has to carry the
		// value the reducer read, rather than the blank the file held.
		s.sessions[i].Turn = transition.State
		if !transition.Changed {
			continue
		}
		repaired++

		// Only for a turn that was actually interrupted. A session merely holding
		// a stale phase — nothing was streaming — has nothing to tell the
		// transcript about.
		if !transition.Ended && len(transition.Expired) == 0 {
			continue
		}
		if _, err := s.AppendToHistory(context.Background(), s.sessions[i].ID,
			map[string]any{"type": HistoryTypeProcessEnded}); err != nil {
			slog.Warn("failed to record the end of a session interrupted by a restart",
				"sessionId", s.sessions[i].ID, "error", err)
		}
	}

	if repaired == 0 {
		return
	}
	// Persisted now rather than left to the next write: a session that is never
	// touched again would otherwise be repaired from scratch on every start, and
	// append another process_ended record each time.
	if err := s.persistIndex(); err != nil {
		slog.Warn("failed to persist repaired session turn state", "error", err)
	}
	slog.Info("aborted turns left open by the previous run", "sessions", repaired)
}

func (s *FileStore) indexPath() string {
	return indexPath(s.dataDir)
}

// indexPath locates a data directory's session index without a store, so that
// the store and ReadUsages — which deliberately has none — cannot disagree
// about where it is.
func indexPath(dataDir string) string {
	return filepath.Join(dataDir, "sessions", "index.json")
}

func (s *FileStore) readIndexFromDisk() (indexData, error) {
	// A corrupt index must not make every session unreachable: it is quarantined
	// for hand recovery and the store starts from an empty list.
	var idx indexData
	found, err := filestore.ReadJSONOrQuarantine(s.indexPath(), "session index", &idx)
	if err != nil {
		return indexData{}, err
	}
	if !found {
		return indexData{Sessions: []SessionMeta{}}, nil
	}

	// Migrate: ensure all sessions have valid defaults
	for i := range idx.Sessions {
		idx.Sessions[i].AgentType = ResolveAgentType(idx.Sessions[i].AgentType)
		if idx.Sessions[i].Mode == "" {
			idx.Sessions[i].Mode = ModeDefault
		}
	}

	// Against the version that introduced this repair, not against indexVersion:
	// a later generation must not re-run it, and would if this said "older than
	// current".
	if idx.Version < 1 {
		dropStaleClaudeContext(idx.Sessions)
	}

	return idx, nil
}

// dropStaleClaudeContext forgets a context reading taken by the build that read
// it wrong.
//
// Claude's reading used to be the sum of every API request the turn made rather
// than the size of the last prompt, so a turn of nine requests was stored as
// nine times the context the session actually held — the reading that started
// this was 9,039,777 against a 1,000,000 window, and the session it belonged to
// had 178,508 tokens of conversation. Nothing here can recompute the right
// figure: the per-request counts it should have come from were never stored.
//
// So it is dropped rather than corrected. The figure is a cached measurement,
// not history — no one is owed the number the agent said last month — and a
// session with none says it has not measured its context yet, which is true,
// where a wrong one goes on claiming 904%. The window is kept: it was always
// read correctly, and it is what tells the reader which agent's window the next
// measurement will be against. Codex's reading was the last prompt all along
// (see agent/codex/usage.go), so it survives.
func dropStaleClaudeContext(sessions []SessionMeta) {
	for i := range sessions {
		if sessions[i].AgentType == AgentTypeClaude {
			sessions[i].Usage.ContextTokens = 0
		}
	}
}

func (s *FileStore) persistIndex() error {
	// The version is stamped by whatever write comes first rather than forced at
	// startup: a run that stores nothing has nothing to lose by repairing the
	// same file again, and the first report from any agent writes both at once.
	data, err := filestore.MarshalIndex(indexData{Version: indexVersion, Sessions: s.sessions})
	if err != nil {
		return err
	}
	return filestore.WriteFileAtomic(s.indexPath(), data, 0644)
}

func (s *FileStore) AddOnChangeListener(listener OnChangeListener) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.listeners = append(s.listeners, listener)
}

// notifyChange must be called with mu held — that is the contract listeners are
// written against (see OnChangeListener).
func (s *FileStore) notifyChange(event SessionChangeEvent) {
	for _, l := range s.listeners {
		l.OnSessionChange(event)
	}
}

func (s *FileStore) List() ([]SessionMeta, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]SessionMeta, len(s.sessions))
	copy(result, s.sessions)

	sort.Slice(result, ListOrder(result, SessionMeta.Cursor))

	return result, nil
}

func (s *FileStore) Get(sessionID string) (SessionMeta, bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, sess := range s.sessions {
		if sess.ID == sessionID {
			return sess, true, nil
		}
	}
	return SessionMeta{}, false, nil
}

func (s *FileStore) Create(ctx context.Context, sessionID string, spec CreateSpec) (SessionMeta, error) {
	if err := ctx.Err(); err != nil {
		return SessionMeta{}, err
	}

	agentType := ResolveAgentType(spec.AgentType)
	mode := spec.Mode
	if mode == "" {
		mode = ModeDefault
	}

	// Judged before the session exists rather than through SetModel/SetEffort
	// afterwards: a session that is briefly listed with a model its agent cannot
	// run is one a client can see, and one the kickoff message can race.
	if !IsValidModel(agentType, spec.Model) {
		return SessionMeta{}, fmt.Errorf("%w: model %q, agent %q", ErrModelNotAvailable, spec.Model, agentType)
	}
	if !IsValidEffort(agentType, spec.Effort) {
		return SessionMeta{}, fmt.Errorf("%w: effort %q, agent %q", ErrEffortNotAvailable, spec.Effort, agentType)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	session := SessionMeta{
		ID:        sessionID,
		Title:     "New Chat",
		CreatedAt: now,
		UpdatedAt: now,
		AgentType: agentType,
		Mode:      mode,
		Model:     spec.Model,
		Effort:    spec.Effort,
		Turn:      NewTurnState(now),
	}

	if err := s.insertLocked(session); err != nil {
		return SessionMeta{}, err
	}
	return session, nil
}

// insertLocked puts a new session at the front of the list, persists the index and
// announces it, restoring the in-memory list if the write fails. Caller must hold mu.
func (s *FileStore) insertLocked(session SessionMeta) error {
	s.sessions = append([]SessionMeta{session}, s.sessions...)

	if err := s.persistIndex(); err != nil {
		s.sessions = s.sessions[1:]
		return err
	}

	s.notifyChange(SessionChangeEvent{Op: OperationCreate, Session: session})
	return nil
}

func (s *FileStore) CreateFork(ctx context.Context, sessionID string, fork ForkSpec) (SessionMeta, error) {
	if err := ctx.Err(); err != nil {
		return SessionMeta{}, err
	}

	title := fork.Title
	if title == "" {
		title = fork.Source.Title
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	session := SessionMeta{
		ID:        sessionID,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
		Activated: fork.Activated,
		// The engine choice — agent, mode, model, effort — is inherited rather
		// than taken from the defaults: a conversation continued under a
		// different agent, or answered by a different model, is not a fork of
		// this one. No validation is needed on the way in, because the source's
		// values were already judged against the agent the fork also runs.
		AgentType:  fork.Source.AgentType,
		Mode:       fork.Source.Mode,
		Model:      fork.Source.Model,
		Effort:     fork.Source.Effort,
		ForkedFrom: &ForkOrigin{SessionID: fork.Source.ID},
		// The fork starts idle, and the source's turn is not consulted. A fork
		// can be cut from a session that is mid-turn, and what the source is in
		// the middle of belongs to the source's process: nothing is producing
		// output for the fork, and nothing can answer a prompt copied into it,
		// because only the process that raised one takes its answer. A fork that
		// inherited a running phase would sit there waiting for an ending no
		// process owes it.
		//
		// Unanswered questions are the one thing that does cross, and for the
		// opposite reason: they belong to the session rather than to a process,
		// and the ones that cross are exactly the ones still open *at the cut* —
		// read out of the copied records by the caller, not off the source's
		// live state, which has moved on since (ForkSpec.Unanswered).
		Turn: NewTurnState(now).withUnanswered(fork.Unanswered),
	}

	if err := s.insertLocked(session); err != nil {
		return SessionMeta{}, err
	}

	// The history this fork is about to be given names its attachments by id,
	// and an id resolves inside the session's own directory — so the content
	// has to be here too, or every image in the copied transcript would point
	// at a session the fork does not own. Not fatal: a fork that loses its
	// images is still the conversation the user asked for, and refusing to
	// create it would be the worse trade.
	if err := attachments.Clone(s.dataDir, fork.Source.ID, sessionID); err != nil {
		slog.Warn("failed to copy attachments into forked session",
			"sessionId", sessionID, "sourceSessionId", fork.Source.ID, "error", err)
	}

	return session, nil
}

func (s *FileStore) Delete(ctx context.Context, sessionID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	sessionDir := filepath.Join(s.dataDir, "sessions", sessionID)
	if err := os.RemoveAll(sessionDir); err != nil {
		return err
	}

	s.historyMu.Lock()
	delete(s.historyLen, sessionID)
	s.historyMu.Unlock()

	newSessions := make([]SessionMeta, 0, len(s.sessions))
	for _, sess := range s.sessions {
		if sess.ID != sessionID {
			newSessions = append(newSessions, sess)
		}
	}
	s.sessions = newSessions

	if err := s.persistIndex(); err != nil {
		return err
	}

	s.notifyChange(SessionChangeEvent{Op: OperationDelete, Session: SessionMeta{ID: sessionID}})
	return nil
}

// updateMeta applies a mutation to one session's metadata under the store lock.
// It persists and notifies only when apply reports an actual change, so callers
// that write the value a session already has cost nothing. An apply that
// rejects the write returns the error to the caller unchanged.
func (s *FileStore) updateMeta(ctx context.Context, sessionID string, apply func(*SessionMeta) (bool, error)) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range s.sessions {
		if s.sessions[i].ID != sessionID {
			continue
		}
		changed, err := apply(&s.sessions[i])
		if err != nil {
			return err
		}
		if !changed {
			return nil
		}
		if err := s.persistIndex(); err != nil {
			return err
		}
		s.notifyChange(SessionChangeEvent{Op: OperationUpdate, Session: s.sessions[i]})
		return nil
	}

	return ErrSessionNotFound
}

func (s *FileStore) Update(ctx context.Context, sessionID string, title string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.Title = title
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

func (s *FileStore) Activate(ctx context.Context, sessionID string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.Activated = true
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

func (s *FileStore) SetAgentType(ctx context.Context, sessionID string, agentType AgentType) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.AgentType = agentType
		// Models are agent-specific and no two agents share one, so a model
		// selected for the previous agent would only make the CLI fail to start.
		// Falling back to the empty model hands the choice back to the CLI.
		if !IsValidModel(agentType, meta.Model) {
			meta.Model = ""
		}
		// Same for effort: the levels are per agent and the new agent may not
		// offer the stored one — or may have no effort concept at all.
		if !IsValidEffort(agentType, meta.Effort) {
			meta.Effort = ""
		}
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

func (s *FileStore) SetMode(ctx context.Context, sessionID string, mode Mode) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.Mode = mode
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

// SetModel rejects a model the session's agent cannot run with
// (ErrModelNotAvailable). The check belongs here rather than in the caller: the
// agent type it has to be judged against is only stable under the store lock,
// so a caller that validated beforehand could still write a model the agent
// type it saw no longer has.
func (s *FileStore) SetModel(ctx context.Context, sessionID string, model string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		if !IsValidModel(meta.AgentType, model) {
			return false, fmt.Errorf("%w: model %q, agent %q", ErrModelNotAvailable, model, meta.AgentType)
		}
		meta.Model = model
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

// SetEffort rejects an effort level the session's agent does not offer
// (ErrEffortNotAvailable), for the same reason SetModel judges the model here:
// the agent type it has to be judged against is only stable under the store
// lock. The stored model is left alone — effort is validated per agent, not per
// model (see effort.go).
func (s *FileStore) SetEffort(ctx context.Context, sessionID string, effort string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		if !IsValidEffort(meta.AgentType, effort) {
			return false, fmt.Errorf("%w: effort %q, agent %q", ErrEffortNotAvailable, effort, meta.AgentType)
		}
		meta.Effort = effort
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}

// ApplyTurn runs the reducer against the stored state and writes the result.
// The index is only rewritten when the state actually moved, which is what keeps
// a turn's worth of output — dozens of events that all say "still running" —
// from costing a file write each.
func (s *FileStore) ApplyTurn(ctx context.Context, sessionID string, in TurnInput) (TurnTransition, error) {
	var transition TurnTransition
	err := s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		transition = ReduceTurn(meta.Turn, in)
		meta.Turn = transition.State
		return transition.Changed, nil
	})
	if err != nil {
		return TurnTransition{}, err
	}
	return transition, nil
}

// AddUsage records consumption without touching UpdatedAt: spending tokens is
// not activity in the conversation, and moving the session to the top of the
// list every time a turn is metered would reorder the list behind the user's
// back.
//
// It does notify, which is how the open session's detail view stays live, and
// that notification also reaches SessionListWatcher — where it pushes a row
// whose fields have not changed, because usage is not part of a row
// (rpc.SessionListItem). Accepted rather than designed around: it is one small
// message per report (Claude reports once per turn, Codex a handful of times),
// against the dozens a turn already sends, and the alternative — a second class
// of listener, or rows diffed against the last ones sent — buys that back with
// state that has to be kept correct.
func (s *FileStore) AddUsage(ctx context.Context, sessionID string, report UsageReport) error {
	if report.IsEmpty() {
		return nil
	}
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		return meta.Usage.apply(report), nil
	})
}

func (s *FileStore) SetUnread(ctx context.Context, sessionID string, unread bool) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		if meta.Unread == unread {
			return false, nil
		}
		meta.Unread = unread
		return true, nil
	})
}

func (s *FileStore) historyPath(sessionID string) string {
	return filepath.Join(s.dataDir, "sessions", sessionID, "history.jsonl")
}

func (s *FileStore) GetHistory(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	// No lock: history lives in an independent per-session file reached via an
	// immutable path, and AppendToHistory writes it lock-free. Taking s.mu here
	// would only block metadata writers for the whole (potentially large) scan
	// without protecting anything.
	path := s.historyPath(sessionID)
	records, stats, err := filestore.ReadJSONL(path, filestore.DefaultMaxLineBytes)
	if err != nil {
		return nil, err
	}

	if stats.Damaged() {
		slog.Warn("session history has unreadable records",
			"sessionId", sessionID, "path", path,
			"corrupted", stats.Corrupted, "oversized", stats.Oversized)
		records = append(records, historyWarning(stats))
	}

	return records, nil
}

// historyWarning surfaces skipped records in the chat itself, so a user does
// not silently see a shorter history than what actually happened.
//
// It carries seq 0 because it is not in the file: nothing can be resolved back to
// it, and leaving it to be numbered by position would hand out an address that the
// next real append also gets — the client would then name a record it never saw.
// Stamping leaves an existing seq alone, and this record is only ever appended
// last, so the records before it keep their positions.
func historyWarning(stats filestore.JSONLStats) json.RawMessage {
	var parts []string
	if stats.Corrupted > 0 {
		parts = append(parts, fmt.Sprintf("%s damaged by an interrupted write", countEntries(stats.Corrupted)))
	}
	if stats.Oversized > 0 {
		parts = append(parts, fmt.Sprintf("%s too large to load", countEntries(stats.Oversized)))
	}

	code := "history_buffer_overflow"
	if stats.Corrupted > 0 {
		code = "history_corrupted"
	}

	// Marshaling plain strings and an int cannot fail.
	warning, _ := json.Marshal(map[string]any{
		"type":    "warning",
		"message": "Skipped " + strings.Join(parts, ", and "),
		"code":    code,
		"seq":     NoHistorySeq,
	})
	return warning
}

func countEntries(n int) string {
	if n == 1 {
		return "1 history entry"
	}
	return fmt.Sprintf("%d history entries", n)
}

func (s *FileStore) AppendToHistory(ctx context.Context, sessionID string, record any) (HistorySeq, error) {
	if err := ctx.Err(); err != nil {
		return NoHistorySeq, err
	}

	s.historyMu.Lock()
	defer s.historyMu.Unlock()

	written, err := s.historyLenLocked(sessionID)
	if err != nil {
		return NoHistorySeq, err
	}

	if err := filestore.AppendJSONL(s.historyPath(sessionID), record); err != nil {
		return NoHistorySeq, err
	}

	s.historyLen[sessionID] = written + 1
	return HistorySeq(written + 1), nil
}

// historyLenLocked returns how many records the session's history holds,
// counting them off disk the first time it is asked. Caller must hold historyMu.
//
// It counts what GetHistory returns rather than lines in the file, so a record a
// crash damaged — which GetHistory skips — does not shift every later sequence
// number by one against the history the client was given. The count is seeded
// once because only this process appends to it afterwards.
func (s *FileStore) historyLenLocked(sessionID string) (int, error) {
	if written, ok := s.historyLen[sessionID]; ok {
		return written, nil
	}

	records, _, err := filestore.ReadJSONL(s.historyPath(sessionID), filestore.DefaultMaxLineBytes)
	if err != nil {
		return 0, err
	}
	s.historyLen[sessionID] = len(records)
	return len(records), nil
}

func (s *FileStore) WriteHistory(ctx context.Context, sessionID string, records []json.RawMessage) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	var buf bytes.Buffer
	for i, record := range records {
		// Compacted rather than copied through: one record per line is the file
		// format, and a record carrying a newline would silently become two lines
		// neither of which parses.
		if err := json.Compact(&buf, record); err != nil {
			return fmt.Errorf("history record %d is not valid JSON: %w", i, err)
		}
		buf.WriteByte('\n')
	}

	s.historyMu.Lock()
	defer s.historyMu.Unlock()

	if err := filestore.WriteFileAtomic(s.historyPath(sessionID), buf.Bytes(), 0644); err != nil {
		return err
	}

	s.historyLen[sessionID] = len(records)
	return nil
}

func (s *FileStore) Touch(ctx context.Context, sessionID string) error {
	return s.updateMeta(ctx, sessionID, func(meta *SessionMeta) (bool, error) {
		meta.UpdatedAt = time.Now()
		return true, nil
	})
}
