import { describe, expect, it } from "vitest";
import { commandHead, toolSummary, toolVerb } from "./toolSummary";

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
			toolSummary("mcp__pockode__work_get", { id: "01a0" }, WORK_DIR),
		).toMatchObject({ title: "work_get", chip: "pockode", detail: "01a0" });
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

describe("commandHead", () => {
	it.each([
		["pnpm run test", "pnpm run test"],
		["go test ./relay/... -run TestX", "go test ./relay/..."],
		['git commit -m "Fix it"', "git commit"],
		["python3 -I x.py", "python3"],
		["cd web && CI=1 pnpm test -- --run", "pnpm test"],
		["cd a && cd b && make", "make"],
		["cat x | rg foo", "cat x"],
		["ls; pwd", "ls"],
		["cat <<EOF\nhi\nEOF", "cat"],
		["pnpm test 2>&1", "pnpm test"],
		["cd web; pnpm test", "pnpm test"],
		["cd web\npnpm test", "pnpm test"],
		["pnpm dev & sleep 2", "pnpm dev"],
		["# build it\npnpm build", "pnpm build"],
		['cd "my dir" && make build', "make build"],
		['FOO="a b" BAR= node x.js', "node x.js"],
		["docker compose up web db", "docker compose up"],
	])("reads %j as %j", (command, head) => {
		expect(commandHead(command)).toBe(head);
	});

	it("has nothing to say for a command that is all flags", () => {
		expect(commandHead("-x")).toBeUndefined();
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
		expect(toolVerb("mcp__pockode__work_get", {}).name).toBe("work_get");
		expect(toolVerb("pockode:work_get", {}).name).toBe("work_get");
		expect(toolVerb("TaskOutput", {}).name).toBe("TaskOutput");
	});
});
