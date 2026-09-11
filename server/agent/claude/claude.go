// Package claude implements Agent interface using Claude CLI.
package claude

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/session"
)

// Binary is the Claude CLI executable name.
const Binary = "claude"

const resumeStateFile = "claude_resume.json"

// Agent implements agent.Agent using Claude CLI.
type Agent struct{}

// New creates a new Claude Agent.
func New() *Agent {
	return &Agent{}
}

// ensureMCPConfig writes the MCP config file and returns its path.
// The config points to the current binary with the "mcp" subcommand.
func ensureMCPConfig(dataDir string) (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable path: %w", err)
	}

	config := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"pockode": map[string]interface{}{
				"command": exe,
				"args":    []string{"mcp", "--data-dir", dataDir},
			},
		},
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", err
	}

	// Written atomically because every session start rewrites this shared file:
	// a plain write truncates it, and a CLI that another session is spawning at
	// that instant would read the truncated JSON and lose its MCP tools.
	configPath := filepath.Join(dataDir, "mcp-config.json")
	if err := filestore.WriteFileAtomic(configPath, data, 0644); err != nil {
		return "", err
	}

	return configPath, nil
}

// Start launches a persistent Claude CLI process.
func (a *Agent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	claudeArgs := []string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
	}

	// Always use permission-prompt-tool so we receive control_request events
	// (including AskUserQuestion) regardless of mode.
	claudeArgs = append(claudeArgs, "--permission-prompt-tool", "stdio")
	if opts.Mode == session.ModeYolo {
		claudeArgs = append(claudeArgs, "--permission-mode", "bypassPermissions")
	}

	if opts.Model != "" {
		claudeArgs = append(claudeArgs, "--model", opts.Model)
	}

	resumeState := newClaudeResumeStateManager(opts, slog.With("sessionId", opts.SessionID))
	launch := resumeState.resolve()
	if launch.sessionID != "" {
		if launch.resume {
			claudeArgs = append(claudeArgs, "--resume", launch.sessionID)
			if launch.fork {
				claudeArgs = append(claudeArgs, "--fork-session")
			}
		} else {
			claudeArgs = append(claudeArgs, "--session-id", launch.sessionID)
		}
	}

	// Add MCP config for work management tools (unless disabled for testing).
	// The proxy must reach the single running server, whose server.json lives in
	// the main data dir — not this session's per-worktree DataDir.
	if !opts.DisableMCP {
		mcpConfigPath, err := ensureMCPConfig(opts.MCPDir())
		if err != nil {
			cancel()
			return nil, fmt.Errorf("failed to create MCP config: %w", err)
		}
		claudeArgs = append(claudeArgs, "--mcp-config", mcpConfigPath)
	}

	cmd := exec.CommandContext(procCtx, Binary, claudeArgs...)
	cmd.Dir = opts.WorkDir

	// stdin ownership is transferred to session; closed by session.Close()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		cancel()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		cancel()
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		cancel()
		return nil, fmt.Errorf("failed to start claude: %w", err)
	}

	log := slog.With("sessionId", opts.SessionID)
	log.Info("claude process started", "pid", cmd.Process.Pid, "mode", opts.Mode)

	events := make(chan agent.AgentEvent)
	pendingRequests := &sync.Map{}

	// Per-process, so it starts empty on every (re)start — which is what the CLI
	// requires, since it emits no background task level at startup.
	backgroundTasks := &backgroundTaskTracker{}
	lossStore := newBackgroundLossStore(opts)

	sess := &cliSession{
		log:             log,
		events:          events,
		stdin:           stdin,
		pendingRequests: pendingRequests,
		backgroundTasks: backgroundTasks,
		lossStore:       lossStore,
		cancel:          cancel,
	}

	backgroundTasks.wait.start(log, events, sess.queueNote, backgroundWaitBase)

	// Background tasks the previous process took down with it. The agent is told
	// on its next prompt; the user is told in the transcript, from the streaming
	// goroutine below (the event channel has no consumer yet here).
	lostBackgroundTasks := lossStore.peek(log)
	if lostBackgroundTasks > 0 {
		sess.queueNote(fmt.Sprintf(backgroundTasksLostNote, backgroundTaskCount(lostBackgroundTasks)))
	}

	// Stream events from the process.
	// Note: When procCtx is cancelled (via sess.Close), CommandContext sends SIGKILL,
	// which terminates the process and closes stdout, causing streamOutput to exit.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "claude process crashed", "sessionId", opts.SessionID)
			}
		}()
		defer close(events)
		// Before close(events), which the fallback also writes to.
		defer backgroundTasks.wait.stopWaiting()
		defer cancel()
		defer stdout.Close()
		defer stderr.Close()

		// Drain stderr before anything can block on the event channel: the
		// warning below waits for a consumer, and a CLI that fills the stderr
		// pipe meanwhile would wedge instead of starting up.
		stderrCh := agent.ReadStderr(stderr, "claude")

		if warning, ok := resumeState.pendingWarning(); ok {
			select {
			case events <- warning:
			case <-procCtx.Done():
			}
		}

		if lostBackgroundTasks > 0 {
			select {
			case events <- agent.WarningEvent{
				Message: fmt.Sprintf(backgroundTasksLostWarning, backgroundTaskCount(lostBackgroundTasks)),
				Code:    backgroundTasksLostCode,
			}:
				// Only now: a record dropped before the explanation was out would
				// be a silent failure about a silent failure.
				lossStore.clear(log)
			case <-procCtx.Done():
			}
		}

		streamOutput(procCtx, log, stdout, events, pendingRequests, resumeState, backgroundTasks, sess.declineControlRequest)
		agent.WaitForProcess(procCtx, log, cmd, stderrCh, events)
		resumeState.processExited(procCtx.Err() != nil)

		// A process that died on its own — a crash, the CLI exiting — takes its
		// background tasks with it just as a deliberate kill does, and nothing
		// can be reported through a channel that is closing, so it is recorded
		// for the next process to report. Deliberate kills are recorded in Close
		// instead: this goroutine may never be scheduled again on the way out of
		// a server shutdown.
		if procCtx.Err() == nil {
			lossStore.record(log, backgroundTasks.liveCount())
		}

		// Notify client that process has ended (abnormal: process should stay alive)
		select {
		case events <- agent.ProcessEndedEvent{}:
		case <-procCtx.Done():
		}
	}()

	return sess, nil
}

// session implements agent.Session for Claude CLI.
type cliSession struct {
	log             *slog.Logger
	events          chan agent.AgentEvent
	stdin           io.WriteCloser
	stdinMu         sync.Mutex
	pendingRequests *sync.Map // tracks sent control requests by requestID for response matching
	backgroundTasks *backgroundTaskTracker
	lossStore       backgroundLossStore
	cancel          func()
	closeOnce       sync.Once

	noteMu sync.Mutex
	note   string // pending explanation for the agent; see queueNote
}

// Events returns the event channel.
func (s *cliSession) Events() <-chan agent.AgentEvent {
	return s.events
}

// queueNote leaves an explanation for the agent, delivered with the next prompt
// Pockode sends it. Used by the background wait fallback: the user sees a
// warning in the transcript, and this is the agent's copy of the same news —
// without it the agent would be nudged to continue with no idea that Pockode
// stopped waiting for its background task.
func (s *cliSession) queueNote(note string) {
	s.noteMu.Lock()
	defer s.noteMu.Unlock()
	s.note = note
}

func (s *cliSession) takeNote() string {
	s.noteMu.Lock()
	defer s.noteMu.Unlock()
	note := s.note
	s.note = ""
	return note
}

// WaitingForBackgroundWork implements agent.BackgroundWaiter: it reports whether
// this session is holding a turn open for background tasks, so the idle reaper
// does not kill the process (and the tasks with it) during a wait that produces
// no events by definition.
func (s *cliSession) WaitingForBackgroundWork() bool {
	return s.backgroundTasks.waitingForBackgroundWork()
}

// SendMessage sends a message to Claude.
func (s *cliSession) SendMessage(prompt string) error {
	if note := s.takeNote(); note != "" {
		prompt = fmt.Sprintf("<system-reminder>%s</system-reminder>\n\n%s", note, prompt)
	}

	msg := userMessage{
		Type: "user",
		Message: userContent{
			Role:    "user",
			Content: []textContent{{Type: "text", Text: prompt}},
		},
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}
	s.log.Debug("sending prompt", "length", len(prompt))
	return s.writeStdin(data)
}

// SendPermissionResponse sends a permission response to Claude.
func (s *cliSession) SendPermissionResponse(data agent.PermissionRequestData, choice agent.PermissionChoice) error {
	var content controlResponseContent

	switch choice {
	case agent.PermissionAllow, agent.PermissionAlwaysAllow:
		content = controlResponseContent{
			Behavior:     "allow",
			ToolUseID:    data.ToolUseID,
			UpdatedInput: data.ToolInput,
		}
		if choice == agent.PermissionAlwaysAllow && len(data.PermissionSuggestions) > 0 {
			content.UpdatedPermissions = data.PermissionSuggestions
		}
	default:
		content = controlResponseContent{
			Behavior:  "deny",
			Message:   "User denied permission",
			Interrupt: true,
			ToolUseID: data.ToolUseID,
		}
	}

	return s.sendControlResponse(data.RequestID, content)
}

// SendQuestionResponse sends answers to user questions.
// If answers is nil, sends a cancel (deny) response.
//
// The Claude SDK's AskUserQuestion tool expects the updatedInput to retain
// the original input fields (notably `questions`) and add `answers`. Sending
// just `{"answers": ...}` causes the SDK to crash internally with
// "Cannot destructure property 'answers' from null or undefined value" and
// then retry the tool call — re-asking the same question.
func (s *cliSession) SendQuestionResponse(data agent.QuestionRequestData, answers map[string]string) error {
	// Always consume the stored input — even on cancel — so the map doesn't leak.
	originalInput := s.takePendingQuestionInput(data.RequestID)

	var content controlResponseContent

	if answers == nil {
		content = controlResponseContent{
			Behavior:  "deny",
			Message:   "User cancelled the question",
			Interrupt: true,
			ToolUseID: data.ToolUseID,
		}
	} else {
		updatedInput, err := buildQuestionUpdatedInput(originalInput, answers)
		if err != nil {
			return err
		}
		content = controlResponseContent{
			Behavior:     "allow",
			ToolUseID:    data.ToolUseID,
			UpdatedInput: updatedInput,
		}
	}

	return s.sendControlResponse(data.RequestID, content)
}

// takePendingQuestionInput removes and returns the original input stored for
// the given question request. Returns nil if no input was stored (e.g. after a
// control_cancel_request raced ahead of the user's response).
func (s *cliSession) takePendingQuestionInput(requestID string) json.RawMessage {
	v, ok := s.pendingRequests.LoadAndDelete(requestID)
	if !ok {
		return nil
	}
	return v.(pendingQuestionMarker).Input
}

// buildQuestionUpdatedInput merges user-provided answers into the original
// AskUserQuestion tool input. The SDK requires the full original input
// (including `questions`) plus the `answers` field; missing fields cause the
// tool to fail and re-ask.
func buildQuestionUpdatedInput(originalInput json.RawMessage, answers map[string]string) (json.RawMessage, error) {
	var merged map[string]interface{}
	if len(originalInput) > 0 {
		if err := json.Unmarshal(originalInput, &merged); err != nil {
			return nil, fmt.Errorf("failed to parse pending question input: %w", err)
		}
	}
	// Unmarshaling a JSON `null` (or missing input) leaves merged nil; ensure
	// we have a writable map before assigning the answers field.
	if merged == nil {
		merged = map[string]interface{}{}
	}
	merged["answers"] = answers
	data, err := json.Marshal(merged)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal updated input: %w", err)
	}
	return data, nil
}

func (s *cliSession) sendControlResponse(requestID string, content controlResponseContent) error {
	response := controlResponse{
		Type: "control_response",
		Response: controlResponsePayload{
			Subtype:   "success",
			RequestID: requestID,
			Response:  content,
		},
	}

	data, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("failed to marshal control response: %w", err)
	}

	s.log.Debug("sending control response")
	return s.writeStdin(data)
}

// declineControlRequest answers a control request we cannot service with a
// protocol-level error. The CLI blocks the turn until every request it
// originates gets a reply, so staying silent would hang the session.
func (s *cliSession) declineControlRequest(requestID, message string) {
	response := controlErrorResponse{
		Type: "control_response",
		Response: controlErrorPayload{
			Subtype:   "error",
			RequestID: requestID,
			Error:     message,
		},
	}

	data, err := json.Marshal(response)
	if err != nil {
		s.log.Error("failed to marshal control error response", "error", err)
		return
	}

	if err := s.writeStdin(data); err != nil {
		s.log.Error("failed to send control error response", "error", err, "requestId", requestID)
	}
}

// interruptMarker is stored in pendingRequests to identify interrupt responses.
// Needed because control_response only contains request_id, not the request type.
type interruptMarker struct{}

// pendingQuestionMarker is stored in pendingRequests so we can echo the
// original AskUserQuestion tool input back when responding. The SDK requires
// the full original input plus an `answers` field.
type pendingQuestionMarker struct {
	Input json.RawMessage
}

// SendInterrupt sends an interrupt signal to stop the current task.
func (s *cliSession) SendInterrupt() error {
	requestID := generateRequestID()
	request := interruptRequest{
		Type:      "control_request",
		RequestID: requestID,
		Request: interruptRequestData{
			Subtype: "interrupt",
		},
	}

	data, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("failed to marshal interrupt request: %w", err)
	}

	// Store marker so parseControlResponse can identify interrupt responses.
	s.pendingRequests.Store(requestID, interruptMarker{})

	s.log.Info("sending interrupt signal")
	if err := s.writeStdin(data); err != nil {
		s.pendingRequests.Delete(requestID)
		return err
	}
	return nil
}

func generateRequestID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand.Read failure is extremely rare (only on entropy exhaustion).
		// Log and continue with zero bytes rather than failing the interrupt.
		slog.Error("rand.Read failed", "error", err)
	}
	return hex.EncodeToString(b)
}

// Close terminates the Claude process. Safe to call multiple times.
func (s *cliSession) Close() {
	s.closeOnce.Do(func() {
		s.log.Info("terminating claude process")
		// Recorded here, synchronously, rather than only where the process is
		// reaped: Close is the last point a server shutdown waits for, and the
		// streaming goroutine that would otherwise record it may never run again
		// before the process exits.
		s.lossStore.record(s.log, s.backgroundTasks.liveCount())
		s.cancel()
		s.stdinMu.Lock()
		s.stdin.Close()
		s.stdinMu.Unlock()
	})
}

// writeStdin writes data to stdin with mutex protection.
func (s *cliSession) writeStdin(data []byte) error {
	s.stdinMu.Lock()
	defer s.stdinMu.Unlock()
	_, err := s.stdin.Write(append(data, '\n'))
	return err
}

func streamOutput(ctx context.Context, log *slog.Logger, stdout io.Reader, events chan<- agent.AgentEvent, pendingRequests *sync.Map, resumeState *claudeResumeStateManager, backgroundTasks *backgroundTaskTracker, decline declineFunc) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// Decode the envelope once and share it with both the resume-state
		// observer and the parser; both only need Type/Subtype/SessionID/Message.
		var event cliEvent
		if err := json.Unmarshal(line, &event); err != nil {
			log.Warn("failed to parse JSON from CLI", "error", err, "lineLength", len(line))
			select {
			case events <- agent.TextEvent{Content: string(line)}:
				continue
			case <-ctx.Done():
				return
			}
		}

		if resumeState != nil {
			resumeState.observe(event)
		}

		for _, ev := range parseLine(log, line, event, pendingRequests, backgroundTasks, decline) {
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Error("stdout scanner error", "error", err)
		msg := "Some output could not be read"
		code := "scanner_error"
		if errors.Is(err, bufio.ErrTooLong) {
			msg = "Some output was too large to display"
			code = "scanner_buffer_overflow"
		}
		select {
		case events <- agent.WarningEvent{
			Message: msg,
			Code:    code,
		}:
		case <-ctx.Done():
		}
	}
}

// --- Resume state ---

// Recovery stages of the resume ladder, persisted in claude_resume.json. A stage
// says how the *next* launch should be attempted: processExited() escalates it
// one rung when a launch fails, observe() resets it as soon as one works.
const (
	// recoveryNone is the healthy state: resume the recorded provider session.
	recoveryNone = ""
	// recoveryFork resumes the recorded session but lets the CLI mint a new ID
	// for it, which sidesteps an ID that the CLI already owns while still
	// carrying the agent-side context over.
	recoveryFork = "fork"
	// recoveryFresh gives up on the recorded session and starts a brand new one.
	// Terminal stage: it never escalates further, so the ladder cannot loop.
	recoveryFresh = "fresh"
)

type claudeResumeState struct {
	SessionID string `json:"sessionId"`
	Recovery  string `json:"recovery,omitempty"`
}

// claudeLaunch is how the CLI should be started for this session.
type claudeLaunch struct {
	sessionID string
	// resume selects --resume over --session-id.
	resume bool
	// fork adds --fork-session, which only applies together with resume.
	fork bool
}

// claudeResumeStateManager owns claude_resume.json: it picks how to launch the
// CLI, records the provider session ID the CLI reports back, and walks a
// recovery ladder when a launch turns out to be unusable.
type claudeResumeStateManager struct {
	opts agent.StartOptions
	log  *slog.Logger

	mu sync.Mutex
	// persisted mirrors what we believe is on disk, so repeated observations
	// don't rewrite an unchanged file.
	persisted claudeResumeState
	// anchorID is the provider session the ladder is trying to recover.
	anchorID  string
	stage     string
	sawInit   bool
	warnFresh bool
}

func newClaudeResumeStateManager(opts agent.StartOptions, log *slog.Logger) *claudeResumeStateManager {
	return &claudeResumeStateManager{opts: opts, log: log}
}

func (m *claudeResumeStateManager) path() string {
	return filepath.Join(m.opts.DataDir, "sessions", m.opts.SessionID, resumeStateFile)
}

// resolve decides how to launch the CLI, based on the recovery stage left
// behind by the previous launch.
//
//	| state file            | launch                                      |
//	|-----------------------|---------------------------------------------|
//	| none, never activated | --session-id <pockodeID>                    |
//	| none, activated       | --resume <pockodeID> --fork-session         |
//	| recovery ""           | --resume <sessionId>                        |
//	| recovery "fork"       | --resume <sessionId> --fork-session         |
//	| recovery "fresh"      | --session-id <new UUID> (+ user warning)    |
func (m *claudeResumeStateManager) resolve() claudeLaunch {
	if m.opts.SessionID == "" {
		return claudeLaunch{}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	state, _ := m.load()
	m.persisted = state

	if state.SessionID == "" {
		m.anchorID = m.opts.SessionID
		if !m.opts.Resume {
			m.stage = recoveryNone
			return claudeLaunch{sessionID: m.opts.SessionID}
		}
		// Activated but no provider ID recorded: a legacy session from before we
		// persisted the mapping, or one whose state file was lost. Activation
		// means the agent has answered here before, so the CLI already owns
		// <pockodeID> — the init that carried that answer is what claims it —
		// and reusing it as --session-id is fatal ("Session ID ... is already in
		// use"). Forking resumes the transcript *and* mints a new ID, so the
		// agent-side context survives instead of being thrown away.
		m.stage = recoveryFork
		m.log.Info("forking claude session with no recorded provider id")
		return claudeLaunch{sessionID: m.opts.SessionID, resume: true, fork: true}
	}

	m.anchorID = state.SessionID
	switch state.Recovery {
	case recoveryFork:
		m.stage = recoveryFork
		m.log.Info("forking claude session after a failed resume", "claudeSessionId", state.SessionID)
		return claudeLaunch{sessionID: state.SessionID, resume: true, fork: true}
	case recoveryFresh:
		m.stage = recoveryFresh
		m.warnFresh = true
		// The CLI rejects anything that is not a UUID, so mint a real one.
		newID := uuid.Must(uuid.NewV7()).String()
		m.log.Warn("starting a new claude session after resume attempts failed",
			"unusableSessionId", state.SessionID, "claudeSessionId", newID)
		return claudeLaunch{sessionID: newID}
	default:
		m.stage = recoveryNone
		m.log.Info("resuming claude session", "claudeSessionId", state.SessionID)
		return claudeLaunch{sessionID: state.SessionID, resume: true}
	}
}

// pendingWarning reports the warning owed to the user when the ladder had to
// abandon the previous provider session.
//
// The caller must emit it from the streaming goroutine: the event channel is
// unbuffered, so sending from Start() would deadlock before a consumer exists.
func (m *claudeResumeStateManager) pendingWarning() (agent.WarningEvent, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.warnFresh {
		return agent.WarningEvent{}, false
	}
	m.warnFresh = false
	return agent.WarningEvent{
		Message: "Claude could not reopen this session's earlier conversation, so it is starting over without those messages. The transcript above is unaffected.",
		Code:    "session_not_resumable",
	}, true
}

func (m *claudeResumeStateManager) load() (claudeResumeState, bool) {
	data, err := os.ReadFile(m.path())
	if err != nil {
		return claudeResumeState{}, false
	}
	var state claudeResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		m.log.Warn("failed to parse claude resume state", "error", err)
		return claudeResumeState{}, false
	}
	return state, true
}

// save persists state unless it already matches what is on disk. Callers must
// hold m.mu.
func (m *claudeResumeStateManager) save(state claudeResumeState) {
	// Without a Pockode session there is nothing to resume later, and path()
	// would point at a stray file shared by every anonymous session.
	if m.opts.SessionID == "" || state == m.persisted {
		return
	}
	data, err := json.Marshal(state)
	if err != nil {
		m.log.Error("failed to marshal claude resume state", "error", err)
		return
	}
	if err := filestore.WriteFileAtomic(m.path(), data, 0644); err != nil {
		m.log.Error("failed to write claude resume state", "error", err)
		return
	}
	m.persisted = state
}

// observe records the provider session ID as soon as the CLI reports it.
//
// The init event is the earliest point at which the ID exists, and it is also
// the point at which the CLI creates <id>.jsonl and owns that ID forever. Any
// later checkpoint (the first assistant message, say) leaves a window where a
// failed turn burns an ID we never wrote down. The CLI repeats init at the start
// of every turn, so save() deduplicates against what is already on disk.
func (m *claudeResumeStateManager) observe(event cliEvent) {
	if event.Type != "system" || event.Subtype != "init" || event.SessionID == "" {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.sawInit = true
	m.anchorID = event.SessionID
	m.stage = recoveryNone
	// Reaching init means the launch worked, so the ladder resets.
	m.save(claudeResumeState{SessionID: event.SessionID})
}

// processExited walks the recovery ladder one step when the CLI died without
// ever reporting a session.
//
// Never seeing init means the launch itself failed: both "Session ID ... is
// already in use" and "No conversation found with session ID ..." abort before
// the first turn. This is only a valid failure signal because a process is
// always created to carry a message — chat.Client.sendEvent is the sole caller
// of GetOrCreateProcess and sends immediately after. A CLI started with nothing
// to do exits cleanly without emitting init, and would be misread as a failure.
//
// cancelled means we killed the process ourselves (Close, shutdown), which says
// nothing about whether the session is usable.
func (m *claudeResumeStateManager) processExited(cancelled bool) {
	if m.opts.SessionID == "" || cancelled {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.sawInit {
		return
	}
	next := nextRecovery(m.stage)
	m.log.Warn("claude exited before reporting a session; escalating recovery",
		"claudeSessionId", m.anchorID, "recovery", next)
	m.save(claudeResumeState{SessionID: m.anchorID, Recovery: next})
}

func nextRecovery(stage string) string {
	if stage == recoveryNone {
		return recoveryFork
	}
	// fork and the terminal fresh stage both go to fresh.
	return recoveryFresh
}

// --- Types ---

type userMessage struct {
	Type    string      `json:"type"`
	Message userContent `json:"message"`
}

type userContent struct {
	Role    string        `json:"role"`
	Content []textContent `json:"content"`
}

type textContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type controlRequest struct {
	RequestID string          `json:"request_id"`
	Request   *controlPayload `json:"request"`
}

type controlPayload struct {
	Subtype               string                   `json:"subtype"`
	ToolName              string                   `json:"tool_name,omitempty"`
	Input                 json.RawMessage          `json:"input,omitempty"`
	ToolUseID             string                   `json:"tool_use_id,omitempty"`
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"`
}

type controlResponse struct {
	Type     string                 `json:"type"`
	Response controlResponsePayload `json:"response"`
}

type controlResponsePayload struct {
	Subtype   string                 `json:"subtype"`
	RequestID string                 `json:"request_id"`
	Response  controlResponseContent `json:"response"`
}

type controlResponseContent struct {
	// Permission/Question response fields
	Behavior           string                   `json:"behavior,omitempty"`
	Message            string                   `json:"message,omitempty"`
	Interrupt          bool                     `json:"interrupt,omitempty"`
	ToolUseID          string                   `json:"toolUseID,omitempty"`
	UpdatedInput       json.RawMessage          `json:"updatedInput,omitempty"`
	UpdatedPermissions []agent.PermissionUpdate `json:"updatedPermissions,omitempty"`
}

type controlErrorResponse struct {
	Type     string              `json:"type"`
	Response controlErrorPayload `json:"response"`
}

type controlErrorPayload struct {
	Subtype   string `json:"subtype"`
	RequestID string `json:"request_id"`
	Error     string `json:"error"`
}

type interruptRequest struct {
	Type      string               `json:"type"`
	RequestID string               `json:"request_id"`
	Request   interruptRequestData `json:"request"`
}

type interruptRequestData struct {
	Subtype string `json:"subtype"`
}

// --- Parsing ---

type cliEvent struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype,omitempty"`
	Message   json.RawMessage `json:"message,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
}

type cliMessage struct {
	Model   string            `json:"model"`
	Content []cliContentBlock `json:"content"`
}

// cliMessageString is for user messages where content is a plain string instead of array.
type cliMessageString struct {
	Content string `json:"content"`
}

type cliContentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
}

// declineFunc answers a control request the CLI is blocking on with a
// protocol-level error. Injected so parsing stays independent of the session.
type declineFunc func(requestID, message string)

// parseLine converts one already-decoded stream-json envelope into agent events.
// line is retained for the cases (assistant, result, control_*) that decode a
// superset struct.
func parseLine(log *slog.Logger, line []byte, event cliEvent, pendingRequests *sync.Map, backgroundTasks *backgroundTaskTracker, decline declineFunc) []agent.AgentEvent {
	events := parseLineEvents(log, line, event, pendingRequests, backgroundTasks, decline)

	// Keep the background wait fallback in step with what the user can see. Any
	// ending that does reach them closes it, so the held-back ending is not
	// delivered on top of it later; anything that shows the agent working pushes
	// its deadline out, because the budget is for a silent wait and not for a
	// turn that resumed and is busy.
	for _, ev := range events {
		if ev.EventType().AwaitsUserInput() {
			backgroundTasks.wait.end()
			break
		}
		if ev.EventType().IndicatesAgentActivity() {
			backgroundTasks.wait.refresh()
		}
	}

	return events
}

func parseLineEvents(log *slog.Logger, line []byte, event cliEvent, pendingRequests *sync.Map, backgroundTasks *backgroundTaskTracker, decline declineFunc) []agent.AgentEvent {
	switch event.Type {
	case "assistant":
		return parseAssistantEvent(log, line, event)
	case "user":
		return parseUserEvent(log, event)
	case "result":
		if ev := parseResultEvent(log, line, backgroundTasks); ev != nil {
			return []agent.AgentEvent{ev}
		}
		return nil
	case "system":
		return parseSystemEvent(log, line, event, backgroundTasks)
	case "control_request":
		return parseControlRequest(log, line, pendingRequests, decline)
	case "control_response":
		return parseControlResponse(log, line, pendingRequests)
	case "control_cancel_request":
		return parseControlCancelRequest(log, line, pendingRequests)
	case "progress", "tool_progress", "tool_use_summary", "rate_limit_event",
		"auth_status", "prompt_suggestion", "command_lifecycle":
		// Telemetry and host-control frames that carry nothing for the transcript;
		// the CLI's own SDK adapter drops the same set. "progress" is the pre-2.1
		// name of "tool_progress" and is kept for older CLIs.
		//
		// Deliberately absent: "conversation_reset", which does carry meaning (the
		// CLI dropped its history, e.g. after /clear) but has no Pockode handling
		// yet, so it stays on the unhandled path where the debug log records it.
		return nil
	default:
		log.Debug("unhandled event type from CLI", "type", event.Type)
		return nil
	}
}

// userVisibleSystemSubtypes lists the `system` subtypes worth putting in the
// transcript. Everything else is internal bookkeeping.
//
// Why an allowlist: the CLI emits dozens of internal system subtypes (task_*,
// hook_*, session_state_changed, turn_duration, ...) and keeps adding more, so
// forwarding unknown subtypes by default turns every tool call into transcript
// noise — a plain `echo hi` alone emits task_started and task_notification.
//
// This mirrors the CLI's own SDK message adapter, which renders exactly this set
// and ignores unknown subtypes. Two deliberate additions: the adapter drops
// api_retry and permission_denied because the interactive REPL has its own
// surfaces for a retry banner and a denial dialog — Pockode has neither, so
// without these a stalled turn or an auto-denied tool would go unexplained.
//
// Two notable exclusions: `init` is session-start metadata that the CLI re-emits
// at the start of every turn, and `thinking_tokens` is a per-delta token
// estimate — both are pure noise in a transcript.
var userVisibleSystemSubtypes = map[string]bool{
	"compact_boundary":          true, // conversation was compacted
	"informational":             true, // loop text banner, e.g. hook feedback
	"api_retry":                 true, // API call failed and is being retried
	"permission_denied":         true, // tool auto-denied without an interactive prompt
	"model_fallback":            true, // switched to a fallback model
	"model_consent_fallback":    true,
	"model_refusal_fallback":    true,
	"model_refusal_no_fallback": true, // model refused and no fallback ran
}

// systemContent extracts the display text of a system event.
type systemContent struct {
	Content string `json:"content"`
}

func parseSystemEvent(log *slog.Logger, line []byte, event cliEvent, backgroundTasks *backgroundTaskTracker) []agent.AgentEvent {
	// A level signal about live state, not a transcript entry: it only updates
	// the tracker parseResultEvent consults.
	if event.Subtype == "background_tasks_changed" {
		backgroundTasks.observe(log, line)
		return nil
	}

	// Output of a local slash command (e.g. /usage). The legacy path delivers
	// the same text inside a user message wrapped in <local-command-stdout>.
	if event.Subtype == "local_command_output" {
		var payload systemContent
		if err := json.Unmarshal(line, &payload); err != nil {
			log.Warn("failed to parse local command output from CLI", "error", err)
			return []agent.AgentEvent{agent.SystemEvent{Content: string(line)}}
		}
		if payload.Content == "" {
			return nil
		}
		return []agent.AgentEvent{agent.CommandOutputEvent{Content: payload.Content}}
	}

	if !userVisibleSystemSubtypes[event.Subtype] {
		log.Debug("ignoring internal system event from CLI", "subtype", event.Subtype)
		return nil
	}

	return []agent.AgentEvent{agent.SystemEvent{Content: string(line)}}
}

// unsupportedControlSubtypes names the requests the CLI originates that Pockode
// has no way to service (we register neither SDK hooks nor in-process MCP
// servers, and have no UI for CLI-driven dialogs), so that the decline can say
// what was asked for. Only the wording depends on this map: every subtype other
// than can_use_tool is declined, named or not.
var unsupportedControlSubtypes = map[string]string{
	"hook_callback":           "hook callbacks",
	"mcp_message":             "in-process MCP servers",
	"elicitation":             "MCP elicitation",
	"request_user_dialog":     "CLI-driven dialogs",
	"oauth_token_refresh":     "OAuth token refresh",
	"host_auth_token_refresh": "host auth token refresh",
}

func parseControlRequest(log *slog.Logger, line []byte, pendingRequests *sync.Map, decline declineFunc) []agent.AgentEvent {
	var req controlRequest
	if err := json.Unmarshal(line, &req); err != nil {
		// The line is valid JSON — streamOutput decoded it already — so this is a
		// field of an unexpected shape. The request id is usually still readable,
		// and answering matters more than understanding what was asked.
		log.Warn("failed to parse control request from CLI", "error", err)
		var partial struct {
			RequestID string `json:"request_id"`
		}
		if err := json.Unmarshal(line, &partial); err != nil || partial.RequestID == "" {
			log.Warn("cannot answer an unreadable control request, the turn may hang")
			return nil
		}
		return declineUnservable(log, decline, partial.RequestID, "", "a request Pockode could not read")
	}

	if req.Request == nil {
		return declineUnservable(log, decline, req.RequestID, "", "a request with no request data")
	}

	switch req.Request.Subtype {
	case "can_use_tool":
		// AskUserQuestion is sent as can_use_tool with tool_name="AskUserQuestion"
		if req.Request.ToolName == "AskUserQuestion" {
			var input struct {
				Questions []agent.AskUserQuestion `json:"questions"`
			}
			if err := json.Unmarshal(req.Request.Input, &input); err != nil {
				// A question we cannot render is still a question the CLI waits
				// on, and the shape of `input` is exactly the kind of thing a new
				// CLI changes. Declining costs the user this one question;
				// returning nil costs them the conversation.
				log.Warn("failed to parse AskUserQuestion input from CLI", "error", err)
				return declineUnservable(log, decline, req.RequestID, req.Request.Subtype, "a question Pockode could not read")
			}

			// Remember the original input so SendQuestionResponse can echo it
			// back merged with user answers — the SDK rejects a response that
			// drops the original `questions` field.
			pendingRequests.Store(req.RequestID, pendingQuestionMarker{Input: req.Request.Input})

			log.Info("AskUserQuestion received", "requestId", req.RequestID)
			return []agent.AgentEvent{agent.AskUserQuestionEvent{
				RequestID: req.RequestID,
				ToolUseID: req.Request.ToolUseID,
				Questions: input.Questions,
			}}
		}

		log.Info("tool permission request", "tool", req.Request.ToolName, "requestId", req.RequestID)
		return []agent.AgentEvent{agent.PermissionRequestEvent{
			RequestID:             req.RequestID,
			ToolName:              req.Request.ToolName,
			ToolInput:             req.Request.Input,
			ToolUseID:             req.Request.ToolUseID,
			PermissionSuggestions: req.Request.PermissionSuggestions,
		}}

	default:
		capability, named := unsupportedControlSubtypes[req.Request.Subtype]
		if !named {
			capability = req.Request.Subtype
		}
		return declineUnservable(log, decline, req.RequestID, req.Request.Subtype, capability)
	}
}

// declineUnservable answers a control request Pockode cannot serve and tells the
// user why the CLI just failed something.
//
// Every control_request is an RPC the CLI blocks the turn on until it is
// answered, and can_use_tool is the only one Pockode can serve. Everything that
// reaches here is answered — an unreadable request, a request missing its body, a
// subtype added by a CLI newer than this code — because the two ways of being
// wrong are not comparable: staying silent hangs the conversation with nothing to
// recover it, while an error answer to a request that turned out not to need one
// costs a spurious warning and the turn goes on.
// subtype is empty for the requests that never got far enough to have one.
func declineUnservable(log *slog.Logger, decline declineFunc, requestID, subtype, capability string) []agent.AgentEvent {
	log.Warn("declining control request Pockode cannot serve",
		"subtype", subtype, "requestId", requestID, "reason", capability)
	decline(requestID, fmt.Sprintf("Pockode does not support %s", capability))
	return []agent.AgentEvent{agent.WarningEvent{
		Message: fmt.Sprintf("Claude requested %s, which Pockode does not support", capability),
		Code:    "unsupported_control_request",
	}}
}

// cliControlResponse represents a control_response from Claude CLI.
type cliControlResponse struct {
	Type     string `json:"type"`
	Response struct {
		Subtype   string `json:"subtype"`
		RequestID string `json:"request_id"`
	} `json:"response"`
}

func parseControlResponse(log *slog.Logger, line []byte, pendingRequests *sync.Map) []agent.AgentEvent {
	var resp cliControlResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		log.Warn("failed to parse control response from CLI", "error", err)
		return nil
	}

	// Check if this response is for an interrupt request we sent.
	requestID := resp.Response.RequestID
	if pending, ok := pendingRequests.LoadAndDelete(requestID); ok {
		if _, isInterrupt := pending.(interruptMarker); isInterrupt {
			log.Info("interrupt acknowledged", "requestId", requestID)
			return []agent.AgentEvent{agent.InterruptedEvent{}}
		}
	}

	// Other control responses (permission, question) don't need client notification.
	return nil
}

// controlCancelRequest represents a control_cancel_request from Claude CLI.
type controlCancelRequest struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
}

func parseControlCancelRequest(log *slog.Logger, line []byte, pendingRequests *sync.Map) []agent.AgentEvent {
	var req controlCancelRequest
	if err := json.Unmarshal(line, &req); err != nil {
		log.Warn("failed to parse control cancel request from CLI", "error", err)
		return nil
	}

	// Drop any stored question input — the SDK no longer expects a response.
	// Cancel only matches request IDs the CLI sent us; interrupt IDs are
	// generated on our side and live in a disjoint namespace.
	pendingRequests.Delete(req.RequestID)

	log.Debug("control cancel request received", "requestId", req.RequestID)
	return []agent.AgentEvent{agent.RequestCancelledEvent{RequestID: req.RequestID}}
}

// syntheticModel is what the CLI puts in an assistant message it wrote itself
// instead of receiving from a model. Where: `message.model` on the assistant
// frame, as spelled by claude 2.1.259.
const syntheticModel = "<synthetic>"

// syntheticNoticeCode labels a synthetic message the CLI did not attribute to a
// specific failure. Where: the assistant frame's own `error` field supplies the
// label when there is one ("authentication_failed", "server_error", ...).
const syntheticNoticeCode = "synthetic_message"

// assistantEnvelope holds the assistant frame fields that sit beside `message`
// rather than inside it. Decoded here rather than added to cliEvent so that a
// CLI spelling one of them differently costs this one label instead of the
// envelope of every frame — a failed cliEvent decode turns the whole line into
// raw text, which does start the session.
type assistantEnvelope struct {
	Error string `json:"error"`
}

// syntheticNotice converts an assistant message the CLI generated itself into a
// warning instead of agent output.
//
// These are the CLI's announcement surface, not the agent answering: an expired
// login ends a turn with "Invalid API key · Fix external API key", a provider
// outage with "API Error: 529 Overloaded". Measured on claude 2.1.259 against a
// local endpoint that always answers 401: the turn emits init, ten
// system/api_retry banners, then this message, then its result.
//
// Why it must not be a TextEvent: text starts the session
// (agent.EventType.ActivatesSession), which locks it to the current agent type.
// A first turn that never reached the model would then be stuck on the agent
// that just failed — the one situation where switching agents is the only way
// out. Warnings do not start a session, and they render as their own banner, so
// the user still reads the same words.
//
// Applied to every synthetic message, including the benign ones (the CLI answers
// its own resume continuation prompt with "No response requested."). Keeping a
// second class on the text path would restore the same bug for whichever notice
// fell into it, and a message with no model behind it is never the agent
// contributing to the conversation regardless of what it says.
func syntheticNotice(log *slog.Logger, line []byte, msg cliMessage) []agent.AgentEvent {
	var textParts []string
	for _, block := range msg.Content {
		if block.Type != "text" {
			// Nothing wrote these but the CLI itself, and it has no model to call
			// a tool with — every synthetic message on record carries one text
			// block and nothing else. Say so out loud rather than drop it, so a
			// CLI that breaks the assumption is visible instead of silent.
			log.Warn("ignoring non-text block in a synthetic assistant message",
				"blockType", block.Type)
			continue
		}
		if block.Text != "" {
			textParts = append(textParts, block.Text)
		}
	}
	if len(textParts) == 0 {
		return nil
	}

	code := syntheticNoticeCode
	var envelope assistantEnvelope
	if err := json.Unmarshal(line, &envelope); err == nil && envelope.Error != "" {
		code = envelope.Error
	}

	return []agent.AgentEvent{agent.WarningEvent{
		Message: strings.Join(textParts, ""),
		Code:    code,
	}}
}

func parseAssistantEvent(log *slog.Logger, line []byte, event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		log.Warn("assistant event message is nil", "subtype", event.Subtype)
		return nil
	}

	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		log.Warn("failed to parse assistant message from CLI", "error", err)
		return []agent.AgentEvent{agent.TextEvent{Content: string(event.Message)}}
	}

	if msg.Model == syntheticModel {
		return syntheticNotice(log, line, msg)
	}

	var events []agent.AgentEvent
	var textParts []string

	// TODO: Handle thinking/redacted_thinking blocks and other missing fields.
	for _, block := range msg.Content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				textParts = append(textParts, block.Text)
			}
		case "tool_use", "server_tool_use":
			if len(textParts) > 0 {
				events = append(events, agent.TextEvent{Content: strings.Join(textParts, "")})
				textParts = nil
			}
			events = append(events, agent.ToolCallEvent{
				ToolUseID: block.ID,
				ToolName:  block.Name,
				ToolInput: block.Input,
			})
		}
	}

	if len(textParts) > 0 {
		events = append(events, agent.TextEvent{Content: strings.Join(textParts, "")})
	}

	return events
}

func parseUserEvent(log *slog.Logger, event cliEvent) []agent.AgentEvent {
	if event.Message == nil {
		return nil
	}

	// Try to parse as cliMessage (content is array of blocks)
	var msg cliMessage
	if err := json.Unmarshal(event.Message, &msg); err != nil {
		// content might be a plain string - try parsing as cliMessageString
		var msgStr cliMessageString
		if err := json.Unmarshal(event.Message, &msgStr); err != nil {
			// Unknown format - output raw for visibility
			return []agent.AgentEvent{agent.TextEvent{Content: string(event.Message)}}
		}
		return extractEventsFromText(log, msgStr.Content)
	}

	var events []agent.AgentEvent
	for _, block := range msg.Content {
		switch block.Type {
		case "tool_result":
			// Check if content contains image (array with type:"image" elements).
			// TODO: Support image display. Also note current HTTP relay has 10MB limit,
			// which may need adjustment for large images.
			if hasImageContent(block.Content) {
				events = append(events, agent.WarningEvent{
					Message: "Image content is not supported yet",
					Code:    "image_not_supported",
				})
				continue
			}

			// Content is JSON: either a string ("...") or array/object.
			// Unmarshal extracts the string value; for non-strings, use raw JSON.
			var content string
			if err := json.Unmarshal(block.Content, &content); err != nil {
				if text, ok := textBlocksContent(block.Content); ok {
					content = text
				} else {
					content = string(block.Content)
				}
			}
			events = append(events, agent.ToolResultEvent{
				ToolUseID:  block.ToolUseID,
				ToolResult: content,
				IsError:    block.IsError,
			})

		default:
			// Unknown block type - log for debugging but don't output to UI
			if data, err := json.Marshal(block); err == nil {
				log.Debug("unknown user message block type", "block", string(data))
			}
		}
	}

	return events
}

// extractEventsFromText extracts agent events from text, handling special tags.
// Content inside command output tags becomes CommandOutputEvent.
// Text outside tags is logged but not emitted as events.
func extractEventsFromText(log *slog.Logger, text string) []agent.AgentEvent {
	commandOutputTags := []struct{ open, close string }{
		{"<local-command-stdout>", "</local-command-stdout>"},
		{"<local-command-stderr>", "</local-command-stderr>"},
	}

	logIgnored := func(content string) {
		if trimmed := strings.TrimSpace(content); trimmed != "" {
			log.Debug("text outside command tags ignored", "content", trimmed)
		}
	}

	var events []agent.AgentEvent
	remaining := text

	for len(remaining) > 0 {
		bestIdx := -1
		var bestTag struct{ open, close string }
		for _, tag := range commandOutputTags {
			idx := strings.Index(remaining, tag.open)
			if idx != -1 && (bestIdx == -1 || idx < bestIdx) {
				bestIdx = idx
				bestTag = tag
			}
		}

		if bestIdx == -1 {
			break
		}

		logIgnored(remaining[:bestIdx])

		endIdx := strings.Index(remaining[bestIdx:], bestTag.close)
		if endIdx == -1 {
			logIgnored(remaining[bestIdx:])
			return events
		}
		endIdx += bestIdx

		contentStart := bestIdx + len(bestTag.open)
		content := strings.TrimSpace(remaining[contentStart:endIdx])
		if content != "" {
			events = append(events, agent.CommandOutputEvent{Content: content})
		}

		remaining = remaining[endIdx+len(bestTag.close):]
	}

	logIgnored(remaining)

	return events
}

// textBlocksContent joins an all-text content block array into the text the
// model itself saw. The Agent (subagent) tool reports this way, and its report
// is Markdown: handing the raw JSON array to the UI would render the report as
// a wall of escaped JSON. Anything but a pure text array is left alone.
func textBlocksContent(content json.RawMessage) (string, bool) {
	if len(content) == 0 || content[0] != '[' {
		return "", false
	}

	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(content, &items); err != nil || len(items) == 0 {
		return "", false
	}

	texts := make([]string, 0, len(items))
	for _, item := range items {
		if item.Type != "text" {
			return "", false
		}
		texts = append(texts, item.Text)
	}
	return strings.Join(texts, "\n"), true
}

// hasImageContent checks if JSON content contains image type elements.
// Returns true if content is an array containing any element with type:"image".
func hasImageContent(content json.RawMessage) bool {
	if len(content) == 0 || content[0] != '[' {
		return false
	}

	var items []struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(content, &items); err != nil {
		return false
	}

	for _, item := range items {
		if item.Type == "image" {
			return true
		}
	}
	return false
}

type resultEvent struct {
	Subtype        string   `json:"subtype"`
	SessionID      string   `json:"session_id"`
	IsError        bool     `json:"is_error"`
	TerminalReason string   `json:"terminal_reason"`
	Result         string   `json:"result"`
	Errors         []string `json:"errors"`
}

// abortTerminalReasonPrefix identifies the terminal reasons that mean the turn
// was stopped (a user interrupt, a denied tool) rather than having failed.
// Where: `terminal_reason` on the result message; older CLIs omit the field.
// 2.1.222 spells them aborted_streaming and aborted_tools; every other reason it
// defines — the failures (model_error, api_error, ...) and the normal endings
// (completed, max_turns, ...) — is named without the prefix.
//
// Matched by prefix rather than against those two values because the distinction
// reaches further than the transcript: an interrupted turn stops the running work
// item, while a completed or failed one lets the work engine auto-continue (see
// work.AutoResumer.HandleProcessStateChange). A new abort reason read as a
// failure would carry on with a turn the user stopped.
const abortTerminalReasonPrefix = "aborted"

// legacyAbortError is how CLIs without terminal_reason reported an abort.
const legacyAbortError = "Request was aborted"

// parseResultEvent turns the CLI's end-of-turn frame into an event, or into
// nothing at all while background work is still running (see below).
func parseResultEvent(log *slog.Logger, line []byte, backgroundTasks *backgroundTaskTracker) agent.AgentEvent {
	var result resultEvent
	if err := json.Unmarshal(line, &result); err != nil {
		return agent.DoneEvent{}
	}

	if result.aborted() {
		return agent.InterruptedEvent{}
	}

	// A failed turn must not look like a completed one; without this the user
	// only sees the response stop with no explanation.
	if result.IsError {
		return agent.ErrorEvent{Error: result.errorMessage()}
	}

	// A normal ending while background tasks are still live is not an ending:
	// the CLI resumes output by itself once they finish, with no input from us.
	// Swallowing the event keeps the whole turn — process state, work state,
	// spinner, Stop button, unread — behaving as one long thought. Errors and
	// aborts above are real endings and still go through.
	if backgroundTasks.hasLive() {
		log.Info("swallowing end of turn, background tasks are still running")
		backgroundTasks.wait.extend()
		return nil
	}

	return agent.DoneEvent{}
}

func (r resultEvent) aborted() bool {
	if r.TerminalReason != "" {
		return strings.HasPrefix(r.TerminalReason, abortTerminalReasonPrefix)
	}
	if r.Subtype != "error_during_execution" {
		return false
	}
	for _, e := range r.Errors {
		if strings.Contains(e, legacyAbortError) {
			return true
		}
	}
	return false
}

// errorMessage picks the CLI's own description of the failure. Error subtypes
// report it in `errors`; a `success` result flagged is_error puts it in `result`.
func (r resultEvent) errorMessage() string {
	var reported []string
	for _, e := range r.Errors {
		if e := strings.TrimSpace(e); e != "" {
			reported = append(reported, e)
		}
	}
	if len(reported) > 0 {
		return strings.Join(reported, "; ")
	}
	if msg := strings.TrimSpace(r.Result); msg != "" {
		return msg
	}
	if r.Subtype != "" {
		return fmt.Sprintf("Claude ended the turn with an error (%s)", r.Subtype)
	}
	return "Claude ended the turn with an error"
}
