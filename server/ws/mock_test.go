package ws

// TODO: This mock is too complex (fake, not mock). Consider simplifying
// by using function injection or restructuring tests to control behavior directly.

import (
	"context"
	"fmt"
	"sync"

	"github.com/pockode/server/agent"
)

type mockSession struct {
	events          chan agent.AgentEvent
	messageQueue    chan string
	pendingRequests *sync.Map
	ctx             context.Context
	mu              sync.Mutex
	closed          bool
	interruptCh     chan struct{}
	interruptOnce   sync.Once
}

func (s *mockSession) Events() <-chan agent.AgentEvent {
	return s.events
}

func (s *mockSession) SendMessage(prompt string) error {
	select {
	case s.messageQueue <- prompt:
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}

func (s *mockSession) SendPermissionResponse(requestID string, choice agent.PermissionChoice) error {
	_, ok := s.pendingRequests.LoadAndDelete(requestID)
	if !ok {
		return fmt.Errorf("no pending request for id: %s", requestID)
	}
	return nil
}

func (s *mockSession) SendQuestionResponse(requestID string, answers map[string]string) error {
	_, ok := s.pendingRequests.LoadAndDelete(requestID)
	if !ok {
		return fmt.Errorf("no pending request for id: %s", requestID)
	}
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

func (m *mockAgent) Start(ctx context.Context, workDir string, sessionID string, resume bool) (agent.Session, error) {
	m.mu.Lock()
	m.startCalls = append(m.startCalls, startCall{sessionID: sessionID, resume: resume})
	m.mu.Unlock()

	if m.startErr != nil {
		return nil, m.startErr
	}

	eventsChan := make(chan agent.AgentEvent, 100)
	messageQueue := make(chan string, 10)
	pendingRequests := &sync.Map{}

	effectiveSessionID := sessionID
	if effectiveSessionID == "" {
		effectiveSessionID = m.sessionID
	}
	if effectiveSessionID == "" {
		effectiveSessionID = "mock-session-default"
	}

	sess := &mockSession{
		events:          eventsChan,
		messageQueue:    messageQueue,
		pendingRequests: pendingRequests,
		ctx:             ctx,
		interruptCh:     make(chan struct{}),
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
			case prompt, ok := <-messageQueue:
				if !ok {
					return
				}

				m.mu.Lock()
				m.messages = append(m.messages, prompt)
				if m.messagesBySession == nil {
					m.messagesBySession = make(map[string][]string)
				}
				m.messagesBySession[effectiveSessionID] = append(m.messagesBySession[effectiveSessionID], prompt)
				m.mu.Unlock()

				for _, event := range m.events {
					if event.Type == agent.EventTypePermissionRequest {
						pendingRequests.Store(event.RequestID, true)
					}
					select {
					case eventsChan <- event:
					case <-ctx.Done():
						return
					}
				}

				hasDone := false
				for _, e := range m.events {
					if e.Type == agent.EventTypeDone {
						hasDone = true
						break
					}
				}
				if !hasDone {
					select {
					case eventsChan <- agent.AgentEvent{Type: agent.EventTypeDone}:
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
