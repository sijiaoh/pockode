import { describe, expect, it } from "vitest";
import { toolSummary, toolVerb } from "./toolSummary";

const WORK_DIR = "/Users/test/project";

describe("toolSummary", () => {
	// A paraphrase is not what ran, and on a phone this row is frequently the
	// only audit anyone performs.
	it("identifies a Bash call by its command, not by its description", () => {
		const summary = toolSummary(
			"Bash",
			{ command: "npm run build", description: "Build the web package" },
			WORK_DIR,
		);
		expect(summary).toMatchObject({ title: "Bash", detail: "npm run build" });
	});

	// Two truncations that disagree, one of which guesses how wide the screen
	// is. The row cuts the string at the width it actually has.
	it("hands over a long command whole rather than slicing it", () => {
		const command = "echo ".repeat(100).trim();
		expect(toolSummary("Bash", { command }, WORK_DIR).detail).toBe(command);
	});

	it("keeps a multi-line command on one line", () => {
		expect(
			toolSummary("Bash", { command: "cat <<EOF\nhi\nEOF" }, WORK_DIR).detail,
		).toBe("cat <<EOF ⏎ hi ⏎ EOF");
	});

	// `truncate` cuts the end of a string, and the end of a path is the one part
	// that identifies it — so the two halves are kept apart.
	it("splits a path so the file name is never the part that is cut", () => {
		expect(
			toolSummary(
				"Read",
				{ file_path: `${WORK_DIR}/src/components/Button.tsx` },
				WORK_DIR,
			),
		).toMatchObject({
			title: "Read",
			detail: "src/components/",
			detailTail: "Button.tsx",
		});
	});

	it("shows a path outside the work directory in full", () => {
		expect(
			toolSummary("Read", { file_path: "/etc/hosts" }, WORK_DIR),
		).toMatchObject({ detail: "/etc/", detailTail: "hosts" });
	});

	// Codex parses the command itself, and its reading of it is a better title
	// than guessing from the string.
	it("uses codex's own reading of a command when there is exactly one", () => {
		expect(
			toolSummary(
				"Bash",
				{
					command: "rg -n foo src",
					command_actions: [
						{
							type: "search",
							command: "rg -n foo src",
							query: "foo",
							path: "src",
						},
					],
				},
				WORK_DIR,
			).detail,
		).toBe('"foo" in src');
	});

	it("falls back to the command when codex read several parts of it", () => {
		expect(
			toolSummary(
				"Bash",
				{
					command: "ls | wc -l",
					command_actions: [
						{ type: "listFiles", path: "." },
						{ type: "unknown" },
					],
				},
				WORK_DIR,
			).detail,
		).toBe("ls | wc -l");
	});

	// The agent is the title and the task its detail: the type is no longer a
	// chip beside a literal `Task`.
	// Codex runs every command inside `zsh -lc '…'`; the row shows what ran in it.
	it("details a command by the script inside a CLI's shell envelope", () => {
		expect(
			toolSummary(
				"Bash",
				{ command: "/bin/zsh -lc 'sleep 45; echo main-done'" },
				WORK_DIR,
			).detail,
		).toBe("sleep 45; echo main-done");
	});

	it("names a subagent call by its agent, and details it by its description", () => {
		expect(
			toolSummary(
				"Agent",
				{ description: "find usages", subagent_type: "Explore" },
				WORK_DIR,
			),
		).toEqual({
			title: "Explore",
			detail: "find usages",
			detailTail: "",
			mono: false,
		});
	});

	it("leaves a plugin's prefix off a subagent's title", () => {
		expect(
			toolSummary(
				"Agent",
				{
					description: "review",
					subagent_type: "pr-review-toolkit:code-reviewer",
				},
				WORK_DIR,
			).title,
		).toBe("code-reviewer");
	});

	// Not the CLI's tool name, and not a guess at its default agent.
	it("titles a subagent call that names no agent Subagent", () => {
		expect(
			toolSummary(
				"Agent",
				{ description: "find usages", prompt: "Look" },
				WORK_DIR,
			),
		).toMatchObject({ title: "Subagent", detail: "find usages" });
	});

	it("names a Codex spawn, which has no description, by its agent", () => {
		expect(
			toolSummary("Task", { agent_path: "/root/read_a" }, WORK_DIR),
		).toMatchObject({ title: "read_a", detail: "" });
	});

	it("names a Codex spawn that carries only its prompt by the prompt", () => {
		expect(
			toolSummary(
				"Task",
				{ prompt: "Read src/file1.go\nThen report." },
				WORK_DIR,
			),
		).toMatchObject({ title: "Subagent", detail: "Read src/file1.go" });
	});

	// Claude passes its own `mcp__server__tool` through verbatim, and the title
	// slot never truncates — a 40-character machine name there would push the
	// argument that identifies the call off the row.
	it("splits claude's MCP naming into its server and its tool", () => {
		expect(
			toolSummary("mcp__github__get_issue", { id: "01a0" }, WORK_DIR),
		).toMatchObject({ title: "get_issue", chip: "github", detail: "01a0" });
	});

	// A `path` argument does not make a tool a file tool: drawn as one, the
	// whole machine name would sit in the title slot, which never truncates.
	it.each([
		["mcp__fs__read_file", "read_file", "fs"],
		["fs:read_file", "read_file", "fs"],
	])("titles MCP tool %s by its split name even with a path", (name, title, chip) => {
		expect(
			toolSummary(name, { path: `${WORK_DIR}/README.md` }, WORK_DIR),
		).toMatchObject({ title, chip, detail: `${WORK_DIR}/README.md` });
	});

	it("does not draw an unknown tool with a file_path as a file tool", () => {
		expect(
			toolSummary("Frobnicate", { file_path: "/etc/hosts" }, WORK_DIR),
		).toMatchObject({
			title: "Frobnicate",
			detail: "/etc/hosts",
			detailTail: "",
		});
	});

	it("splits codex's MCP naming into its server and its tool", () => {
		expect(
			toolSummary("github:create_issue", { title: "Broken" }, WORK_DIR),
		).toMatchObject({
			title: "create_issue",
			chip: "github",
			detail: "Broken",
		});
	});

	it("names an html_render call by its title, whatever order its input is in", () => {
		expect(
			toolSummary(
				"pockode:html_render",
				{ html: "<h1>p99</h1>", title: "Latency report" },
				WORK_DIR,
			),
		).toMatchObject({
			title: "html_render",
			chip: "pockode",
			detail: "Latency report",
		});
	});

	it.each([
		[{ base: "p2", edits: [] }, "from p2"],
		[
			{ edits: [], title: "Latency (p50)", base: "p2" },
			"Latency (p50) · from p2",
		],
	])("names an html_edit call by the page it starts from", (input, detail) => {
		expect(
			toolSummary("mcp__pockode__html_edit", input, WORK_DIR),
		).toMatchObject({ title: "html_edit", chip: "pockode", detail });
	});

	it("names an html_get call by the page it reads", () => {
		expect(
			toolSummary("pockode:html_get", { id: "p3" }, WORK_DIR),
		).toMatchObject({ title: "html_get", chip: "pockode", detail: "p3" });
	});

	it("counts a todo list rather than quoting one of them", () => {
		expect(
			toolSummary(
				"TodoWrite",
				{
					todos: [
						{ content: "a", status: "completed" },
						{ content: "b", status: "pending" },
					],
				},
				WORK_DIR,
			).detail,
		).toBe("1 done / 2");
	});

	it("scopes a Grep to the path it was given", () => {
		expect(
			toolSummary("Grep", { pattern: "TODO", path: "src" }, WORK_DIR).detail,
		).toBe('"TODO" in src');
	});

	// Claude passes an absolute scope, and on a phone the row showed the home
	// directory and nothing else.
	it("names a Grep scope inside the work directory relative to it", () => {
		expect(
			toolSummary(
				"Grep",
				{ pattern: "TODO", path: `${WORK_DIR}/src/lib` },
				WORK_DIR,
			).detail,
		).toBe('"TODO" in src/lib');
		expect(
			toolSummary("Grep", { pattern: "TODO", path: `${WORK_DIR}/` }, WORK_DIR)
				.detail,
		).toBe('"TODO"');
		expect(
			toolSummary("Grep", { pattern: "TODO", path: "/etc" }, WORK_DIR).detail,
		).toBe('"TODO" in /etc');
	});

	// The fallback lands on the same field only because `Object.values` happens
	// to return it first: another string in the input and this row would be
	// named after the wrong thing.
	it("names a task fetch by the task it reads, whatever else is in the input", () => {
		expect(
			toolSummary(
				"TaskOutput",
				{ block: "true", timeout: 30000, task_id: "bsbvhgo40" },
				WORK_DIR,
			),
		).toMatchObject({ title: "TaskOutput", detail: "bsbvhgo40", mono: true });
	});

	// A reviewer's answer is named by what it decided, by either CLI's spelling
	// (docs/unattended-mode-ui.md §5.1).
	it("names a permission verdict by its decision", () => {
		expect(
			toolSummary(
				"mcp__pockode__permission_verdict",
				{ request_id: "r1", verdict: "allow" },
				WORK_DIR,
			),
		).toMatchObject({ title: "Verdict: Allow", detail: "" });
		expect(
			toolSummary(
				"pockode:permission_verdict",
				{
					request_id: "r1",
					verdict: "deny",
					category: "system_reach_unverifiable",
					reason: "$DIR may be empty.",
				},
				WORK_DIR,
			),
		).toMatchObject({
			title: "Verdict: Deny · Can't verify what it reaches",
			detail: "$DIR may be empty.",
		});
	});
});

describe("the remaining tool kinds", () => {
	it.each<[string, Record<string, unknown>, string]>([
		["TaskStop", { task_id: "b1" }, "b1"],
		// The name it had before claude renamed it, which history holds.
		["KillShell", { shell_id: "b2" }, "b2"],
		["BashOutput", { bash_id: "b3" }, "b3"],
	])("names %s by its key, in mono", (name, input, detail) => {
		expect(toolSummary(name, input, WORK_DIR)).toMatchObject({
			title: name,
			detail,
			mono: true,
		});
	});

	it("reads a NotebookEdit like a file tool, with its mode as a chip", () => {
		const path = `${WORK_DIR}/nb/a.ipynb`;
		expect(
			toolSummary("NotebookEdit", { notebook_path: path }, WORK_DIR),
		).toMatchObject({
			title: "NotebookEdit",
			detail: "nb/",
			detailTail: "a.ipynb",
		});
		expect(
			toolSummary("NotebookEdit", { notebook_path: path }, WORK_DIR).chip,
		).toBeUndefined();
		expect(
			toolSummary(
				"NotebookEdit",
				{ notebook_path: path, edit_mode: "delete" },
				WORK_DIR,
			).chip,
		).toBe("delete");
	});
});

describe("Codex's own calls", () => {
	it("names an image generation by its prompt's first line, once it has one", () => {
		expect(toolSummary("GenerateImage", {}, WORK_DIR)).toMatchObject({
			title: "GenerateImage",
			detail: "",
		});
		expect(
			toolSummary("GenerateImage", { prompt: "A cat.\nOn a mat." }, WORK_DIR)
				.detail,
		).toBe("A cat.");
	});

	it("leaves a sleep's duration to the meta", () => {
		expect(
			toolSummary("Sleep", { duration_ms: 30000 }, WORK_DIR),
		).toMatchObject({ title: "Sleep", detail: "" });
	});

	it("titles an agent call by what it did, and names its agents", () => {
		expect(
			toolSummary(
				"AgentControl",
				{ action: "wait", agents: ["/root/file_reader", null] },
				WORK_DIR,
			),
		).toMatchObject({ title: "Wait", detail: "file_reader +1" });
		expect(toolVerb("AgentControl", { action: "wait", agents: [] })).toEqual({
			verb: "other",
			name: "Wait",
		});
	});

	it("reads a dynamic tool as an MCP call", () => {
		expect(toolSummary("dynamic:lookup", { q: "x" }, WORK_DIR)).toMatchObject({
			title: "lookup",
			chip: "dynamic",
			detail: "x",
		});
	});
});

describe("toolVerb names", () => {
	it("names a Codex search by its query and a listing by its directory", () => {
		expect(
			toolVerb("Bash", {
				command: "rg foo src",
				command_actions: [{ type: "search", query: "foo", path: "src" }],
			}),
		).toEqual({ verb: "search", name: '"foo"' });
		expect(
			toolVerb("Bash", {
				command: "ls web/src",
				command_actions: [{ type: "listFiles", path: "/w/web/src" }],
			}),
		).toEqual({ verb: "search", name: "src/" });
	});

	it("names a fetch by its host, and nothing for a URL it cannot read", () => {
		expect(toolVerb("WebFetch", { url: "https://a.dev:8080/x?y" }).name).toBe(
			"a.dev:8080",
		);
		expect(toolVerb("WebFetch", { url: "not a url" }).name).toBeUndefined();
	});

	it("names a web search by its query", () => {
		expect(toolVerb("WebSearch", { query: "vitest" }).name).toBe('"vitest"');
	});

	it("names any other tool by its row's title, without the MCP server", () => {
		expect(toolVerb("mcp__github__get_issue", {}).name).toBe("get_issue");
		expect(toolVerb("github:get_issue", {}).name).toBe("get_issue");
		expect(toolVerb("TaskOutput", {}).name).toBe("TaskOutput");
	});
});

describe("Pockode's own work tools", () => {
	const ref = { id: "t1", type: "task" as const, title: "Design the row" };

	it("titles a creation by the title it was given", () => {
		expect(
			toolSummary(
				"mcp__pockode__task_create",
				{ story_id: "s1", title: "Design the row" },
				WORK_DIR,
			),
		).toMatchObject({
			title: "Create task",
			chip: "pockode",
			detail: "Design the row",
			mono: false,
		});
	});

	// The title as of the call, never the store's; the id until there is one.
	it("names the work by its work_ref, else by the input's id in mono", () => {
		expect(
			toolSummary("pockode:task_start", { id: "t1" }, WORK_DIR, ref),
		).toMatchObject({
			title: "Start task",
			chip: "pockode",
			detail: "Design the row",
			mono: false,
		});
		expect(
			toolSummary("mcp__pockode__step_done", { id: "t1" }, WORK_DIR),
		).toMatchObject({ title: "Step done", detail: "t1", mono: true });
	});

	it.each([
		["work_comment_add", { work_id: "t1", body: "x" }, "Comment", "t1"],
		[
			"work_comment_update",
			{ id: "c1", body: "Fixed\nmore" },
			"Edit comment",
			"Fixed",
		],
		["story_list", {}, "List stories", ""],
		["agent_role_list", { work_type: "task" }, "List roles", "task"],
		["agent_role_get", { id: "r1" }, "Get role", "r1"],
		["agent_role_reset_defaults", {}, "Reset roles", ""],
		["story_wait", { id: "s1" }, "Wait for tasks", "s1"],
		["task_list", { story_id: "s1" }, "List tasks", "s1"],
	])("titles %s", (tool, input, title, detail) => {
		expect(toolSummary(`mcp__pockode__${tool}`, input, WORK_DIR)).toMatchObject(
			{
				title,
				detail,
			},
		);
	});

	it("leaves the page tools and the verdict to their own rows", () => {
		expect(
			toolSummary("mcp__pockode__html_get", { id: "p1" }, WORK_DIR).title,
		).toBe("html_get");
	});
});
