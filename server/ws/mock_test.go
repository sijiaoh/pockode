package ws

// TODO: This mock is too complex (fake, not mock). Consider simplifying
// by using function injection or restructuring tests to control behavior directly.

import (
	"context"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

type mockSession struct {
	agent         *mockAgent
	sessionID     string
	events        chan agent.AgentEvent
	messageQueue  chan string
	ctx           context.Context
	mu            sync.Mutex
	closed        bool
	interruptCh   chan struct{}
	interruptOnce sync.Once
}

func (s *mockSession) Events() <-chan agent.AgentEvent {
	return s.events
}

func (s *mockSession) SendMessage(prompt string) error {
	select {
	case s.messageQueue <- prompt:
		// Record here rather than where the queue is drained. A caller that has
		// returned from SendMessage has sent the message, so a test inspecting
		// what was sent must not have to race the mock's own goroutine for it.
		s.agent.recordMessage(s.sessionID, prompt)
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}

func (s *mockSession) SendPermissionResponse(data agent.PermissionRequestData, _ agent.PermissionChoice) error {
	return nil
}

func (s *mockSession) SendQuestionResponse(data agent.QuestionRequestData, _ map[string]string) error {
	return nil
}

func (s *mockSession) SendInterrupt() error {
	s.interruptOnce.Do(func() {
		close(s.interruptCh)
	})
	return nil
}

func (s *mockSession) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	close(s.messageQueue)
}

type startCall struct {
	sessionID string
	resume    bool
	mode      session.Mode
}

type mockAgent struct {
	events    []agent.AgentEvent
	startErr  error
	sessionID string

	mu                sync.Mutex
	messages          []string
	messagesBySession map[string][]string
	sessions          map[string]*mockSession
	startCalls        []startCall
}

func (m *mockAgent) recordMessage(sessionID, prompt string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.messages = append(m.messages, prompt)
	if m.messagesBySession == nil {
		m.messagesBySession = make(map[string][]string)
	}
	m.messagesBySession[sessionID] = append(m.messagesBySession[sessionID], prompt)
}

func (m *mockAgent) Start(ctx context.Context, opts agent.StartOptions) (agent.Session, error) {
	m.mu.Lock()
	m.startCalls = append(m.startCalls, startCall{sessionID: opts.SessionID, resume: opts.Resume, mode: opts.Mode})
	m.mu.Unlock()

	if m.startErr != nil {
		return nil, m.startErr
	}

	eventsChan := make(chan agent.AgentEvent, 100)
	messageQueue := make(chan string, 10)

	effectiveSessionID := opts.SessionID
	if effectiveSessionID == "" {
		effectiveSessionID = m.sessionID
	}
	if effectiveSessionID == "" {
		effectiveSessionID = "mock-session-default"
	}

	sess := &mockSession{
		agent:        m,
		sessionID:    effectiveSessionID,
		events:       eventsChan,
		messageQueue: messageQueue,
		ctx:          ctx,
		interruptCh:  make(chan struct{}),
	}

	m.mu.Lock()
	if m.sessions == nil {
		m.sessions = make(map[string]*mockSession)
	}
	m.sessions[effectiveSessionID] = sess
	m.mu.Unlock()

	go func() {
		defer close(eventsChan)

		for {
			select {
			case _, ok := <-messageQueue:
				if !ok {
					return
				}

				for _, event := range m.events {
					select {
					case eventsChan <- event:
					case <-ctx.Done():
						return
					}
				}

				hasDone := false
				for _, e := range m.events {
					if _, ok := e.(agent.DoneEvent); ok {
						hasDone = true
						break
					}
				}
				if !hasDone {
					select {
					case eventsChan <- agent.DoneEvent{}:
					case <-ctx.Done():
						return
					}
				}

			case <-ctx.Done():
				return
			}
		}
	}()

	return sess, nil
}
