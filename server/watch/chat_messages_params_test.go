package watch

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// TestNotifyParams_FlattenTheRecord: a chat notification is one flat object —
// routing first, then the record's own fields — as it was when the record was
// an embedded struct. A live event carries no seq, having no record to name.
func TestNotifyParams_FlattenTheRecord(t *testing.T) {
	tests := []struct {
		name   string
		params notifyParams
		want   string
	}{
		{
			name:   "record",
			params: notifyParams{ID: "sub", Seq: session.HistorySeq(3), Event: agent.TextRecord{Content: "hi"}},
			want:   `{"id":"sub","seq":3,"type":"text","content":"hi"}`,
		},
		{
			name:   "record with no fields of its own",
			params: notifyParams{ID: "sub", Seq: session.HistorySeq(4), Event: agent.BackgroundWaitRecord{}},
			want:   `{"id":"sub","seq":4,"type":"background_wait"}`,
		},
		{
			name:   "live event",
			params: notifyParams{ID: "sub", Seq: session.NoHistorySeq, Event: agent.ThinkingDeltaLiveEvent{ContentDelta: "a"}},
			want:   `{"id":"sub","type":"thinking_delta","content_delta":"a"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := json.Marshal(tt.params)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

// TestNotifyParams_RoutingKeysAreNotWireFields holds what MarshalJSON relies on:
// a wire type with an "id" or "seq" of its own would put the key in the
// notification twice.
func TestNotifyParams_RoutingKeysAreNotWireFields(t *testing.T) {
	for _, w := range agent.WireTypes() {
		typ := reflect.TypeOf(w)
		for i := 0; i < typ.NumField(); i++ {
			name, _, _ := strings.Cut(typ.Field(i).Tag.Get("json"), ",")
			if name == "id" || name == "seq" {
				t.Errorf("%s has a field %q, which the notification's routing uses", typ.Name(), name)
			}
		}
	}
}
