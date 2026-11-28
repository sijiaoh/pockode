package session

import "encoding/json"

// testRecord is a history line for this package's own tests, which cannot
// build an agent.Record: agent imports session.
type testRecord map[string]any

func (r testRecord) MarshalJSON() ([]byte, error) { return json.Marshal(map[string]any(r)) }

func (testRecord) HistoryRecord() {}
