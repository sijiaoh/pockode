// Package claude implements Agent interface using Claude CLI.
package claude

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
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

// mcpConfigPrefix starts the name of a process run's MCP config, written in the
// session's own data dir next to the rest of its per-session agent state.
const mcpConfigPrefix = "mcp-config-"

// writeMCPConfig writes the MCP config for one process run and returns its path
// together with the func that removes it.
//
// Two properties, both load-bearing:
//
// It carries the identity of the session being spawned (see mcp.Caller), so it
// cannot be one file shared by every session: that file would hand whichever
// session started last to all of them.
//
// Its name is unique per process run, not per session, because a replaced
// process unwinds asynchronously — the successor is spawned while the
// predecessor's goroutine is still running its cleanup (see
// process.Manager.dropProcess). Sharing one name per session would let that
// cleanup delete the file the successor's CLI has not read yet, and a CLI that
// finds no config comes up with no work_* tools at all, silently.
//
// A hard crash leaves the file behind; it is removed with the session's
// directory when the session is deleted.
func writeMCPConfig(opts agent.StartOptions) (string, func(), error) {
	exe, err := os.Executable()
	if err != nil {
		return "", nil, fmt.Errorf("resolve executable path: %w", err)
	}

	args := []string{"mcp", "--data-dir", opts.MCPDir()}
	if opts.SessionID != "" {
		args = append(args, "--session-id", opts.SessionID)
	}
	// Empty is the main worktree, which the proxy assumes when not told.
	if opts.Worktree != "" {
		args = append(args, "--worktree", opts.Worktree)
	}

	config := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"pockode": map[string]interface{}{
				"command": exe,
				"args":    args,
			},
		},
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", nil, err
	}

	// generateRequestID is just a random hex string; here it is what makes the
	// name unique to this run.
	runID := generateRequestID()
	configPath := filepath.Join(sessionDir(opts.DataDir, opts.SessionID), mcpConfigPrefix+runID+".json")
	if err := filestore.WriteFileAtomic(configPath, data, 0644); err != nil {
		return "", nil, err
	}

	return configPath, func() {
		if err := os.Remove(configPath); err != nil && !os.IsNotExist(err) {
			slog.Warn("failed to remove mcp config", "path", configPath, "error", err)
		}
	}, nil
}

// disallowedAskTool is the CLI's own ask-the-user tool, by the name the CLI
// knows it under — it is both the value --disallowedTools takes and the
// tool_name a can_use_tool request carries, which is why there is one constant.
const disallowedAskTool = "AskUserQuestion"

// buildArgs assembles every CLI flag that follows from the session's own state.
// The MCP config flag is added by Start instead: it needs a file written to
// disk, which this must stay free of to be worth testing.
func buildArgs(opts agent.StartOptions, launch claudeLaunch) []string {
	args := []string{
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
	}

	// Always use permission-prompt-tool so we receive control_request events
	// regardless of mode. It is also what turns AskUserQuestion on, which is why
	// the flag below has to turn it back off.
	args = append(args, "--permission-prompt-tool", "stdio")

	// Keep the CLI's own ask-the-user tool out of the model's hands: it holds the
	// turn open waiting for an answer Pockode has nowhere to collect, and
	// question_post is the whole of what it would have been for. Measured on
	// claude 2.1.263: --permission-prompt-tool puts AskUserQuestion in the
	// session's tool list, and this removes it again — the model is not told it
	// exists rather than being refused after asking. parseControlRequest still
	// refuses one, for the CLI version where this stops working.
	args = append(args, "--disallowedTools", disallowedAskTool)
	if opts.Mode == session.ModeYolo {
		args = append(args, "--permission-mode", "bypassPermissions")
	}

	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}

	// An unknown level only earns a warning from the CLI, which then runs at its
	// default effort — so an unvalidated value here would be silently ignored
	// rather than refused. session.IsValidEffort is what keeps that from
	// happening (claude 2.1.263).
	if opts.Effort != "" {
		args = append(args, "--effort", opts.Effort)
	}

	if launch.sessionID != "" {
		if launch.resume {
			args = append(args, "--resume", launch.sessionID)
			if launch.fork {
				args = append(args, "--fork-session")
			}
			if launch.resumeAt != "" {
				args = append(args, "--resume-session-at", launch.resumeAt)
			}
		} else {
			args = append(args, "--session-id", launch.sessionID)
		}
	}

	return args
}

// Start launches a persistent Claude CLI process.
func (a *Agent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	procCtx, cancel := context.WithCancel(ctx)

	log := slog.With("sessionId", opts.SessionID)

	resumeState := newClaudeResumeStateManager(opts, log)
	claudeArgs := buildArgs(opts, resumeState.resolve())

	// Add MCP config for work management tools (unless disabled for testing).
	// The proxy must reach the single running server, whose server.json lives in
	// the main data dir — not this session's per-worktree DataDir.
	removeMCPConfig := func() {}
	if !opts.DisableMCP {
		mcpConfigPath, remove, err := writeMCPConfig(opts)
		if err != nil {
			cancel()
			return nil, fmt.Errorf("failed to create MCP config: %w", err)
		}
		removeMCPConfig = remove
		claudeArgs = append(claudeArgs, "--mcp-config", mcpConfigPath)
	}

	proc, err := agent.StartProcess(procCtx, log, Binary, claudeArgs, opts.WorkDir)
	if err != nil {
		removeMCPConfig()
		cancel()
		return nil, fmt.Errorf("failed to start claude: %w", err)
	}

	log.Info("claude process started", "pid", proc.Pid(), "mode", opts.Mode)

	events := make(chan agent.AgentEvent)
	pendingRequests := &sync.Map{}

	// Per-process, so it starts empty on every (re)start — which is what the CLI
	// requires, since it emits no background task level at startup.
	backgroundTasks := &backgroundTaskTracker{}
	lossStore := newBackgroundLossStore(opts)

	// Keeps the binary content a tool returns out of the session history; see
	// package attachments.
	attachmentStore := attachments.NewStore(opts.DataDir, opts.SessionID)

	// Per-process for the same reason, and a stronger one: the CLI's usage totals
	// restart with it. See agent.UsageAccumulator.
	usage := newUsageObserver(log, opts)

	sess := &cliSession{
		log:             log,
		events:          events,
		stdin:           proc.Stdin,
		pendingRequests: pendingRequests,
		backgroundTasks: backgroundTasks,
		lossStore:       lossStore,
		cancel:          cancel,
	}

	// Background tasks the previous process took down with it. The agent is told
	// on its next prompt; the user is told in the transcript, from the streaming
	// goroutine below (the event channel has no consumer yet here).
	lostBackground := lossStore.peek(log)
	if lostBackground.LostTasks > 0 {
		sess.QueueNote(fmt.Sprintf(backgroundTasksLostNote, backgroundTaskCount(lostBackground.LostTasks)))
	}

	// Stream events from the process.
	// Note: When procCtx is cancelled (via sess.Close), Process terminates the
	// whole CLI process tree, which closes stdout and lets streamOutput exit.
	go func() {
		defer func() {
			if r := recover(); r != nil {
				logger.LogPanic(r, "claude process crashed", "sessionId", opts.SessionID)
			}
		}()
		defer close(events)
		defer cancel()
		// The config is only good for this process run: it names the session the
		// spawn was for, and the CLI has already read it.
		defer removeMCPConfig()

		// Drain stderr before anything can block on the event channel: the
		// warning below waits for a consumer, and a CLI that fills the stderr
		// pipe meanwhile would wedge instead of starting up.
		stderrCh := agent.ReadStderr(proc.Stderr, "claude")

		if warning, ok := resumeState.pendingWarning(); ok {
			emitEvent(procCtx, events, warning)
		}

		if lostBackground.reportable() && deliverBackgroundLoss(procCtx, events, lostBackground) {
			// Only once it is all out: a record dropped before the explanation
			// was would be a silent failure about a silent failure.
			lossStore.clear(log)
		}

		streamOutput(procCtx, log, proc.Stdout, events, pendingRequests, resumeState, backgroundTasks, usage, sess.refusals(), attachmentStore)
		agent.WaitForProcess(procCtx, log, proc, stderrCh, events)
		resumeState.processExited(procCtx.Err() != nil)

		// A process that died on its own — a crash, the CLI exiting — takes its
		// background tasks with it just as a deliberate kill does, and nothing
		// can be reported through a channel that is closing, so it is recorded
		// for the next process to report. Deliberate kills are recorded in Close
		// instead: this goroutine may never be scheduled again on the way out of
		// a server shutdown.
		if procCtx.Err() == nil {
			lossStore.record(log, backgroundTasks.loss())
		}

		agent.EmitProcessEnded(log, events)
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
	note   string // pending explanation for the agent; see QueueNote
}

// Events returns the event channel.
func (s *cliSession) Events() <-chan agent.AgentEvent {
	return s.events
}

// QueueNote implements agent.SessionNotifier. Claude has somewhere to put a
// note — the next prompt is a string this session builds — so it carries one.
func (s *cliSession) QueueNote(note string) {
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

// refusals hands parsing the two ways this session says no.
func (s *cliSession) refusals() controlRefusals {
	return controlRefusals{decline: s.declineControlRequest, denyTool: s.denyTool}
}

// denyTool refuses a tool the model asked to use, without interrupting.
//
// Interrupt is deliberately absent, and it is not a detail. Measured on claude
// 2.1.263: with interrupt true the CLI throws `message` away and substitutes its
// own "STOP what you are doing and wait for the user" text, then aborts the turn
// (result subtype error_during_execution). With it false, `message` reaches the
// model verbatim as an is_error tool_result and the turn carries on — which is
// the whole point here, since the message is an instruction to ask a different
// way. SendPermissionResponse keeps the interrupting form: a person pressing
// Deny means stop.
func (s *cliSession) denyTool(requestID, toolUseID, message string) {
	if err := s.sendControlResponse(requestID, toolDenial(toolUseID, message)); err != nil {
		s.log.Error("failed to deny a tool the CLI asked to use", "error", err, "requestId", requestID)
	}
}

// toolDenial is the response content for that deny, split out so a test can
// assert on the shape the CLI is actually sent.
func toolDenial(toolUseID, message string) controlResponseContent {
	return controlResponseContent{
		Behavior:  "deny",
		Message:   message,
		ToolUseID: toolUseID,
	}
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
		s.lossStore.record(s.log, s.backgroundTasks.loss())
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

func streamOutput(ctx context.Context, log *slog.Logger, stdout io.Reader, events chan<- agent.AgentEvent, pendingRequests *sync.Map, resumeState *claudeResumeStateManager, backgroundTasks *backgroundTaskTracker, usage *usageObserver, refusals controlRefusals, store attachments.Store) {
	scanner := agent.NewLineScanner(stdout, agent.MaxLineBytes)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		if scanner.Truncated() {
			for _, ev := range oversizedLineEvents(log, line, scanner.Len(), refusals.decline) {
				select {
				case events <- ev:
				case <-ctx.Done():
					return
				}
			}
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
		usage.observe(line, event)

		for _, ev := range parseLine(log, line, event, pendingRequests, backgroundTasks, refusals, store) {
			select {
			case events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}

	if err := scanner.Err(); err != nil {
		log.Error("stdout scanner error", "error", err)
		select {
		case events <- agent.WarningEvent{
			Message: "Some output could not be read",
			Code:    "scanner_error",
		}:
		case <-ctx.Done():
		}
	}
}

// What can still be read out of a truncated line. Regexps rather than a JSON
// decode because the line stops mid-value and no decoder will take it; the CLI
// writes compact JSON, and each of these fields sits ahead of the payload that
// did the overflowing, so they survive in the head.
//
// A bare quote is what keeps this from matching prose that merely talks about
// these fields: inside a JSON string value every quote arrives escaped as \",
// which none of these patterns accept.
var (
	controlRequestPattern = regexp.MustCompile(`"type"\s*:\s*"control_request"`)
	toolResultPattern     = regexp.MustCompile(`"type"\s*:\s*"tool_result"`)
	requestIDPattern      = regexp.MustCompile(`"request_id"\s*:\s*"([^"]+)"`)
	toolUseIDPattern      = regexp.MustCompile(`"tool_use_id"\s*:\s*"([^"]+)"`)
)

// oversizedLineEvents reports a CLI line too large to buffer, and answers in
// its place whatever was waiting on it.
//
// The warning is for the user, who is owed an explanation for the gap in their
// transcript. What follows is for the turn: the two frames that are somebody's
// only ending leave that somebody waiting forever if they simply vanish.
func oversizedLineEvents(log *slog.Logger, head []byte, size int, decline declineFunc) []agent.AgentEvent {
	log.Error("dropped a CLI line too large to buffer", "lineLength", size, "limit", agent.MaxLineBytes)

	warn := func(format string, args ...any) []agent.AgentEvent {
		return []agent.AgentEvent{agent.WarningEvent{
			Message: fmt.Sprintf(format, args...),
			Code:    "scanner_buffer_overflow",
		}}
	}

	// A control_request is the CLI blocked on an answer — a permission prompt,
	// a question. Unanswered, it never reads anything else and the turn stops
	// dead, which is why an unreadable one is declined rather than dropped
	// (the same call parseControlRequest makes for a request it cannot parse).
	if controlRequestPattern.Match(head) {
		m := requestIDPattern.FindSubmatch(head)
		if m == nil {
			log.Error("cannot answer an unreadable control request, the turn may hang")
			return warn("A request from Claude was too large to read (%d bytes); the turn may not continue", size)
		}
		log.Warn("declining a control request too large to read", "requestId", string(m[1]))
		decline(string(m[1]), "Pockode could not read this request: it was too large")
		return warn("A request from Claude was too large to read (%d bytes) and was declined", size)
	}

	msg := fmt.Sprintf("Some output was too large to display (%d bytes) and was skipped", size)
	events := warn("%s", msg)

	// A tool_result is a call's only ending, and the lost one is not coming
	// back, so the call is answered as failed instead of spinning forever.
	//
	// Guarded on the block type rather than on the id alone: tool_use_id also
	// rides on frames that say nothing about a call being over — a progress
	// frame carrying a megabyte of output is one — and answering on one of
	// those would end a call that is still running.
	//
	// Every id in the head, not the first: parallel calls come back as one user
	// message holding a tool_result per call, and the whole line is gone, so
	// each of them lost its ending. Taking only the first would fail a call
	// whose result was readable and leave the one that actually overflowed —
	// the last block in the head — spinning.
	if toolResultPattern.Match(head) {
		for _, m := range toolUseIDPattern.FindAllSubmatch(head, -1) {
			events = append(events, agent.ToolResultEvent{
				ToolUseID:  string(m[1]),
				ToolResult: msg,
				IsError:    true,
			})
		}
	}
	return events
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
	// Unstarted says this session has no provider conversation of its own yet,
	// so the next launch must create one instead of resuming.
	//
	// It exists because a forked session is activated at birth: it holds a
	// transcript, but the CLI has never run under its ID, which is otherwise
	// what activation implies (see resolve). Without it such a session would
	// open by resuming an ID no provider session ever had, fail, and walk the
	// recovery ladder to reach the very launch it should have started with —
	// warning the user about a lost conversation it never had.
	//
	// Only meaningful while SessionID is empty: recording a provider session is
	// what stops this one being unstarted, so observe() clears both at once.
	Unstarted bool `json:"unstarted,omitempty"`
	// ResumeAt cuts the resumed conversation short at the CLI transcript message
	// with this uuid, inclusive: --resume-session-at. A fork sets it so the new
	// session starts from the point it was forked at rather than from wherever
	// the source's conversation happens to have reached.
	//
	// Only meaningful together with Recovery == recoveryFork, which is the only
	// stage that replays a conversation this session does not own. Cleared by
	// observe() with everything else, because the cut is a property of the
	// launch that seeded this session, not of the session the CLI mints from it.
	ResumeAt string `json:"resumeAt,omitempty"`
}

// claudeLaunch is how the CLI should be started for this session.
type claudeLaunch struct {
	sessionID string
	// resume selects --resume over --session-id.
	resume bool
	// fork adds --fork-session, which only applies together with resume.
	fork bool
	// resumeAt adds --resume-session-at, which only applies together with resume.
	//
	// Never without fork: cutting a conversation short and then continuing it
	// under its own ID is how the source session would lose everything past the
	// cut. Only the fork rung ever carries one, which is what keeps the pair
	// together.
	resumeAt string
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
	return resumeStatePath(m.opts.DataDir, m.opts.SessionID)
}

// resumeStatePath locates a session's resume state without a manager, for the
// sessions no manager owns yet: a fork reads the state of the session it came
// from and seeds the state of the one being created.
func resumeStatePath(dataDir, sessionID string) string {
	return filepath.Join(sessionDir(dataDir, sessionID), resumeStateFile)
}

// sessionDir is where everything this agent keeps per session lives, under the
// data dir that owns the session.
func sessionDir(dataDir, sessionID string) string {
	return filepath.Join(dataDir, "sessions", sessionID)
}

// resolve decides how to launch the CLI, based on the recovery stage left
// behind by the previous launch.
//
//	| state file            | launch                                      |
//	|-----------------------|---------------------------------------------|
//	| none, never activated | --session-id <pockodeID>                    |
//	| none, activated       | --resume <pockodeID> --fork-session         |
//	| unstarted             | --session-id <pockodeID>                    |
//	| recovery ""           | --resume <sessionId>                        |
//	| recovery "fork"       | --resume <sessionId> --fork-session         |
//	|   + resumeAt          |   ... --resume-session-at <uuid>            |
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
		// Unstarted is the recorded answer to the same question activation is
		// only a guess at, so it wins: this session has no provider
		// conversation, whatever its transcript suggests.
		if !m.opts.Resume || state.Unstarted {
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
		// Reached either because a plain resume of this id failed, or because a
		// forked session was pointed at the session it was forked from. Both want
		// the same launch: replay the conversation without claiming its id. Only
		// the second knows where the replay should stop.
		m.log.Info("forking the recorded claude session",
			"claudeSessionId", state.SessionID, "resumeAt", state.ResumeAt)
		return claudeLaunch{sessionID: state.SessionID, resume: true, fork: true, resumeAt: state.ResumeAt}
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
	return loadResumeState(m.path(), m.log)
}

func loadResumeState(path string, log *slog.Logger) (claudeResumeState, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return claudeResumeState{}, false
	}
	var state claudeResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		log.Warn("failed to parse claude resume state", "error", err)
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
	// Permission response fields
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
	// UUID is the CLI's id for this frame. On assistant and user frames it is
	// also the uuid of the matching entry in the CLI's own transcript, which is
	// what --resume-session-at takes; on every other frame (init, result,
	// telemetry) it names something the transcript has no entry for, so those
	// ids are deliberately not carried into history.
	UUID string `json:"uuid,omitempty"`
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

// denyToolFunc answers a can_use_tool request with "no" — the request was
// served, and the answer is that the tool may not run. Distinct from
// declineFunc: an error says Pockode could not handle the request at all, a deny
// is a handled request the model gets a tool error for and carries on from.
type denyToolFunc func(requestID, toolUseID, message string)

// controlRefusals is the pair of ways Pockode says no to a control request,
// carried together because parseControlRequest picks between them per request.
type controlRefusals struct {
	decline  declineFunc
	denyTool denyToolFunc
}

// parseLine converts one already-decoded stream-json envelope into agent events.
// line is retained for the cases (assistant, result, control_*) that decode a
// superset struct.
func parseLine(log *slog.Logger, line []byte, event cliEvent, pendingRequests *sync.Map, backgroundTasks *backgroundTaskTracker, refusals controlRefusals, store attachments.Store) []agent.AgentEvent {
	switch event.Type {
	case "assistant":
		return parseAssistantEvent(log, line, event, backgroundTasks)
	case "user":
		return parseUserEvent(log, event, backgroundTasks, store)
	case "result":
		if ev := parseResultEvent(log, line, backgroundTasks); ev != nil {
			return []agent.AgentEvent{ev}
		}
		return nil
	case "system":
		return parseSystemEvent(log, line, event, backgroundTasks)
	case "control_request":
		return parseControlRequest(log, line, refusals)
	case "control_response":
		return parseControlResponse(log, line, pendingRequests)
	case "control_cancel_request":
		return parseControlCancelRequest(log, line)
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
// Those two are read before this map is consulted, but as signals about the
// call they belong to rather than as entries of their own; see parseTaskEvent.
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

	// The task lifecycle. Read as signals about live state — which call is
	// running, what it is doing, how backgrounded work ended — rather than as
	// transcript entries; see parseTaskEvent.
	if isTaskFrame(event.Subtype) {
		return parseTaskEvent(log, line, event.Subtype, backgroundTasks)
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

func parseControlRequest(log *slog.Logger, line []byte, refusals controlRefusals) []agent.AgentEvent {
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
		return declineUnservable(log, refusals.decline, partial.RequestID, "", "a request Pockode could not read")
	}

	if req.Request == nil {
		return declineUnservable(log, refusals.decline, req.RequestID, "", "a request with no request data")
	}

	switch req.Request.Subtype {
	case "can_use_tool":
		// AskUserQuestion is sent as can_use_tool with tool_name="AskUserQuestion".
		// buildArgs disables the tool, so reaching here means a CLI that no longer
		// honours that flag — refuse it rather than let the turn hang on an answer
		// that is never coming.
		if req.Request.ToolName == disallowedAskTool {
			log.Warn("refusing the CLI's own ask-the-user tool", "requestId", req.RequestID)
			refusals.denyTool(req.RequestID, req.Request.ToolUseID, agent.CLIQuestionRefusal)
			return []agent.AgentEvent{agent.CLIQuestionRefusedWarning("Claude")}
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
		return declineUnservable(log, refusals.decline, req.RequestID, req.Request.Subtype, capability)
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

// Nothing of the CLI's is held pending any more, so there is no map to clean up
// here: pendingRequests holds only the interrupts Pockode itself sent, under ids
// from its own namespace, which a cancel from the CLI can never name.
func parseControlCancelRequest(log *slog.Logger, line []byte) []agent.AgentEvent {
	var req controlCancelRequest
	if err := json.Unmarshal(line, &req); err != nil {
		log.Warn("failed to parse control cancel request from CLI", "error", err)
		return nil
	}

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

func parseAssistantEvent(log *slog.Logger, line []byte, event cliEvent, backgroundTasks *backgroundTaskTracker) []agent.AgentEvent {
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
				events = append(events, agent.TextEvent{Content: strings.Join(textParts, ""), ProviderMessageID: event.UUID})
				textParts = nil
			}
			events = append(events, agent.ToolCallEvent{
				ToolUseID: block.ID,
				ToolName:  block.Name,
				ToolInput: block.Input,
				// A fetch names the task it reads, not the call that started
				// it, and only this process holds the two together — so the
				// join is resolved now, while the task is still tracked, and
				// travels with the record.
				OriginToolUseID:   backgroundTasks.originOfCall(block.Name, block.Input),
				ProviderMessageID: event.UUID,
			})
		}
	}

	if len(textParts) > 0 {
		events = append(events, agent.TextEvent{Content: strings.Join(textParts, ""), ProviderMessageID: event.UUID})
	}

	return events
}

func parseUserEvent(log *slog.Logger, event cliEvent, backgroundTasks *backgroundTaskTracker, store attachments.Store) []agent.AgentEvent {
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
			result := parseToolResult(log, store, block.Content)
			// A call that started work outliving it hands back a placeholder,
			// and that it did stays true forever — so it is recorded, not
			// tracked live. Without it a replayed transcript shows a background
			// task that is still running as one that succeeded.
			subtype := ""
			if backgroundTasks.callIsBackgrounded(block.ToolUseID) {
				subtype = agent.ToolResultBackgroundStarted
			}
			events = append(events, agent.ToolResultEvent{
				ToolUseID:         block.ToolUseID,
				ToolResult:        result.text,
				Subtype:           subtype,
				Contents:          result.blocks,
				IsError:           block.IsError,
				ProviderMessageID: event.UUID,
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
// the work engine's aborted-turn rule). A new abort reason read as a
// failure would carry on with a turn the user stopped.
const abortTerminalReasonPrefix = "aborted"

// legacyAbortError is how CLIs without terminal_reason reported an abort.
const legacyAbortError = "Request was aborted"

// parseResultEvent turns the CLI's end-of-turn frame into an event: an ending,
// or — while background work is still running — the turn being parked on it
// (see below).
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
	// It is reported as what it is — the turn parked on that work — rather than
	// passed on as an ending or swallowed. Swallowing it is what this replaces:
	// the turn then read as one long thought, and every surface drew a running
	// agent for a wait that can last hours. Errors and aborts above are real
	// endings and still go through.
	if backgroundTasks.hasLive() {
		log.Info("turn parked, background tasks are still running")
		return agent.BackgroundWaitEvent{}
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
