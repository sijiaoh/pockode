package session

import (
	"bytes"
	"encoding/json"
	"strconv"
)

// historyFormatVersion is the format a line of history.jsonl is written in,
// stored on the line as "v". A line without one is version 1: the flat record
// alone, written before records carried their own seq.
//
// Version 2 is the version-1 record with an envelope in front of it —
// {"seq":N,"v":2, followed by the record's own fields — and nothing else
// changed, so every line is still a version-1 record to a reader that ignores
// the two fields: a downgraded server, or anything else that reads the file.
//
// Version 3 adds the turn the record belongs to, as a third envelope field
// after "v" (see HistoryTurn). A version-2 line says nothing about turns: it
// was written before turns had ids, and which turn it belongs to has to be
// inferred.
const historyFormatVersion = 3

// envelopePrefix is how every line this version writes begins. Reading a stored
// seq off it is a prefix match rather than a parse of the whole record, which
// matters because every record's seq is read each time a history is paged.
var envelopePrefix = []byte(`{"seq":`)

var versionField = []byte(`,"v":`)

var turnField = []byte(`,"turn":`)

var jsonNull = []byte(`null`)

// HistoryTurn is which turn a history record belongs to, as its envelope says.
// It has three values, and the third is why it is not a plain string:
//
//   - InTurn(id): written while the turn with this id was open, the ending
//     of that turn, or a straggler reported after that ending: content Codex
//     flagged (TurnInput.AfterTurn), or a tool result (SignalToolResult);
//   - NoTurn: written while no turn was open — a second ending Claude writes
//     for one Stop, process_ended, a prompt's expiry after its turn ended —
//     stored as "turn":null;
//   - the zero value, untagged: the line says nothing. Every line written
//     before version 3, and every message record: a message is written before
//     anyone knows whether it opens a turn, so its membership is said by the
//     turn_started record that names it, not by the message. What a line
//     written before version 3 leaves unsaid is inferred on read, in one
//     place: agent.InferHistoryTurns.
type HistoryTurn struct {
	id     string
	tagged bool
}

// InTurn is the tag of a record that belongs to the turn with this id. An
// empty id is NoTurn: there is no turn without one.
func InTurn(id string) HistoryTurn {
	return HistoryTurn{id: id, tagged: true}
}

// NoTurn is the tag of a record that belongs to no turn.
var NoTurn = HistoryTurn{tagged: true}

// ID is the turn's id, empty for NoTurn and for an untagged record.
func (t HistoryTurn) ID() string { return t.id }

// Tagged reports whether the record says which turn it belongs to — a turn or
// none. False for a line written before turns had ids, and for a message.
func (t HistoryTurn) Tagged() bool { return t.tagged }

// HistoryTurnOf reads the turn a stored record is tagged with. Untagged for
// anything this version's envelope does not lead with.
func HistoryTurnOf(raw []byte) HistoryTurn {
	if env, _, ok := splitEnvelope(raw); ok {
		return env.turn
	}
	return HistoryTurn{}
}

// HistorySeqs returns the sequence number of each record, in the order given:
// records as GetHistory returns them, or lines as they were read off disk.
//
// A record carrying a seq has that one. A record without — one written before
// seqs were stored, or by a server downgraded since — is numbered one past the
// record before it, so a file written entirely without them numbers exactly as
// positions did, which keeps the seqs clients already hold naming the same
// records. A file whose old records were followed by new ones numbers the new
// ones after the old, because the store seeded its counter from what is there.
//
// The result is always increasing: a stored seq that is not past the one
// before it cannot be honoured without breaking that, so it is numbered as if
// absent. Only a file edited by hand or written by something else gets one.
//
// A seq of NoHistorySeq is kept: it is what a record the store synthesized
// carries to say it is not in the file (historyWarning), and it takes no
// number.
func HistorySeqs(records []json.RawMessage) []HistorySeq {
	seqs := make([]HistorySeq, len(records))
	prev := NoHistorySeq
	for i, raw := range records {
		seqs[i] = NextHistorySeq(prev, raw)
		if seqs[i].Valid() {
			prev = seqs[i]
		}
	}
	return seqs
}

// NextHistorySeq is the seq HistorySeqs gives raw when the numbered record
// before it has prev (NoHistorySeq for none): HistorySeqs one record at a time,
// for a reader that is handed a history as it grows.
func NextHistorySeq(prev HistorySeq, raw json.RawMessage) HistorySeq {
	stored, ok := storedSeq(raw)
	switch {
	case ok && stored == NoHistorySeq:
		return NoHistorySeq
	case ok && stored > prev:
		return stored
	default:
		return prev + 1
	}
}

// lastHistorySeq is the seq the newest numbered record has, or NoHistorySeq for
// a history with none.
func lastHistorySeq(seqs []HistorySeq) HistorySeq {
	for i := len(seqs) - 1; i >= 0; i-- {
		if seqs[i].Valid() {
			return seqs[i]
		}
	}
	return NoHistorySeq
}

// FindHistorySeq returns the index of the record seq names in records, as
// HistorySeqs numbers them. A seq can fall in a gap — appends are not fsynced,
// so a power loss can take records a client was already told about — and then
// names nothing.
func FindHistorySeq(records []json.RawMessage, seq HistorySeq) (int, bool) {
	if !seq.Valid() {
		return 0, false
	}
	for i, s := range HistorySeqs(records) {
		if s == seq {
			return i, true
		}
	}
	return 0, false
}

// storedSeq reads the seq a record carries, if it carries one.
func storedSeq(raw []byte) (HistorySeq, bool) {
	if env, _, ok := splitEnvelope(raw); ok {
		return env.seq, true
	}
	// Only a line this version did not write gets past here: a version-1
	// record, nearly always, which almost never holds the bytes "seq" in
	// quotes — inside a string value they are escaped — so the parse below is
	// for the rare line that does.
	if !bytes.Contains(raw, []byte(`"seq"`)) {
		return NoHistorySeq, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return NoHistorySeq, false
	}
	value, ok := fields["seq"]
	if !ok {
		return NoHistorySeq, false
	}
	n, err := strconv.Atoi(string(value))
	if err != nil {
		return NoHistorySeq, false
	}
	return HistorySeq(n), true
}

// envelope is what a line this version writes carries in front of the record.
type envelope struct {
	seq  HistorySeq
	turn HistoryTurn
}

// splitEnvelope takes apart a line that begins the way this version writes one:
// its envelope, and the record after it as a JSON object of its own. Lines of
// version 2 split too, untagged.
func splitEnvelope(raw []byte) (env envelope, record []byte, ok bool) {
	if !bytes.HasPrefix(raw, envelopePrefix) {
		return envelope{}, nil, false
	}
	pos := len(envelopePrefix)
	n, width := leadingDigits(raw[pos:])
	if width == 0 {
		return envelope{}, nil, false
	}
	env.seq = HistorySeq(n)
	pos += width
	if bytes.HasPrefix(raw[pos:], versionField) {
		_, vWidth := leadingDigits(raw[pos+len(versionField):])
		if vWidth == 0 {
			return envelope{}, nil, false
		}
		pos += len(versionField) + vWidth
		if bytes.HasPrefix(raw[pos:], turnField) {
			turn, tWidth := leadingTurn(raw[pos+len(turnField):])
			if tWidth == 0 {
				return envelope{}, nil, false
			}
			env.turn = turn
			pos += len(turnField) + tWidth
		}
	}
	if pos >= len(raw) {
		return envelope{}, nil, false
	}
	switch raw[pos] {
	case '}':
		return env, []byte("{}"), true
	case ',':
		record = make([]byte, 0, len(raw)-pos)
		record = append(record, '{')
		return env, append(record, raw[pos+1:]...), true
	default:
		return envelope{}, nil, false
	}
}

// leadingTurn parses the turn value b starts with — null, or a JSON string —
// and reports how many bytes it took; zero when b does not start with one.
func leadingTurn(b []byte) (HistoryTurn, int) {
	if bytes.HasPrefix(b, jsonNull) {
		return NoTurn, len(jsonNull)
	}
	if len(b) == 0 || b[0] != '"' {
		return HistoryTurn{}, 0
	}
	for i := 1; i < len(b); i++ {
		switch b[i] {
		case '\\':
			i++
		case '"':
			var id string
			if err := json.Unmarshal(b[:i+1], &id); err != nil || id == "" {
				return HistoryTurn{}, 0
			}
			return InTurn(id), i + 1
		}
	}
	return HistoryTurn{}, 0
}

// leadingDigits parses the unsigned decimal integer b starts with and reports
// how many bytes it took; zero when b does not start with one this can hold.
func leadingDigits(b []byte) (int, int) {
	const maxDigits = 18 // stays inside an int64
	n, i := 0, 0
	for i < len(b) && i < maxDigits && b[i] >= '0' && b[i] <= '9' {
		n = n*10 + int(b[i]-'0')
		i++
	}
	if i < len(b) && b[i] >= '0' && b[i] <= '9' {
		return 0, 0
	}
	return n, i
}

// encodeHistoryLine puts record into the envelope under seq and turn: the line
// AppendToHistory and WriteHistory write. record must be compact JSON. An
// untagged turn writes no turn field at all.
//
// A record that already carries an envelope — one copied out of another
// session's history, which is how a fork is made — is given the new seq in
// place of its old one: a seq is an address in one session, and the copy is a
// different session.
//
// A record that is not a JSON object has nowhere to hold an envelope and is
// returned as it is. It still takes a number, because HistorySeqs numbers a
// line without a seq one past the line before it, which is where it was
// written.
func encodeHistoryLine(record []byte, seq HistorySeq, turn HistoryTurn) ([]byte, error) {
	head := `{"seq":` + strconv.Itoa(int(seq)) + `,"v":` + strconv.Itoa(historyFormatVersion)
	switch {
	case !turn.tagged:
	case turn.id == "":
		head += string(turnField) + string(jsonNull)
	default:
		// Marshaling a string cannot fail.
		id, _ := json.Marshal(turn.id)
		head += string(turnField) + string(id)
	}
	return wrapRecord(record, head)
}

// TaggedHistoryRecord is record as a line of this version would hold it under
// seq and turn, for a reader that works out what an older line left unsaid
// (agent.InferHistoryTurns): the result reads back through HistorySeqs and
// HistoryTurnOf as if it had been written that way. It is never written to a
// file — a history is not rewritten when it is read.
func TaggedHistoryRecord(record json.RawMessage, seq HistorySeq, turn HistoryTurn) (json.RawMessage, error) {
	return encodeHistoryLine(record, seq, turn)
}

// wrapRecord replaces whatever envelope record has with head, an object's
// opening brace and its first fields.
func wrapRecord(record []byte, head string) ([]byte, error) {
	if len(record) == 0 || record[0] != '{' {
		return record, nil
	}
	body, err := withoutEnvelope(record)
	if err != nil {
		return nil, err
	}

	line := make([]byte, 0, len(head)+len(body))
	line = append(line, head...)
	if len(body) > 2 { // not "{}"
		line = append(line, ',')
		return append(line, body[1:]...), nil
	}
	return append(line, '}'), nil
}

// withoutEnvelope returns the record an object line holds, without the seq,
// version and turn a line may already carry.
func withoutEnvelope(line []byte) ([]byte, error) {
	if _, record, ok := splitEnvelope(line); ok {
		// Written by this version, which puts seq, v and turn nowhere else: a
		// "seq" or "v" further in belongs to the record (a tool's input, say).
		return record, nil
	}
	if !bytes.Contains(line, []byte(`"seq"`)) && !bytes.Contains(line, []byte(`"v"`)) {
		return line, nil
	}
	// Not in front — a line a downgraded server stamped on
	// its way out and then copied into a fork — or merely the bytes inside a
	// value. Rare, so the record is rebuilt rather than spliced.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(line, &fields); err != nil {
		return nil, err
	}
	_, hasSeq := fields["seq"]
	_, hasVersion := fields["v"]
	if !hasSeq && !hasVersion {
		return line, nil
	}
	delete(fields, "seq")
	delete(fields, "v")
	return json.Marshal(fields)
}
