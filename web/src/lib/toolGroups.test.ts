import { describe, expect, it } from "vitest";
import type {
	ContentPart,
	PermissionStatus,
	Thought,
	ToolRun,
	ToolRunStatus,
} from "../types/message";
import { type RowEntry, rowEntries } from "./toolGroups";

type Item = { part: ContentPart };

const call = (
	id: string,
	name: string,
	input: unknown = {},
	status: ToolRunStatus = "success",
	extra: Partial<ToolRun> = {},
): Item => ({
	part: { type: "tool_call", tool: { id, name, input, status, ...extra } },
});
const read = (id: string, path: string, status?: ToolRunStatus) =>
	call(id, "Read", { file_path: path }, status);
const bash = (id: string, status?: ToolRunStatus, extra?: Partial<ToolRun>) =>
	call(id, "Bash", { command: `cmd ${id}` }, status, extra);
const card = (
	toolUseId: string,
	status: PermissionStatus,
	toolName = "Bash",
): Item => ({
	part: {
		type: "permission_request",
		request: {
			requestId: `req-${toolUseId}`,
			toolName,
			toolInput: {},
			toolUseId,
		},
		status,
	} as ContentPart,
});

let thinkingId = 0;
const thinking = (...durations: (number | undefined)[]): Item => ({
	part: {
		type: "thinking",
		id: `thinking-${++thinkingId}`,
		thoughts: durations.map(
			(durationMs): Thought => ({
				content: "Hmm.",
				fullReasoning: "",
				redacted: false,
				...(durationMs !== undefined ? { durationMs } : {}),
			}),
		),
	},
});

function id(item: Item): string {
	const { part } = item;
	if (part.type === "tool_call") return part.tool.id;
	if (part.type === "permission_request")
		return `card:${part.request.toolUseId}`;
	return part.type;
}

/** The entries as `[summary text]` and `id` / `id↓` (folds into the group). */
function shape(entries: RowEntry<Item>[]): string[] {
	return entries.map((entry) =>
		entry.kind === "summary"
			? `[${entry.summary.current ? `running ${entry.summary.current.id}` : entry.summary.segments.join(" · ")}]`
			: `${id(entry.item)}${entry.group ? "↓" : ""}`,
	);
}

function summaryOf(items: Item[]) {
	const entry = rowEntries(items).find((e) => e.kind === "summary");
	return entry?.kind === "summary" ? entry.summary : undefined;
}

describe("rowEntries", () => {
	it("does not group a single call", () => {
		expect(shape(rowEntries([bash("a")]))).toEqual(["a"]);
	});

	it("folds two or more calls under one summary, in transcript order", () => {
		expect(
			shape(rowEntries([read("a", "/x.ts"), bash("b"), read("c", "/y.ts")])),
		).toEqual(["[Ran 1 command · Read 2 files]", "a↓", "b↓", "c↓"]);
	});

	// A summary over one call and a failure says nothing the rows do not, and
	// costs a line.
	it("does not group one foldable call beside any number of failures", () => {
		expect(
			shape(rowEntries([bash("a", "error"), bash("b"), bash("c", "error")])),
		).toEqual(["a", "b", "c"]);
	});

	it("pins a failure in the middle of a group where it is", () => {
		expect(
			shape(rowEntries([read("a", "/x"), bash("b", "error"), read("c", "/y")])),
		).toEqual(["[Read 2 files]", "a↓", "b", "c↓"]);
	});

	it("pins background work while it runs and after it settles", () => {
		const items = (status: ToolRunStatus) => [
			read("a", "/x"),
			bash("b", status, { fromBackground: status !== "background" }),
			read("c", "/y"),
		];
		expect(shape(rowEntries(items("background")))).toEqual([
			"[Read 2 files]",
			"a↓",
			"b",
			"c↓",
		]);
		expect(shape(rowEntries(items("success")))).toEqual([
			"[Read 2 files]",
			"a↓",
			"b",
			"c↓",
		]);
	});

	it("ends a group at a subagent call and at a plan", () => {
		expect(
			shape(
				rowEntries([
					bash("a"),
					bash("b"),
					call("t", "Task"),
					bash("c"),
					call("p", "ExitPlanMode"),
					bash("d"),
					bash("e"),
				]),
			),
		).toEqual([
			"[Ran 2 commands]",
			"a↓",
			"b↓",
			"t",
			"c",
			"p",
			"[Ran 2 commands]",
			"d↓",
			"e↓",
		]);
	});

	it("keeps an unanswered or refused card pinned, with its row", () => {
		expect(
			shape(rowEntries([bash("a"), card("b", "pending"), bash("c")])),
		).toEqual(["[Ran 2 commands]", "a↓", "card:b", "c↓"]);
		expect(
			shape(
				rowEntries([
					bash("a"),
					card("b", "denied"),
					bash("b", "error"),
					bash("c"),
				]),
			),
		).toEqual(["[Ran 2 commands]", "a↓", "card:b", "b", "c↓"]);
	});

	it("keeps an approved card pinned with its row when the call fails", () => {
		expect(
			shape(
				rowEntries([
					bash("a"),
					card("b", "allowed"),
					bash("b", "error"),
					bash("c"),
				]),
			),
		).toEqual(["[Ran 2 commands]", "a↓", "card:b", "b", "c↓"]);
	});

	// Until the row is back the card is all there is of the call; folding it
	// would put a tick over a command that is still running.
	it("keeps an approved card pinned until its row comes back, then folds both", () => {
		expect(
			shape(rowEntries([bash("a"), card("b", "allowed"), bash("c")])),
		).toEqual(["[Ran 2 commands]", "a↓", "card:b", "c↓"]);
		expect(
			shape(
				rowEntries([bash("a"), card("b", "allowed"), bash("b"), bash("c")]),
			),
		).toEqual(["[Ran 3 commands]", "a↓", "card:b↓", "b↓", "c↓"]);
	});

	it("counts a card and its row as one step", () => {
		expect(
			summaryOf([
				bash("a", "running"),
				card("b", "allowed"),
				bash("b", "running"),
			])?.steps,
		).toBe(2);
	});

	it("follows a run as it streams in, keyed on its first call", () => {
		const first = rowEntries([bash("a", "running")]);
		expect(shape(first)).toEqual(["a"]);
		const second = rowEntries([bash("a"), bash("b", "running")]);
		expect(shape(second)).toEqual(["[running b]", "a↓", "b↓"]);
		const third = rowEntries([bash("a"), bash("b"), read("c", "/x")]);
		expect(shape(third)).toEqual([
			"[Ran 2 commands · Read 1 file]",
			"a↓",
			"b↓",
			"c↓",
		]);
		const keys = [second, third].map((entries) =>
			entries[0].kind === "summary" ? entries[0].key : undefined,
		);
		expect(keys[0]).toBeDefined();
		expect(keys[0]).toBe(keys[1]);
	});

	it("is on the newest running call, and counts every call as a step", () => {
		const summary = summaryOf([
			bash("a", "running"),
			bash("b", "error"),
			bash("c", "running"),
			bash("d"),
		]);
		expect(summary?.current?.id).toBe("c");
		expect(summary?.steps).toBe(4);
	});

	it("does not spin while a card in the group waits on the user", () => {
		const summary = summaryOf([
			bash("a"),
			bash("b", "running"),
			bash("c"),
			card("d", "pending"),
		]);
		expect(summary?.current).toBeUndefined();
		expect(summary?.segments).toEqual(["Ran 2 commands"]);
	});

	it("stops spinning once its running call goes to the background", () => {
		const summary = summaryOf([bash("a"), bash("b"), bash("c", "background")]);
		expect(summary?.current).toBeUndefined();
	});

	// Codex reasons before nearly every call: a thinking that counted would
	// fold a lone call into a summary hiding its own title.
	it("does not count a thinking toward the minimum or the steps", () => {
		expect(shape(rowEntries([thinking(1000), bash("a")]))).toEqual([
			"thinking",
			"a",
		]);
		expect(
			summaryOf([thinking(1000), bash("a"), thinking(1000), bash("b")])?.steps,
		).toBe(2);
	});

	it("folds a thinking among the calls without ending the run", () => {
		expect(
			shape(
				rowEntries([
					thinking(2000),
					bash("a"),
					thinking(3000),
					bash("b", "error"),
					bash("c"),
				]),
			),
		).toEqual([
			"[Ran 2 commands · Thought for 5s]",
			"thinking↓",
			"a↓",
			"thinking↓",
			"b",
			"c↓",
		]);
	});

	it("gives each thinking a call of its own", () => {
		const calls = rowEntries([thinking(1), bash("a"), thinking(1)]).flatMap(
			(entry) => (entry.kind === "item" ? [entry.call] : []),
		);
		expect(new Set(calls).size).toBe(3);
	});

	describe("the summary line", () => {
		it("puts the folded thinking after the verbs and before interruptions", () => {
			expect(
				summaryOf([
					thinking(61_000, 19_000),
					bash("a", "interrupted"),
					call("b", "mcp__srv__do"),
				])?.segments,
			).toEqual(["Used 1 tool", "Thought for 1m 20s", "1 interrupted"]);
		});

		it("says only Thought when a folded thinking was not measured", () => {
			expect(
				summaryOf([thinking(1000), bash("a"), thinking(undefined), bash("b")])
					?.segments,
			).toEqual(["Ran 2 commands", "Thought"]);
		});

		it("leaves the thinking out while nothing has settled", () => {
			expect(
				summaryOf([
					thinking(1000),
					card("a", "pending"),
					bash("b", "running"),
					bash("c", "running"),
				])?.segments,
			).toEqual([]);
		});

		it("leaves failed and interrupted calls out of the verbs", () => {
			const summary = summaryOf([
				call("a", "Edit", { file_path: "/x" }),
				call("b", "Edit", { file_path: "/y" }, "error"),
				bash("c", "interrupted"),
				bash("d"),
			]);
			expect(summary?.segments).toEqual([
				"Edited 1 file",
				"Ran 1 command",
				"1 interrupted",
			]);
		});

		it("orders verbs by consequence, not by arrival", () => {
			expect(
				summaryOf([
					call("a", "mcp__srv__do"),
					call("b", "TodoWrite"),
					call("c", "WebFetch"),
					call("d", "Grep"),
					read("e", "/x"),
					bash("f"),
					call("g", "Write", { file_path: "/z" }),
				])?.segments,
			).toEqual([
				"Edited 1 file",
				"Ran 1 command",
				"Read 1 file",
				"Searched once",
				"Fetched 1 page",
				"Updated todos",
				"Used 1 tool",
			]);
		});

		it("counts files once however often they were touched", () => {
			expect(
				summaryOf([
					read("a", "/x"),
					read("b", "/x"),
					call("c", "Edit", { file_path: "/x" }),
					call("d", "MultiEdit", { file_path: "/x" }),
					call("e", "Grep"),
					call("f", "Glob"),
				])?.segments,
			).toEqual(["Edited 1 file", "Read 1 file", "Searched 2 times"]);
		});

		it("counts each file of a Codex file change", () => {
			expect(
				summaryOf([
					call("a", "Edit", {
						changes: [
							{ path: "/a", kind: { type: "update" }, diff: "" },
							{ path: "/b", kind: { type: "update" }, diff: "" },
						],
					}),
					bash("b"),
				])?.segments,
			).toEqual(["Edited 2 files", "Ran 1 command"]);
		});

		it("reads a Codex command the way its row does", () => {
			expect(
				summaryOf([
					call("a", "Bash", {
						command: "cat x",
						command_actions: [{ type: "read", path: "/x" }],
					}),
					call("b", "Bash", {
						command: "rg foo",
						command_actions: [{ type: "search", query: "foo" }],
					}),
					call("c", "Bash", {
						command: "cat x | rg foo",
						command_actions: [
							{ type: "read", path: "/x" },
							{ type: "search", query: "foo" },
						],
					}),
				])?.segments,
			).toEqual(["Ran 1 command", "Read 1 file", "Searched once"]);
		});
	});
});
