package rpc

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/work"
)

// A work item's usage is an aggregation over its whole subtree. The list result
// carries work.Work for every work item in the app, so that shape must never
// grow a usage field — putting one there would make opening the list aggregate
// every tree in it.
func TestWorkListCarriesNoUsage(t *testing.T) {
	items, err := json.Marshal(WorkListSubscribeResult{Items: []work.Work{
		{ID: "w1", Title: "Some story", SessionID: "sess-1"},
	}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, unwanted := range []string{"usage", "input_tokens", "cost_usd", "descendant_count"} {
		if strings.Contains(string(items), unwanted) {
			t.Errorf("list row mentions %q: %s", unwanted, items)
		}
	}
}

// The detail result is where it lives, and every field the client needs to
// display it honestly has to be there — including the two counts it cannot
// derive: how many work items the total covers, and how many of them spent
// tokens for a price nobody reported.
func TestWorkDetailCarriesUsage(t *testing.T) {
	cost := 3.87
	result, err := json.Marshal(WorkDetailSubscribeResult{
		Work: work.Work{ID: "w1"},
		Usage: work.Usage{
			Own:                  &work.UsageTotals{CostUSD: &cost},
			Total:                &work.UsageTotals{CostUSD: &cost},
			DescendantCount:      5,
			UnpricedSessionCount: 2,
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, want := range []string{
		`"own"`, `"total"`, `"cost_usd"`, `"input_tokens"`, `"output_tokens"`,
		`"cache_read_tokens"`, `"cache_write_tokens"`,
		`"descendant_count":5`, `"unpriced_session_count":2`,
	} {
		if !strings.Contains(string(result), want) {
			t.Errorf("detail result is missing %s: %s", want, result)
		}
	}

	// A context window is one live conversation's property; there is no such
	// thing as a subtree's.
	if strings.Contains(string(result), "context_") {
		t.Errorf("work usage carries context state: %s", result)
	}
}

// descendant_count decides whether the client shows a total at all, so it has to
// arrive even when it is zero — omitting it would make "this work item has no
// children" indistinguishable from an older server that never sent it.
func TestWorkDetailAlwaysCarriesDescendantCount(t *testing.T) {
	result, err := json.Marshal(WorkDetailSubscribeResult{Work: work.Work{ID: "w1"}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(result), `"descendant_count":0`) {
		t.Errorf("detail result omits descendant_count: %s", result)
	}
}
