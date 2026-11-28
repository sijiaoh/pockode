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
const historyFormatVersion = 2

// envelopePrefix is how every line this version writes begins. Reading a stored
// seq off it is a prefix match rather than a parse of the whole record, which
// matters because every record's seq is read each time a history is paged.
var envelopePrefix = []byte(`{"seq":`)

var versionField = []byte(`,"v":`)

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
		stored, ok := storedSeq(raw)
		switch {
		case ok && stored == NoHistorySeq:
			seqs[i] = NoHistorySeq
			continue
		case ok && stored > prev:
			seqs[i] = stored
		default:
			seqs[i] = prev + 1
		}
		prev = seqs[i]
	}
	return seqs
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
	if seq, _, ok := splitEnvelope(raw); ok {
		return seq, true
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

// splitEnvelope takes apart a line that begins the way this version writes one:
// its seq, and the record after the envelope as a JSON object of its own.
func splitEnvelope(raw []byte) (seq HistorySeq, record []byte, ok bool) {
	if !bytes.HasPrefix(raw, envelopePrefix) {
		return NoHistorySeq, nil, false
	}
	pos := len(envelopePrefix)
	n, width := leadingDigits(raw[pos:])
	if width == 0 {
		return NoHistorySeq, nil, false
	}
	pos += width
	if bytes.HasPrefix(raw[pos:], versionField) {
		_, vWidth := leadingDigits(raw[pos+len(versionField):])
		if vWidth == 0 {
			return NoHistorySeq, nil, false
		}
		pos += len(versionField) + vWidth
	}
	if pos >= len(raw) {
		return NoHistorySeq, nil, false
	}
	switch raw[pos] {
	case '}':
		return HistorySeq(n), []byte("{}"), true
	case ',':
		record = make([]byte, 0, len(raw)-pos)
		record = append(record, '{')
		return HistorySeq(n), append(record, raw[pos+1:]...), true
	default:
		return NoHistorySeq, nil, false
	}
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

// encodeHistoryLine puts record into the envelope under seq: the line
// AppendToHistory and WriteHistory write. record must be compact JSON.
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
func encodeHistoryLine(record []byte, seq HistorySeq) ([]byte, error) {
	return wrapRecord(record, `{"seq":`+strconv.Itoa(int(seq))+`,"v":`+strconv.Itoa(historyFormatVersion))
}

// encodeWireRecord is the record as a client is sent it: its seq and its own
// fields. The format version is the file's business, not the event's.
func encodeWireRecord(record []byte, seq HistorySeq) ([]byte, error) {
	return wrapRecord(record, `{"seq":`+strconv.Itoa(int(seq)))
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

// withoutEnvelope returns the record an object line holds, without the seq and
// version a line may already carry.
func withoutEnvelope(line []byte) ([]byte, error) {
	if _, record, ok := splitEnvelope(line); ok {
		// Written by this version, which puts seq and v nowhere else: a "seq"
		// or "v" further in belongs to the record (a tool's input, say).
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
