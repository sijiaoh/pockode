package work

import (
	"encoding/json"
	"fmt"
	"strings"
)

// toolTargets are Pockode's work tools whose input names the work they act on,
// and the argument that names it. A comment edit is not here: its id names a
// comment, not a work. Neither are the listings of every story or role, which
// act on none.
var toolTargets = map[string]string{
	"task_list":         "story_id",
	"work_get":          "id",
	"work_update":       "id",
	"work_delete":       "id",
	"story_start":       "id",
	"story_unwatch":     "id",
	"task_start":        "id",
	"work_reopen":       "id",
	"story_wait":        "id",
	"step_done":         "id",
	"work_comment_add":  "work_id",
	"work_comment_list": "work_id",
}

// creationTools name no work in their input: the work exists only once the
// call has returned, and its id is in the result (CreateResult).
var creationTools = map[string]bool{
	"story_create": true,
	"task_create":  true,
}

// ToolTarget is the work a call to one of Pockode's work tools acts on, as its
// bare tool name and input say (agent.PockodeTool reads the name off either
// engine's call). A creation answers creates and no id: the id is only in its
// result, for IDFromCreateResult. ok is false for any other tool, and for a
// call whose input names no work.
func ToolTarget(tool string, input json.RawMessage) (id string, creates bool, ok bool) {
	if creationTools[tool] {
		return "", true, true
	}
	field, known := toolTargets[tool]
	if !known {
		return "", false, false
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal(input, &args); err != nil {
		return "", false, false
	}
	if err := json.Unmarshal(args[field], &id); err != nil || id == "" {
		return "", false, false
	}
	return id, false, true
}

// createResultID is what a creation's result ends with, before the id and its
// closing parenthesis.
const createResultID = " (ID: "

// CreateResult is what a creation tool answers: the agent reads the new
// work's id there, and the server reads it back (IDFromCreateResult) to name
// the work on the call's record. The result is the only way the id can travel:
// an MCP call does not carry the CLI's tool call id.
func CreateResult(w Work) string {
	return fmt.Sprintf("Created %s %q%s%s)", w.Type(), w.Title, createResultID, w.ID)
}

// IDFromCreateResult is the id a CreateResult names. It reads from the end,
// since the quoted title before it may hold anything.
func IDFromCreateResult(result string) (string, bool) {
	if !strings.HasPrefix(result, "Created ") {
		return "", false
	}
	rest, ok := strings.CutSuffix(result, ")")
	if !ok {
		return "", false
	}
	at := strings.LastIndex(rest, createResultID)
	if at < 0 {
		return "", false
	}
	id := rest[at+len(createResultID):]
	if id == "" || strings.ContainsAny(id, " ()\"\n") {
		return "", false
	}
	return id, true
}
