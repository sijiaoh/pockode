package agent

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/pockode/server/session"
)

// InferHistoryTurns returns a session's history the way a history written with
// turn ids holds it, whatever it was written with: every record but a message
// tagged with the turn it belongs to, and a turn_started in front of each turn.
// records is what session.Reader.GetHistory returns; agentType is the
// session's.
//
// It is the one place turns are worked out for lines written before they had
// ids (format version 2 and earlier, see session.HistoryTurn): a reader that
// needs turns reads them through this and never infers one itself. Nothing is
// written back — the file stays as it was, and a history with nothing to infer
// is returned as it is.
//
// The inference replays the old lines through the rule that tags new ones: the
// same translation of records into signals (TurnInputOf), the same reducer
// (session.ReduceTurn), and the same tagging as chatstream.Sequencer and
// process.recordExpiries. So an inferred turn starts and ends where it would
// have if the session had been recorded today. Two things the lines cannot
// say, and the reading of them:
//
//   - A turn's id. An inferred turn is called "legacy-" and the seq of the
//     record that opened it — the message, the content or the answer — which
//     stays the same on every read, since a history is only ever appended to.
//   - Whether content came after its turn. Claude opens a turn with content
//     nobody prompted (a background subagent waking the session, the answer to
//     a message queued into the turn before), so for Claude content with no
//     turn open opens one — all but a tool result, which for either agent
//     belongs to the turn that ended (session.SignalToolResult). Codex never
//     does — it names every turn before its content, and what comes after an
//     ending is a straggler of the turn that ended (MarkAfterTurn) — so for
//     Codex the same content belongs to that turn. One straggler cannot be
//     told apart: one that lands after the next turn's prompt, which the live
//     flag tags with the turn before and this reads as the new turn's.
//
// A synthesized turn_started is in no file, so it carries session.NoHistorySeq
// like the warning a damaged file gets: HistorySeqs gives it no number, and
// every record keeps the seq it has on disk. Which lines are old is read off
// each line rather than off the file, since one history can hold both: a
// session started before the upgrade, a fork copied from one. A stretch of old
// lines starts with no turn open, because every boundary between versions is a
// server restart, after which nothing is open.
func InferHistoryTurns(records []json.RawMessage, agentType session.AgentType) []json.RawMessage {
	inference := NewTurnInference(agentType)
	var lines []InferredLine
	for _, raw := range records {
		lines = inference.Push(lines, raw)
	}
	lines = inference.finish(lines)
	if !inference.inferred {
		return records
	}
	out := make([]json.RawMessage, len(lines))
	for i, line := range lines {
		out[i] = line.Raw
	}
	return out
}

// InferredLine is one line of a history as InferHistoryTurns returns it, with
// what it worked out about the line alongside.
type InferredLine struct {
	// Raw is the line: as stored, or for a line written before turns had ids,
	// tagged as one written today would be. A synthesized turn_started is a
	// line of its own.
	Raw json.RawMessage
	// Seq is the seq HistorySeqs gives the line; NoHistorySeq for one in no
	// file.
	Seq session.HistorySeq
	// Turn is the turn the line belongs to, as Raw's envelope says it.
	Turn session.HistoryTurn
}

// TurnInference is InferHistoryTurns read one record at a time, for a reader
// handed a history as it grows: pushing a history's records one after another
// and then settling yields exactly what InferHistoryTurns returns for all of
// them, and so does settling after any prefix and pushing the rest into the
// inference as it was before settling.
//
// A message is the one record that cannot be read on arrival: which version
// wrote it is read off the record after it (kindOf), so it is held until
// that record arrives, with any line in no file behind it so that the order
// stays the file's. Settle says what the held lines are if the history ends
// where it does now.
type TurnInference struct {
	straggles bool
	replay    *turnReplay
	// prevSeq is the seq of the newest numbered record pushed.
	prevSeq session.HistorySeq
	// prev is the kind of the newest record that was not a message and was in
	// the file; kindNotInFile before there was one.
	prev lineKind
	held []heldLine
	// inferred says some line was read as old.
	inferred bool
}

type lineKind int

const (
	kindNotInFile lineKind = iota
	kindMessage
	kindTagged
	kindOld
)

type heldLine struct {
	raw  json.RawMessage
	seq  session.HistorySeq
	kind lineKind
}

// NewTurnInference starts the inference of a history written by an agent of
// agentType.
func NewTurnInference(agentType session.AgentType) *TurnInference {
	return &TurnInference{straggles: agentType == session.AgentTypeCodex}
}

// Push reads the next record of the history and appends to out the lines that
// are now settled — none, while the record is a message waiting on what comes
// after it.
func (t *TurnInference) Push(out []InferredLine, raw json.RawMessage) []InferredLine {
	seq := session.NextHistorySeq(t.prevSeq, raw)
	if seq.Valid() {
		t.prevSeq = seq
	}
	kind := kindOf(raw, seq)
	switch kind {
	case kindMessage, kindNotInFile:
		if kind == kindNotInFile && len(t.held) == 0 {
			return append(out, InferredLine{Raw: raw, Seq: seq, Turn: session.HistoryTurnOf(raw)})
		}
		t.held = append(t.held, heldLine{raw: raw, seq: seq, kind: kind})
		return out
	}
	// A message goes with the record it was written ahead of.
	out = t.release(out, kind)
	t.prev = kind
	return t.step(out, raw, seq, kind)
}

// PushWritten is Push for a record this version has just written, which needs
// nothing after it to be read: a message it writes is as untagged as any other
// version's, but it is this version's. So nothing is held behind it, and the
// lines held before it go with it, as they would with the tagged record
// that follows it in the file. A reader folding a history as it is written
// (projection.Live) sees a message the moment it lands rather than when the
// next record does.
func (t *TurnInference) PushWritten(out []InferredLine, raw json.RawMessage) []InferredLine {
	seq := session.NextHistorySeq(t.prevSeq, raw)
	if seq.Valid() {
		t.prevSeq = seq
	}
	kind := kindOf(raw, seq)
	switch kind {
	case kindNotInFile:
		if len(t.held) == 0 {
			return append(out, InferredLine{Raw: raw, Seq: seq, Turn: session.HistoryTurnOf(raw)})
		}
		t.held = append(t.held, heldLine{raw: raw, seq: seq, kind: kind})
		return out
	case kindMessage:
		out = t.release(out, kindTagged)
		return t.step(out, raw, seq, kindTagged)
	}
	out = t.release(out, kind)
	t.prev = kind
	return t.step(out, raw, seq, kind)
}

// Settle appends the lines still held as they read if nothing follows them. The
// inference itself is left as it was, so the history can still be pushed onto.
func (t *TurnInference) Settle(out []InferredLine) []InferredLine {
	if len(t.held) == 0 {
		return out
	}
	return t.clone().finish(out)
}

// finish is Settle for a history that has ended: a message nothing followed
// goes with the record before it, or with none at all — nothing but messages —
// as old.
func (t *TurnInference) finish(out []InferredLine) []InferredLine {
	kind := t.prev
	if kind == kindNotInFile {
		kind = kindOld
	}
	return t.release(out, kind)
}

// release reads the held lines as written by the version kind says.
func (t *TurnInference) release(out []InferredLine, kind lineKind) []InferredLine {
	for _, h := range t.held {
		k := kind
		if h.kind == kindNotInFile {
			k = kindNotInFile
		}
		out = t.step(out, h.raw, h.seq, k)
	}
	t.held = nil
	return out
}

func (t *TurnInference) step(out []InferredLine, raw json.RawMessage, seq session.HistorySeq, kind lineKind) []InferredLine {
	if kind != kindOld {
		// A line written with turns ends the stretch; the warning a damaged
		// file gets, in no file, ends nothing.
		turn := session.HistoryTurnOf(raw)
		if turn.Tagged() {
			t.replay = nil
		}
		return append(out, InferredLine{Raw: raw, Seq: seq, Turn: turn})
	}
	t.inferred = true
	if t.replay == nil {
		t.replay = &turnReplay{straggles: t.straggles, expired: map[string]session.HistoryTurn{}}
	}
	return t.replay.step(out, raw, seq)
}

// clone is a copy of t that pushing into leaves t as it was.
func (t *TurnInference) clone() *TurnInference {
	c := *t
	c.held = append([]heldLine(nil), t.held...)
	if t.replay != nil {
		replay := *t.replay
		replay.expired = make(map[string]session.HistoryTurn, len(t.replay.expired))
		for id, turn := range t.replay.expired {
			replay.expired[id] = turn
		}
		c.replay = &replay
	}
	return &c
}

// kindOf is what a record says about the version that wrote it. A record that
// is not a message is old exactly when it is untagged: from version 3 on, every
// one is written with a turn or with none. A message is untagged in every
// version, so it goes with the records around it — the next one, which is what
// it was written ahead of, or for a message nothing followed, the one before. A
// record carrying no seq (the warning a damaged file gets) is in no file and
// goes with neither.
func kindOf(raw json.RawMessage, seq session.HistorySeq) lineKind {
	switch {
	case session.HistoryTurnOf(raw).Tagged():
		return kindTagged
	case !seq.Valid():
		return kindNotInFile
	case recordType(raw) == EventTypeMessage:
		return kindMessage
	default:
		return kindOld
	}
}

func recordType(raw json.RawMessage) EventType {
	var head struct {
		Type EventType `json:"type"`
	}
	_ = json.Unmarshal(raw, &head)
	return head.Type
}

// turnReplay is one stretch of old lines being read through the reducer.
type turnReplay struct {
	state session.TurnState
	// straggles says content arriving with no turn open belongs to the turn
	// that ended last, rather than opening one: Codex.
	straggles bool
	// expired are the prompts a reduction ended unanswered, by request id, and
	// the turn the expiry Pockode records for each is tagged with
	// (process.recordExpiries).
	expired map[string]session.HistoryTurn
}

func (r *turnReplay) step(out []InferredLine, raw json.RawMessage, seq session.HistorySeq) []InferredLine {
	rec, err := DecodeRecord(raw)
	if err != nil {
		// A type this build has no name for moves no turn; like any such
		// record it belongs to the turn that is open.
		return append(out, tagged(raw, seq, r.openTurn()))
	}

	var in session.TurnInput
	switch rec := rec.(type) {
	case MessageRecord:
		// Written before the prompt is reduced, and never tagged: the
		// turn_started after it says whether it opened its turn.
		out = append(out, InferredLine{Raw: raw, Seq: seq})
		in = session.TurnInput{Signal: session.SignalPrompt, MessageID: rec.MessageID}
		transition := r.reduce(in, seq)
		if transition.Started {
			out = append(out, r.turnStarted(in, transition, raw))
		}
		return out
	case PermissionResponseRecord:
		in = session.TurnInput{Signal: session.SignalAnswered, RequestID: rec.RequestID}
	case QuestionResponseRecord:
		in = session.TurnInput{Signal: session.SignalAnswered, RequestID: rec.RequestID}
	case RequestCancelledRecord:
		if turn, ok := r.expired[rec.RequestID]; ok {
			// Pockode's record of a prompt an earlier reduction expired, not
			// the agent withdrawing one: it moves nothing, and belongs where
			// that reduction left it.
			delete(r.expired, rec.RequestID)
			return append(out, tagged(raw, seq, turn))
		}
		in, _ = TurnInputOf(rec)
	default:
		var ok bool
		if in, ok = TurnInputOf(rec); !ok {
			return append(out, tagged(raw, seq, r.openTurn()))
		}
		if in.Signal.IsContent() && r.straggles && !r.state.Open {
			in.Signal, in.AfterTurn = session.SignalNoise, true
		}
	}

	if in.Signal == session.SignalPermissionRaised {
		// A request id is only unique within its process (Codex's fallback
		// ids restart with each one), so a new raise is never an old expiry.
		delete(r.expired, in.RequestID)
	}
	transition := r.reduce(in, seq)
	if transition.Started {
		out = append(out, r.turnStarted(in, transition, raw))
	}
	turn := session.InTurn(transition.Turn)
	if in.Signal == session.SignalProcessEnded {
		turn = session.NoTurn
	}
	return append(out, tagged(raw, seq, turn))
}

// reduce applies in as the record at seq caused it, and notes the prompts it
// expired. No moment goes with it: the state's clocks are never read out of a
// replay, and the one moment that is — when a turn opened — is the opening
// record's own (turnStarted).
func (r *turnReplay) reduce(in session.TurnInput, seq session.HistorySeq) session.TurnTransition {
	in.TurnID = "legacy-" + strconv.Itoa(int(seq))
	transition := session.ReduceTurn(r.state, in)
	r.state = transition.State

	expiry := session.InTurn(transition.Turn)
	if transition.Started || !transition.State.Open {
		expiry = session.NoTurn
	}
	for _, blocker := range transition.Expired {
		if blocker.RequestID != "" {
			r.expired[blocker.RequestID] = expiry
		}
	}
	return transition
}

// turnStarted is the record chatstream.Sequencer.Advance writes for a turn in
// opened.
func (r *turnReplay) turnStarted(in session.TurnInput, transition session.TurnTransition, opener json.RawMessage) InferredLine {
	started := TurnStartedRecord{
		TurnID:     transition.Turn,
		Origin:     TurnOriginOutput,
		ObservedAt: observedAt(opener),
	}
	switch in.Signal {
	case session.SignalPrompt:
		started.Origin, started.MessageID = TurnOriginPrompt, in.MessageID
	case session.SignalAnswered:
		started.Origin = TurnOriginAnswer
	}
	// Marshaling a record of strings and a time cannot fail.
	raw, _ := json.Marshal(started)
	return tagged(raw, session.NoHistorySeq, session.InTurn(transition.Turn))
}

func (r *turnReplay) openTurn() session.HistoryTurn {
	return session.InTurn(r.state.TurnID)
}

// tagged is raw as a line of the current version under seq and turn. A line
// that cannot hold an envelope — not a JSON object, which nothing can read as
// a record either — is returned as it is.
func tagged(raw json.RawMessage, seq session.HistorySeq, turn session.HistoryTurn) InferredLine {
	line, err := session.TaggedHistoryRecord(raw, seq, turn)
	if err != nil {
		return InferredLine{Raw: raw, Seq: seq}
	}
	return InferredLine{Raw: line, Seq: seq, Turn: turn}
}

// observedAt is the moment a record carries, if it carries one.
func observedAt(raw json.RawMessage) *time.Time {
	var head struct {
		ObservedAt *time.Time `json:"observed_at"`
	}
	_ = json.Unmarshal(raw, &head)
	return head.ObservedAt
}
