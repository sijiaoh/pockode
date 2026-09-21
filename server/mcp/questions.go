package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
)

// Sessions is the session layer as the tool executor reaches it: sessions live
// per worktree, and a tool call arrives naming one through its Caller.
//
// worktree.Manager is the implementation. Where a method takes a worktree name,
// "" is the main one.
type Sessions interface {
	// ResolveQuestions hands back the worktree's question service and the
	// release func to call when the tool call is done with it.
	ResolveQuestions(worktree string) (chat.Questions, func(), error)
	// SessionTurns is work.TurnSource: what every session in the worktree is
	// doing, read off the index on disk when nobody has the worktree open.
	SessionTurns(worktree string) (map[string]session.TurnState, error)
	// LocateQuestions finds every session a request id is still waiting in,
	// anywhere in the project. It is what lets a refusal tell "you are naming
	// somebody else's question" apart from "that question is over", and what
	// makes question_answer ask which session it meant when a fork left the
	// same question open in two.
	LocateQuestions(requestID string) []worktree.QuestionLocation
	// ResolveSessionWorktree answers which worktree a session lives in, for the
	// one caller that arrives with a session id and no worktree: an agent
	// naming the session whose question it is answering.
	ResolveSessionWorktree(sessionID string) (string, error)
}

// questionPostParams is question_post's input. It is not agent.AskUserQuestion:
// that type is the shape a CLI's own prompt frame parses into, and what is
// accepted from a model here is decided here.
type questionPostParams struct {
	Question string `json:"question"`
	Header   string `json:"header"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
	MultiSelect bool `json:"multi_select"`
}

func (e *Executor) questionPost(ctx context.Context, caller Caller, args json.RawMessage) (string, error) {
	if caller.SessionID == "" {
		return "", errNoCallerSession("question_post", noChatToAskIn)
	}

	var params questionPostParams
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	spec, err := questionSpec(params)
	if err != nil {
		return "", err
	}

	// A closed work has no user left watching it: the chat is finished with, and
	// the surfaces that would offer the question are gone with it. Refused
	// rather than posted into that silence — and the agent is told the way out,
	// which is the work's, not the question's.
	if w, found, err := e.workStore.FindBySessionID(caller.SessionID); err != nil {
		return "", fmt.Errorf("find the work this session runs: %w", err)
	} else if found && w.Status == work.StatusClosed {
		return "", userErrorf("work %s is closed, so nobody is coming back to this chat to answer. Reopen it (work_reopen) if it needs to carry on", w.ID)
	}

	questions, release, err := e.sessions.ResolveQuestions(caller.Worktree)
	if err != nil {
		return "", err
	}
	defer release()

	q, err := questions.PostQuestion(ctx, caller.SessionID, spec)
	if err != nil {
		return "", err
	}

	// A subtask's question is news for the story above it, which may know the
	// answer without the user ever being asked. Told after the question is
	// recorded, and on the engine's own goroutine: this call promises that
	// nothing is waiting on it, and delivering to the parent can mean starting
	// the parent's process.
	if e.workEngine != nil {
		e.workEngine.HandleQuestionPosted(caller.SessionID, q)
	}

	return fmt.Sprintf("Question posted (request_id: %s). Nothing is waiting here — carry on. "+
		"The answer, or the user's refusal to answer, will arrive as a message in this chat, "+
		"possibly after this turn has ended. If the user answers it in the chat instead, "+
		"call question_cancel with this request_id.", q.RequestID), nil
}

func (e *Executor) questionCancel(ctx context.Context, caller Caller, args json.RawMessage) (string, error) {
	if caller.SessionID == "" {
		return "", errNoCallerSession("question_cancel", noChatToAskIn)
	}

	var params struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	if params.RequestID == "" {
		return "", userErrorf("request_id is required")
	}

	// Asked before the worktree is touched, so that the commonest mistake — an
	// agent quoting a request id it read somewhere rather than one it posted —
	// is answered with what is actually wrong with it rather than with "that is
	// not one of this session's open questions", which is true of a question
	// that is over too.
	// More than one location means a fork left the same question open in both,
	// and the caller withdrawing its own copy is ordinary — so what is refused
	// is a caller that is not among them at all.
	if at := e.sessions.LocateQuestions(params.RequestID); len(at) > 0 && !locatedIn(at, caller.SessionID) {
		// Plural only after a fork, and only for a caller that is neither copy.
		who := "another session"
		if len(at) > 1 {
			who = "other sessions"
		}
		return "", userErrorf("question %s was posted by %s (%s) and only the session that posted a question may withdraw it",
			params.RequestID, who, strings.Join(sessionIDs(at), ", "))
	}

	questions, release, err := e.sessions.ResolveQuestions(caller.Worktree)
	if err != nil {
		return "", err
	}
	defer release()

	if err := questions.CancelQuestion(ctx, caller.SessionID, params.RequestID); err != nil {
		return "", err
	}
	return fmt.Sprintf("Question %s withdrawn. The user is no longer being asked it.", params.RequestID), nil
}

// questionAnswerParams is question_answer's input. Answers and Text are the two
// halves of an answer the record keeps apart (agent.QuestionAnswer), named the
// same here so that what an agent sends and what the transcript holds are one
// shape.
type questionAnswerParams struct {
	RequestID string   `json:"request_id"`
	Answers   []string `json:"answers"`
	Text      string   `json:"text"`
	SessionID string   `json:"session_id"`
}

// questionAnswer answers a question some other agent posted.
//
// Any agent may answer any question but its own, which is the same rule the
// rest of these tools follow: the token already lets a caller move any work
// item, the dangerous things go through permission rather than through
// questions, and whoever has the answer is who should give it. Answering your
// own question is the one refusal, because that is not answering — it is
// withdrawing, badly, and question_cancel is what says so honestly.
//
// It returns only once the answer is with the asking agent, which may mean
// starting its process first (chat.Client.AnswerQuestion).
func (e *Executor) questionAnswer(ctx context.Context, caller Caller, args json.RawMessage) (string, error) {
	if caller.SessionID == "" {
		return "", errNoCallerSession("question_answer", noIdentityToRecord)
	}

	var params questionAnswerParams
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	if params.RequestID == "" {
		return "", userErrorf("request_id is required")
	}

	target, err := e.answerTarget(params)
	if err != nil {
		return "", err
	}
	// Stated as "your own session" rather than "your own question", because the
	// second is not always true: a caller that named its own session_id for
	// somebody else's request id lands here too, and telling it that it posted
	// that question would be a made-up fact. What is refused either way is
	// answering *into* your own session — an answer to your own question is a
	// withdrawal wearing the wrong tool's name, and there is nothing else a
	// question in your own session could be.
	if target.SessionID == caller.SessionID {
		return "", userErrorf("session %s is your own, and an agent may not answer a question in its own session: that would record an answer nobody gave. If it is your question and you no longer need it, withdraw it with question_cancel", target.SessionID)
	}

	// A stopped work has been handed back to a person, and a message into its
	// session starts a turn — so delivering here would set an agent working on
	// work somebody took back, which is the one thing `stopped` exists to
	// prevent. The same rule keeps the engine from telling a stopped parent
	// that a child closed. The question is not lost: it survives the stop, and
	// the user can still answer it.
	w, hasWork, err := e.workStore.FindBySessionID(target.SessionID)
	if err != nil {
		return "", fmt.Errorf("find the work that asked: %w", err)
	}
	if hasWork && w.Status == work.StatusStopped {
		return "", userErrorf("work %s asked that question and is stopped, so an agent's answer would set it running again behind the person who stopped it. Leave it to the user, or restart the work first", w.ID)
	}

	by, err := e.answerer(caller.SessionID)
	if err != nil {
		return "", err
	}

	questions, release, err := e.sessions.ResolveQuestions(target.Worktree)
	if err != nil {
		return "", err
	}
	defer release()

	if err := questions.AnswerQuestion(ctx, target.SessionID, chat.Answer{
		RequestID: params.RequestID,
		Answers:   params.Answers,
		Text:      params.Text,
	}, by); err != nil {
		// Translated rather than passed through: chat's own sentence is written
		// for the person sitting in *that* session — "answer it, or stop the
		// turn, then send" — and an agent reading it from outside would go
		// looking for a permission card that is not its to answer. Nothing was
		// delivered and nothing was recorded, so the question is exactly where
		// it was.
		if errors.Is(err, chat.ErrTurnAwaitingAnswer) {
			return "", userErrorf("the session that asked is held on a permission request nobody has answered yet, and reads nothing else until then, so the answer was not delivered. The question is still waiting: try again later, or leave it to the user")
		}
		return "", err
	}

	// After the delivery, for the reason the WebSocket handler gives: a work
	// whose agent was handed nothing must not have its allowance given back.
	if e.workEngine != nil {
		e.workEngine.HandleAgentAnswer(target.SessionID)
	}

	return fmt.Sprintf("Answer delivered to the session that asked (request_id: %s). It arrives there as a message saying you answered it, not the user, and the question is no longer waiting for anyone.", params.RequestID), nil
}

// answerTarget decides which session's question is being answered.
//
// A request id is usually enough — one question, one session waiting on it —
// and the index is what turns it into a session (worktree.Manager). Two things
// make it not enough, and they are told apart rather than merged:
//
//   - A fork left the same id open in two sessions, both still asking. Nothing
//     here can know which was meant, and answering the wrong one leaves the
//     other asking, so the caller is made to say.
//   - Nothing is waiting on that id anywhere. With no session there is no
//     transcript to read, so the refusal cannot say what became of it — which
//     is why it points at session_id, the one thing that would let it.
func (e *Executor) answerTarget(params questionAnswerParams) (worktree.QuestionLocation, error) {
	at := e.sessions.LocateQuestions(params.RequestID)

	if params.SessionID != "" {
		for _, l := range at {
			if l.SessionID == params.SessionID {
				return l, nil
			}
		}
		// Named a session that is not waiting on this question. Resolved and
		// handed on anyway rather than refused here: the chat client reads that
		// session's transcript and says who resolved it and when, which is the
		// answer the agent actually needs.
		name, err := e.sessions.ResolveSessionWorktree(params.SessionID)
		if err != nil {
			// The only failure this call has is "no such session", and repeating
			// its text would say the same thing twice.
			return worktree.QuestionLocation{}, userErrorf("no session %s: no worktree in this project has one with that id", params.SessionID)
		}
		return worktree.QuestionLocation{SessionID: params.SessionID, Worktree: name}, nil
	}

	switch len(at) {
	case 1:
		return at[0], nil
	case 0:
		return worktree.QuestionLocation{}, userErrorf("question %s is not waiting for an answer in any session: it has been answered, declined or withdrawn, or it was never asked. Pass session_id as well to be told which", params.RequestID)
	default:
		return worktree.QuestionLocation{}, userErrorf("question %s is waiting for an answer in more than one session (%s) — a fork carries a question across with its id — so say which one you are answering with session_id",
			params.RequestID, strings.Join(sessionIDs(at), ", "))
	}
}

// answerer is the identity an answer is recorded under: the work the answering
// agent is running, when it is running one at all.
func (e *Executor) answerer(sessionID string) (agent.QuestionResolver, error) {
	by := agent.QuestionResolver{Kind: agent.ResolverAgent}
	w, found, err := e.workStore.FindBySessionID(sessionID)
	if err != nil {
		return by, fmt.Errorf("find the work answering: %w", err)
	}
	if found {
		by.WorkID, by.Title = w.ID, w.Title
	}
	return by, nil
}

// errNoCallerSession is what the question tools answer a call that arrived
// without a session identity.
//
// There is no id to ask the model for instead, and consequence says why for
// each tool: a question is posted *into the chat of the agent asking it*, and
// an answer is recorded as having come from the agent that gave it. It happens
// when an agent CLI was started by hand rather than by Pockode, which is a real
// way to work and simply has no chat behind it.
func errNoCallerSession(tool, consequence string) error {
	return userErrorf("%s can only be called from a Pockode session: this call arrived without one, so %s", tool, consequence)
}

const (
	noChatToAskIn = "there is no chat to ask the question in"
	// An answer records who gave it, and is delivered saying so; a call with no
	// session behind it has nobody to name.
	noIdentityToRecord = "there is nobody to record as having answered"
)

// locatedIn reports whether sessionID is one of the sessions a question is open
// in.
func locatedIn(at []worktree.QuestionLocation, sessionID string) bool {
	for _, l := range at {
		if l.SessionID == sessionID {
			return true
		}
	}
	return false
}

func sessionIDs(at []worktree.QuestionLocation) []string {
	out := make([]string, 0, len(at))
	for _, l := range at {
		out = append(out, l.SessionID)
	}
	return out
}

func questionSpec(params questionPostParams) (chat.QuestionSpec, error) {
	question := strings.TrimSpace(params.Question)
	header := strings.TrimSpace(params.Header)
	if question == "" {
		return chat.QuestionSpec{}, userErrorf("question is required")
	}
	if header == "" {
		return chat.QuestionSpec{}, userErrorf("header is required: it is the card's title, and a question with no title is one the user cannot tell apart from the others waiting")
	}

	options := make([]session.QuestionOption, 0, len(params.Options))
	seen := make(map[string]struct{}, len(params.Options))
	for _, o := range params.Options {
		label := strings.TrimSpace(o.Label)
		if label == "" {
			return chat.QuestionSpec{}, userErrorf("every option needs a label")
		}
		if _, dup := seen[label]; dup {
			// An answer names the label it picked, so two options wearing one
			// label would make the answer ambiguous — in the transcript the
			// agent reads back, where there is nothing left to disambiguate it
			// with.
			return chat.QuestionSpec{}, userErrorf("two options share the label %q", label)
		}
		seen[label] = struct{}{}
		options = append(options, session.QuestionOption{Label: label, Description: strings.TrimSpace(o.Description)})
	}
	if len(options) == 0 {
		options = nil
		if params.MultiSelect {
			// Refused rather than ignored: a model that asked for multi_select
			// believes it is offering a choice, and silently answering with a
			// free-text box is the kind of quiet disagreement that shows up
			// later as an answer nobody understands.
			return chat.QuestionSpec{}, userErrorf("multi_select needs options to select from; add options, or drop multi_select to ask for free text")
		}
	}

	return chat.QuestionSpec{
		Header:      header,
		Question:    question,
		Options:     options,
		MultiSelect: params.MultiSelect,
	}, nil
}
