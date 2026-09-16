import { describe, expect, it } from "vitest";
import { toolSummary } from "./toolSummary";

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

	it("names a subagent call by its description and badges its type", () => {
		expect(
			toolSummary(
				"Agent",
				{ description: "find usages", subagent_type: "Explore" },
				WORK_DIR,
			),
		).toMatchObject({ title: "Task", chip: "Explore", detail: "find usages" });
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
});
