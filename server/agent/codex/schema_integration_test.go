//go:build integration

package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pockode/server/agent"
)

// TestIntegration_ProtocolSchemaStillFitsWhatWeSend is the drift check the
// package comment promises.
//
// app-server is marked [experimental], and what makes that acceptable is that
// the protocol is machine-checkable: the CLI generates its own JSON schema, so a
// field that moves can be caught rather than waited for. Nothing was enforcing
// that, which left the promise resting on somebody remembering to diff.
//
// It asserts the shapes this package actually depends on, not the whole
// protocol. A schema that grows is not drift — new methods, new optional fields
// and new item types all arrive constantly and none of them breaks a session.
// What breaks one is a field we send disappearing, a field we read stopping
// being required, or a variant we switch on gaining a case we would silently
// drop. Those are what is checked.
//
// It costs no tokens: generation is local and never reaches a model. It lives
// behind the integration tag only because it needs the CLI installed.
func TestIntegration_ProtocolSchemaStillFitsWhatWeSend(t *testing.T) {
	dir := generateSchemas(t)

	t.Run("thread/start carries the session's settings", func(t *testing.T) {
		props := schemaProperties(t, dir, "ThreadStartParams")
		// buildThreadParams sends these, and startThread adds threadSource.
		requireProps(t, props, "ThreadStartParams", "buildThreadParams and startThread send",
			"cwd", "config", "model", "approvalPolicy", "sandbox", "threadSource")
	})

	t.Run("thread/resume reopens by id without hydrating", func(t *testing.T) {
		props := schemaProperties(t, dir, "ThreadResumeParams")
		requireProps(t, props, "ThreadResumeParams", "resumeThread sends",
			"threadId", "cwd", "config", "model", "approvalPolicy", "sandbox", "excludeTurns")
		requireRequired(t, dir, "ThreadResumeParams", "threadId")
	})

	t.Run("thread/fork still anchors on lastTurnId", func(t *testing.T) {
		props := schemaProperties(t, dir, "ThreadForkParams")
		// The one that matters most: forkThread has no second way to cut a
		// conversation, so losing this turns every fork into a new thread.
		requireProps(t, props, "ThreadForkParams", "forkThread sends",
			"threadId", "lastTurnId", "excludeTurns", "threadSource", "cwd")
		requireRequired(t, dir, "ThreadForkParams", "threadId")
	})

	t.Run("turn/interrupt names the thread and the turn", func(t *testing.T) {
		requireRequired(t, dir, "TurnInterruptParams", "threadId", "turnId")
	})

	t.Run("turn/start takes the prompt on the thread", func(t *testing.T) {
		requireRequired(t, dir, "TurnStartParams", "threadId", "input")
	})

	// The two halves of the read point's id: Pockode sends its own id for the
	// message with the turn, and Codex echoes it back on the userMessage item it
	// emits when it takes the message in. The boundary itself survives losing
	// them — it is where the record sits — but nothing would then say *which* of
	// several messages queued into one turn each boundary belongs to, which is
	// the one question position cannot answer. See agent.MessageIngestedEvent.
	t.Run("a message can be sent with an id that comes back on the echo", func(t *testing.T) {
		props := schemaProperties(t, dir, "TurnStartParams")
		requireProps(t, props, "TurnStartParams", "SendMessage sends", "clientUserMessageId")
		requireItemVariantProps(t, dir, "userMessage", "clientId")
	})

	// The fork anchor is only as good as the turn id the events are stamped
	// with, and that is read off the notification envelope rather than the item.
	// It stopping being required would mean stamping empty ids on records that
	// can then never anchor a fork — silently, since an item without one is
	// indistinguishable from one outside a turn.
	t.Run("item notifications still carry a required turnId", func(t *testing.T) {
		for _, name := range []string{"ItemStartedNotification", "ItemCompletedNotification"} {
			requireRequiredIn(t, dir, "codex_app_server_protocol.v2.schemas.json", name, "item", "turnId")
		}
	})

	// approvalResult sends exactly these, and cancelPendingApprovals depends on
	// cancel meaning "refuse and end the turn".
	t.Run("approval decisions are the four we send", func(t *testing.T) {
		got := enumVariants(t, dir, "codex_app_server_protocol.schemas.json", "FileChangeApprovalDecision")
		want := map[string]bool{
			decisionAccept: true, decisionAcceptForSession: true,
			decisionDecline: true, decisionCancel: true,
		}
		for _, d := range []string{decisionAccept, decisionAcceptForSession, decisionDecline, decisionCancel} {
			if !got[d] {
				t.Errorf("FileChangeApprovalDecision no longer offers %q, which approvalResult sends", d)
			}
		}
		for d := range got {
			if !want[d] {
				t.Logf("note: FileChangeApprovalDecision gained %q, which Pockode never sends", d)
			}
		}
	})

	// The image an agent says it looked at is read off this one field, and the
	// item carries nothing else to fall back on. Losing it would turn every
	// Codex image in the transcript into a silently empty row.
	t.Run("an imageView item still names its path", func(t *testing.T) {
		requireItemVariant(t, dir, "imageView", "path")
	})

	// The only account of a command while it runs, and a one-line status from an
	// MCP tool. Both are forwarded as activity on the call, so a renamed field
	// would leave a long-running row silent rather than fail anywhere.
	t.Run("live progress notifications still carry what is forwarded", func(t *testing.T) {
		requireRequiredIn(t, dir, "codex_app_server_protocol.v2.schemas.json",
			"CommandExecutionOutputDeltaNotification", "itemId", "delta")
		requireRequiredIn(t, dir, "codex_app_server_protocol.v2.schemas.json",
			"McpToolCallProgressNotification", "itemId", "message")
	})

	// Codex's own parse of a command, carried into the call's input because it
	// is a better source for a row's title than re-guessing from the command
	// string. Required today, which is what lets item/started carry it.
	t.Run("a commandExecution still parses its own command", func(t *testing.T) {
		requireItemVariant(t, dir, "commandExecution", "command", "commandActions")
	})

	// handleRequestUserInput answers every question with the refusal text, and
	// this is the shape it has to fit: a map of question id to a list of answer
	// strings, and a `questions` array whose entries are identified by `id`. The
	// tool is EXPERIMENTAL, which is exactly why it is pinned here — a renamed
	// field would leave the refusal unreadable and the turn waiting on an answer
	// that never comes, with nothing else in the session saying so.
	t.Run("requestUserInput still answers by question id", func(t *testing.T) {
		requireRequired(t, dir, "ToolRequestUserInputResponse.json", "answers")
		answer := schemaDefinition(t, dir, "ToolRequestUserInputResponse.json", "ToolRequestUserInputAnswer")
		assertRequired(t, "ToolRequestUserInputAnswer", jsonStrings(answer["required"]), []string{"answers"})

		requireRequired(t, dir, "ToolRequestUserInputParams.json", "questions")
		question := schemaDefinition(t, dir, "ToolRequestUserInputParams.json", "ToolRequestUserInputQuestion")
		assertRequired(t, "ToolRequestUserInputQuestion", jsonStrings(question["required"]), []string{"id"})
	})

	// web/src/lib/codexChanges.ts renders exactly these three and shows
	// "Unsupported change type" for anything else, so a fourth would reach the
	// user as a blank row in an approval prompt.
	t.Run("patch change kinds are the three the frontend renders", func(t *testing.T) {
		got := oneOfTypes(t, dir, "codex_app_server_protocol.v2.schemas.json", "PatchChangeKind")
		want := []string{"add", "delete", "update"}
		if len(got) != len(want) {
			t.Errorf("PatchChangeKind = %v, want exactly %v; web/src/lib/codexChanges.ts renders only those",
				got, want)
		}
		for _, k := range want {
			if !containsString(got, k) {
				t.Errorf("PatchChangeKind no longer offers %q", k)
			}
		}
	})
}

// requireItemVariant finds the ThreadItem branch with the given `type` and
// asserts the fields handleItemCompleted's case for it reads are still
// required.
func requireItemVariant(t *testing.T, dir, itemType string, required ...string) {
	t.Helper()
	for _, branch := range schemaBranches(t, dir, "codex_app_server_protocol.v2.schemas.json", "ThreadItem") {
		props, _ := branch["properties"].(map[string]interface{})
		disc, _ := props["type"].(map[string]interface{})
		if !containsString(jsonStrings(disc["enum"]), itemType) {
			continue
		}
		assertRequired(t, itemType, jsonStrings(branch["required"]), required)
		return
	}
	t.Fatalf("ThreadItem no longer has a %q variant, which this package handles", itemType)
}

// requireItemVariantProps asserts the ThreadItem branch with the given `type`
// still offers the fields this package reads off it. Separate from
// requireItemVariant because an optional field is not in `required` and is no
// less load-bearing for it.
func requireItemVariantProps(t *testing.T, dir, itemType string, props ...string) {
	t.Helper()
	for _, branch := range schemaBranches(t, dir, "codex_app_server_protocol.v2.schemas.json", "ThreadItem") {
		properties, _ := branch["properties"].(map[string]interface{})
		disc, _ := properties["type"].(map[string]interface{})
		if !containsString(jsonStrings(disc["enum"]), itemType) {
			continue
		}
		requireProps(t, properties, itemType, "this package reads", props...)
		return
	}
	t.Fatalf("ThreadItem no longer has a %q variant, which this package handles", itemType)
}

// generateSchemas asks the installed CLI for its own protocol schema.
func generateSchemas(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cmd, err := agent.CommandContext(ctx, Binary,
		appServerSubcommand, "generate-json-schema", "--out", dir, "--experimental")
	if err != nil {
		t.Fatalf("build the schema command: %v", err)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("generate the protocol schema: %v\n%s", err, out)
	}
	return dir
}

// schemaOf reads one generated schema file. The per-type files sit under v2/;
// the shared definitions live in the bundles at the top.
func schemaOf(t *testing.T, dir, name string) map[string]interface{} {
	t.Helper()
	path := filepath.Join(dir, "v2", name+".json")
	if filepath.Ext(name) == ".json" {
		path = filepath.Join(dir, name)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return parsed
}

// definition finds a named definition inside one of the bundled schema files.
func schemaDefinition(t *testing.T, dir, file, name string) map[string]interface{} {
	t.Helper()
	defs, _ := schemaOf(t, dir, file)["definitions"].(map[string]interface{})
	def, ok := defs[name].(map[string]interface{})
	if !ok {
		t.Fatalf("%s no longer defines %s", file, name)
	}
	return def
}

func schemaProperties(t *testing.T, dir, name string) map[string]interface{} {
	t.Helper()
	props, _ := schemaOf(t, dir, name)["properties"].(map[string]interface{})
	return props
}

func requireProps(t *testing.T, props map[string]interface{}, owner, sender string, names ...string) {
	t.Helper()
	for _, n := range names {
		if _, ok := props[n]; !ok {
			t.Errorf("%s no longer accepts %q, which %s", owner, n, sender)
		}
	}
}

func requireRequired(t *testing.T, dir, name string, names ...string) {
	t.Helper()
	assertRequired(t, name, jsonStrings(schemaOf(t, dir, name)["required"]), names)
}

func requireRequiredIn(t *testing.T, dir, file, name string, names ...string) {
	t.Helper()
	assertRequired(t, name, jsonStrings(schemaDefinition(t, dir, file, name)["required"]), names)
}

func assertRequired(t *testing.T, owner string, required, names []string) {
	t.Helper()
	for _, n := range names {
		if !containsString(required, n) {
			t.Errorf("%s.%s is no longer required (required = %v)", owner, n, required)
		}
	}
}

// enumVariants collects the values of a oneOf whose branches are each a string
// enum, which is how the CLI renders a Rust enum with per-variant docs.
func enumVariants(t *testing.T, dir, file, name string) map[string]bool {
	t.Helper()
	got := map[string]bool{}
	for _, branch := range schemaBranches(t, dir, file, name) {
		for _, v := range jsonStrings(branch["enum"]) {
			got[v] = true
		}
	}
	if len(got) == 0 {
		t.Fatalf("%s is no longer a string enum", name)
	}
	return got
}

// oneOfTypes collects the `type` discriminator of each branch of a tagged union.
func oneOfTypes(t *testing.T, dir, file, name string) []string {
	t.Helper()
	var types []string
	for _, branch := range schemaBranches(t, dir, file, name) {
		props, _ := branch["properties"].(map[string]interface{})
		disc, _ := props["type"].(map[string]interface{})
		types = append(types, jsonStrings(disc["enum"])...)
	}
	if len(types) == 0 {
		t.Fatalf("%s is no longer a tagged union", name)
	}
	return types
}

func schemaBranches(t *testing.T, dir, file, name string) []map[string]interface{} {
	t.Helper()
	raw, ok := schemaDefinition(t, dir, file, name)["oneOf"].([]interface{})
	if !ok {
		t.Fatalf("%s is no longer a oneOf", name)
	}
	branches := make([]map[string]interface{}, 0, len(raw))
	for _, b := range raw {
		if m, ok := b.(map[string]interface{}); ok {
			branches = append(branches, m)
		}
	}
	return branches
}

func jsonStrings(value interface{}) []string {
	raw, _ := value.([]interface{})
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
