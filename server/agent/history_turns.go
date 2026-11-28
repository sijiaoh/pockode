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
	legacy := legacyLines(records)
	if legacy == nil {
		return records
	}

	seqs := session.HistorySeqs(records)
	out := make([]json.RawMessage, 0, len(records))
	var replay *turnReplay
	for i, raw := range records {
		if !legacy[i] {
			// A line written with turns ends the stretch; the warning a
			// damaged file gets, in no file, ends nothing.
			if session.HistoryTurnOf(raw).Tagged() {
				replay = nil
			}
			out = append(out, raw)
			continue
		}
		if replay == nil {
			replay = &turnReplay{straggles: agentType == session.AgentTypeCodex, expired: map[string]session.HistoryTurn{}}
		}
		out = replay.step(out, raw, seqs[i])
	}
	return out
}

// legacyLines says which records need their turn inferred, nil when none do.
//
// A record that is not a message is old exactly when it is untagged: from
// version 3 on, every one is written with a turn or with none. A message is
// untagged in every version, so it goes with the records around it — the
// next one, which is what it was written ahead of, or for a message nothing
// followed, the one before. A record carrying no seq (the warning a damaged
// file gets) is in no file and goes with neither.
func legacyLines(records []json.RawMessage) []bool {
	type kind int
	const (
		notInFile kind = iota
		message
		tagged
		old
	)
	kinds := make([]kind, len(records))
	for i, raw := range records {
		switch {
		case session.HistoryTurnOf(raw).Tagged():
			kinds[i] = tagged
		case isNotInFile(raw):
			kinds[i] = notInFile
		case recordType(raw) == EventTypeMessage:
			kinds[i] = message
		default:
			kinds[i] = old
		}
	}

	// What follows each message, read back to front.
	following := make([]kind, len(records))
	next := notInFile
	for i := len(records) - 1; i >= 0; i-- {
		if kinds[i] == tagged || kinds[i] == old {
			next = kinds[i]
		}
		following[i] = next
	}

	legacy := make([]bool, len(records))
	found := false
	prev := notInFile
	for i, k := range kinds {
		switch k {
		case tagged, old:
			prev = k
		case message:
			k = following[i]
			if k == notInFile {
				k = prev
			}
			if k == notInFile {
				// Nothing but messages: nothing written since turns had ids
				// says otherwise.
				k = old
			}
		}
		legacy[i] = k == old
		found = found || legacy[i]
	}
	if !found {
		return nil
	}
	return legacy
}

func isNotInFile(raw json.RawMessage) bool {
	seqs := session.HistorySeqs([]json.RawMessage{raw})
	return !seqs[0].Valid()
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

func (r *turnReplay) step(out []json.RawMessage, raw json.RawMessage, seq session.HistorySeq) []json.RawMessage {
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
		out = append(out, raw)
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
func (r *turnReplay) turnStarted(in session.TurnInput, transition session.TurnTransition, opener json.RawMessage) json.RawMessage {
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
func tagged(raw json.RawMessage, seq session.HistorySeq, turn session.HistoryTurn) json.RawMessage {
	line, err := session.TaggedHistoryRecord(raw, seq, turn)
	if err != nil {
		return raw
	}
	return line
}

// observedAt is the moment a record carries, if it carries one.
func observedAt(raw json.RawMessage) *time.Time {
	var head struct {
		ObservedAt *time.Time `json:"observed_at"`
	}
	_ = json.Unmarshal(raw, &head)
	return head.ObservedAt
}

// OpenTurnOf is the turn a history leaves open — the one its last record was
// written in, with no ending after it — or "" when it leaves none. records is
// a history in the shape InferHistoryTurns returns, so it is read off the
// recorded turns: the last turn_started names the turn, and what can end it
// is a record tagged with it whose signal ends a turn, or a process_ended,
// which belongs to no turn and ends whichever was open.
//
// Read where a history stops being one process's: a fork's copy, cut while
// the source's turn ran (chat.Client.Fork).
func OpenTurnOf(records []json.RawMessage) string {
	open := ""
	for _, raw := range records {
		rec, err := DecodeRecord(raw)
		if err != nil {
			continue
		}
		if started, ok := rec.(TurnStartedRecord); ok {
			open = started.TurnID
			continue
		}
		if open == "" {
			continue
		}
		in, ok := TurnInputOf(rec)
		if !ok || !in.Signal.EndsTurn() {
			continue
		}
		if in.Signal == session.SignalProcessEnded || session.HistoryTurnOf(raw).ID() == open {
			open = ""
		}
	}
	return open
}
