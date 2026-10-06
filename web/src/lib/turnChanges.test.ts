import { describe, expect, it } from "vitest";
import type { ContentPart, ToolRun, ToolRunStatus } from "../types/message";
import { turnChanges } from "./turnChanges";

const WORK_DIR = "/repo";

const call = (
	id: string,
	name: string,
	input: unknown,
	status: ToolRunStatus = "success",
	extra: Partial<ToolRun> = {},
): ContentPart => ({
	type: "tool_call",
	tool: { id, name, input, status, ...extra },
});
const edit = (
	id: string,
	path: string,
	oldString: string,
	newString: string,
	status?: ToolRunStatus,
) =>
	call(
		id,
		"Edit",
		{ file_path: path, old_string: oldString, new_string: newString },
		status,
	);
const WRITE_RESULT = {
	created: (path: string) => `File created successfully at: ${path}`,
	rewritten: (path: string) =>
		`The file ${path} has been updated successfully.`,
	unknown: () => "Done.",
};
const write = (
	id: string,
	path: string,
	content: string,
	outcome: keyof typeof WRITE_RESULT,
) =>
	call(id, "Write", { file_path: path, content }, "success", {
		result: WRITE_RESULT[outcome](path),
	});
const codex = (id: string, changes: unknown) => call(id, "Edit", { changes });

/** Each file as `marker name dir +added -removed (call ids)`; `-` for none. */
function shape(parts: ContentPart[]): string[] {
	return turnChanges(parts, WORK_DIR).files.map(
		(file) =>
			`${file.marker ?? "-"} ${file.name} ${file.dir || "-"} ${
				file.lines ? `+${file.lines.added} -${file.lines.removed ?? "?"}` : "?"
			} (${file.edits.map((e) => e.run.id).join(",")})`,
	);
}

describe("turnChanges", () => {
	it("counts an Edit's lines, a fragment's last line compared as a line", () => {
		expect(
			shape([
				edit("1", "/repo/src/a.ts", "foo", "bar"),
				edit("2", "/repo/src/b.ts", "keep", "keep\nnew line"),
				// A CRLF file: the closing newline must not make `me` a change.
				edit("3", "/repo/src/c.ts", "keep\r\nme", "keep\r\nme\r\nnew"),
			]),
		).toEqual([
			"- a.ts src +1 -1 (1)",
			"- b.ts src +1 -0 (2)",
			"- c.ts src +1 -0 (3)",
		]);
	});

	it("sums a MultiEdit's edits", () => {
		expect(
			shape([
				call("1", "MultiEdit", {
					file_path: "/repo/a.ts",
					edits: [
						{ old_string: "a", new_string: "b" },
						{ old_string: "c", new_string: "c\nd\ne" },
					],
				}),
			]),
		).toEqual(["- a.ts - +3 -1 (1)"]);
	});

	it("reads a Write's result for whether it made the file", () => {
		expect(
			shape([
				write("1", "/repo/new.ts", "a\nb\n", "created"),
				write("2", "/repo/old.ts", "a\nb\nc", "rewritten"),
				write("3", "/repo/odd.ts", "a", "unknown"),
			]),
		).toEqual([
			"new new.ts - +2 -0 (1)",
			// What a rewrite replaced is not in the transcript.
			"rewritten old.ts - +3 -? (2)",
			"- odd.ts - +1 -? (3)",
		]);
	});

	it("keeps every edit of one file in order, and sums what is known", () => {
		const { files, lines } = turnChanges(
			[
				write("1", "/repo/a.ts", "one\n", "rewritten"),
				edit("2", "/repo/b.ts", "x", "y"),
				edit("3", "/repo//a.ts", "one", "one\ntwo\n"),
			],
			WORK_DIR,
		);
		expect(files.map((f) => f.name)).toEqual(["a.ts", "b.ts"]);
		expect(files[0].marker).toBe("rewritten");
		expect(files[0].edits.map((e) => e.run.id)).toEqual(["1", "3"]);
		expect(files[0].lines).toEqual({ added: 3, removed: 0 });
		expect(lines).toEqual({ added: 4, removed: 1 });
	});

	it("keeps a file the turn made new however it was edited after", () => {
		expect(
			shape([
				write("1", "/repo/a.ts", "x\n", "created"),
				edit("2", "/repo/a.ts", "x", "y"),
			]),
		).toEqual(["new a.ts - +2 -1 (1,2)"]);
	});

	it("counts only calls that succeeded", () => {
		expect(
			shape([
				edit("1", "/repo/a.ts", "x", "y", "error"),
				edit("2", "/repo/b.ts", "x", "y", "interrupted"),
				edit("3", "/repo/c.ts", "x", "y", "running"),
				call("4", "Read", { file_path: "/repo/d.ts" }),
			]),
		).toEqual([]);
	});

	it("includes what a subagent changed, wherever the subagent ended", () => {
		expect(
			shape([
				call("t", "Task", { prompt: "go" }, "interrupted", {
					children: [edit("c", "/repo/a.ts", "x", "y")],
				}),
				// A subagent's call whose parent is not loaded sits flat.
				{
					type: "tool_call",
					tool: {
						id: "f",
						name: "Edit",
						input: {
							file_path: "/repo/b.ts",
							old_string: "x",
							new_string: "y",
						},
						status: "success",
					},
					parentToolUseId: "gone",
				},
			]),
		).toEqual(["- a.ts - +1 -1 (c)", "- b.ts - +1 -1 (f)"]);
	});

	it("splits a Codex change into its files, each with only its own diff", () => {
		const { files } = turnChanges(
			[
				codex("1", [
					{
						path: "/repo/src/b.ts",
						kind: { type: "update" },
						diff: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n+++plus\n",
					},
					{ path: "/repo/a.ts", kind: { type: "add" }, diff: "a\nb\n" },
					{ path: "/repo/gone.ts", kind: { type: "delete" }, diff: "z\n" },
					{ path: "/repo/huh.ts", kind: { type: "teleport" }, diff: "" },
				]),
			],
			WORK_DIR,
		);
		expect(
			files.map((f) => [f.marker, f.name, f.lines, f.edits[0].change]),
		).toEqual([
			[
				"new",
				"a.ts",
				{ added: 2, removed: 0 },
				{
					kind: "codex",
					changes: [expect.objectContaining({ path: "/repo/a.ts" })],
				},
			],
			["deleted", "gone.ts", { added: 0, removed: 1 }, expect.anything()],
			[undefined, "huh.ts", null, expect.anything()],
			[undefined, "b.ts", { added: 2, removed: 1 }, expect.anything()],
		]);
	});

	it("follows a Codex rename, keeping the file's place and earlier edits", () => {
		expect(
			shape([
				edit("1", "/repo/old.ts", "x", "y"),
				edit("2", "/repo/other.ts", "x", "y"),
				codex("3", [
					{
						path: "/repo/old.ts",
						kind: { type: "update", move_path: "/repo/lib/new.ts" },
						diff: "",
					},
				]),
				edit("4", "/repo/lib/new.ts", "y", "z"),
			]),
		).toEqual(["renamed new.ts lib +2 -2 (1,3,4)", "- other.ts - +1 -1 (2)"]);
	});

	it("reads a file made and deleted in one turn as deleted", () => {
		expect(
			shape([
				codex("1", [
					{ path: "/repo/t.ts", kind: { type: "add" }, diff: "a\n" },
				]),
				codex("2", [
					{ path: "/repo/t.ts", kind: { type: "delete" }, diff: "a\n" },
				]),
			]),
		).toEqual(["deleted t.ts - +1 -1 (1,2)"]);
	});

	it("shows a path outside the work directory whole, however it is spelt", () => {
		expect(
			shape([
				edit("1", "/etc/hosts", "a", "b"),
				edit("2", "/etc//hosts", "b", "c"),
				edit("3", "/top.txt", "a", "b"),
			]),
		).toEqual(["- hosts /etc +2 -2 (1,2)", "- top.txt / +1 -1 (3)"]);
	});

	it("keeps a file outside the work directory apart from one inside it", () => {
		expect(
			shape([
				edit("1", "/etc/hosts", "a", "b"),
				edit("2", "/repo/etc/hosts", "a", "b"),
			]),
		).toEqual(["- hosts /etc +1 -1 (1)", "- hosts etc +1 -1 (2)"]);
	});

	it("reads a file made again after the turn changed it as rewritten", () => {
		// Deleted in between by a command, which this list cannot see.
		expect(
			shape([
				edit("1", "/repo/a.ts", "x", "y"),
				write("2", "/repo/a.ts", "z\n", "created"),
			]),
		).toEqual(["rewritten a.ts - +2 -1 (1,2)"]);
	});

	it("matches a Windows path under either separator", () => {
		const { files } = turnChanges(
			[
				edit("1", "C:\\repo\\src\\a.ts", "x", "y"),
				edit("2", "C:/repo/src/a.ts", "y", "z"),
				edit("3", "D:\\b.ts", "x", "y"),
			],
			"C:\\repo",
		);
		expect(files.map((f) => [f.dir, f.name, f.edits.length])).toEqual([
			["src", "a.ts", 2],
			["D:\\", "b.ts", 1],
		]);
	});

	it("reads an Edit that made its file as a new file", () => {
		expect(
			shape([
				call(
					"1",
					"Edit",
					{ file_path: "/repo/a.ts", old_string: "", new_string: "a\nb" },
					"success",
					{ result: "File created successfully at: /repo/a.ts" },
				),
			]),
		).toEqual(["new a.ts - +2 -0 (1)"]);
	});

	it("keeps a file renamed onto one the turn changed as one, in order", () => {
		expect(
			shape([
				edit("1", "/repo/a.ts", "x", "y"),
				edit("2", "/repo/b.ts", "x", "y"),
				edit("3", "/repo/a.ts", "y", "z"),
				codex("4", {
					"/repo/a.ts": {
						type: "update",
						unified_diff: "",
						move_path: "/repo/b.ts",
					},
				}),
			]),
		).toEqual(["renamed b.ts - +3 -3 (1,2,3,4)"]);
	});

	it("keeps a file renamed onto one the turn changed where it was first touched", () => {
		expect(
			shape([
				edit("1", "/repo/b.ts", "x", "y"),
				edit("2", "/repo/c.ts", "x", "y"),
				codex("3", {
					"/repo/a.ts": {
						type: "update",
						unified_diff: "",
						move_path: "/repo/b.ts",
					},
				}),
			]),
		).toEqual(["renamed b.ts - +1 -1 (1,3)", "- c.ts - +1 -1 (2)"]);
	});

	it("reads a file deleted and made again as rewritten", () => {
		expect(
			shape([
				codex("1", [
					{ path: "/repo/t.ts", kind: { type: "delete" }, diff: "a\n" },
				]),
				write("2", "/repo/t.ts", "b\n", "created"),
			]),
		).toEqual(["rewritten t.ts - +1 -1 (1,2)"]);
	});

	it("totals what is known, and nothing when nothing is", () => {
		expect(
			turnChanges([write("1", "/repo/a.ts", "x\n", "rewritten")], WORK_DIR)
				.lines,
		).toEqual({ added: 1 });
		expect(
			turnChanges(
				[codex("1", [{ path: "/repo/a.ts", kind: { type: "x" }, diff: "" }])],
				WORK_DIR,
			).lines,
		).toBeNull();
		expect(turnChanges([], WORK_DIR)).toEqual({ files: [], lines: null });
	});

	it("skips a MultiEdit whose edits are not edits", () => {
		expect(
			shape([
				call("1", "MultiEdit", { file_path: "/repo/a.ts", edits: [null] }),
			]),
		).toEqual([]);
	});
});
