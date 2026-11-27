import { describe, expect, it } from "vitest";
import type {
	ContentPart,
	PermissionStatus,
	Thought,
	ToolRun,
	ToolRunStatus,
} from "../types/message";
import { replayHistory } from "./messageReducer";
import {
	type FormSegment,
	type GroupSummary,
	type RowEntry,
	rowEntries,
	summaryForms,
} from "./toolGroups";

type Item = { part: ContentPart };

const call = (
	id: string,
	name: string,
	input: unknown = {},
	status: ToolRunStatus = "success",
	extra: Partial<ToolRun> = {},
): Item => ({
	part: {
		type: "tool_call",
		id: `call-${id}`,
		tool: { id, name, input, status, ...extra },
	},
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
		id: `card-${toolUseId}`,
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
			(durationMs, index): Thought => ({
				id: `thought-${index}`,
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

/** A form of the summary line as the row draws its text. */
function text(form: FormSegment[]): string {
	return form
		.map(({ lead, names, more }) =>
			[
				lead,
				names
					.map(
						(name) => `${name.text}${name.times > 1 ? ` ×${name.times}` : ""}`,
					)
					.join(", "),
				more > 0 ? `+${more}` : "",
			]
				.filter(Boolean)
				.join(" "),
		)
		.join(" · ");
}

const forms = (summary: GroupSummary | undefined) =>
	summary ? summaryForms(summary).map(text) : [];
const richest = (summary: GroupSummary | undefined) => forms(summary)[0];
const sparest = (summary: GroupSummary | undefined) => forms(summary).at(-1);

/**
 * The entries as `[summary]` — its count-only form, `⟳` while it spins — and
 * `id` / `id↓` (folds into the group).
 */
function shape(entries: RowEntry<Item>[]): string[] {
	return entries.map((entry) =>
		entry.kind === "summary"
			? `[${entry.summary.current ? "⟳ " : ""}${sparest(entry.summary)}]`
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
	it("does not group one settled call beside any number of failures", () => {
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

	// A cut-short call's background result can land turns later; the call had
	// settled long before and must stay folded, or its group could dissolve.
	it("keeps an interrupted call folded once a background result reaches it", () => {
		expect(
			shape(
				rowEntries([
					read("a", "/x"),
					bash("b", "interrupted", { fromBackground: true }),
				]),
			),
		).toEqual(["[Read 1 file · 1 interrupted]", "a↓", "b↓"]);
	});

	// It was pinned as background until the process ended under it, and that
	// interrupt is no reason to fold a row the reader may have scrolled past.
	it("keeps background work lost with the process pinned", () => {
		expect(
			shape(
				rowEntries([
					read("a", "/x"),
					bash("b", "interrupted", {
						fromBackground: true,
						lostWithProcess: true,
					}),
					read("c", "/y"),
				]),
			),
		).toEqual(["[Read 2 files]", "a↓", "b", "c↓"]);
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

	it("keeps an approved card's call pinned while it runs", () => {
		expect(
			shape(
				rowEntries([
					bash("a"),
					card("b", "allowed"),
					bash("b", "running"),
					bash("c"),
				]),
			),
		).toEqual(["[Ran 2 commands]", "a↓", "card:b", "b", "c↓"]);
	});

	// A running call may yet turn into a card, a failure or background work;
	// a group it formed would dissolve again under the reader's eyes.
	it("does not group calls that have not settled", () => {
		expect(shape(rowEntries([bash("a"), bash("b", "running")]))).toEqual([
			"a",
			"b",
		]);
	});

	it("follows a run as it streams in, keyed on its oldest call", () => {
		const first = rowEntries([bash("a", "running")]);
		expect(shape(first)).toEqual(["a"]);
		const second = rowEntries([
			bash("a"),
			bash("b"),
			read("c", "/x", "running"),
		]);
		expect(shape(second)).toEqual([
			"[⟳ Reading 1 file · Ran 2 commands]",
			"a↓",
			"b↓",
			"c↓",
		]);
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

	// A page joining from above puts calls in front of the run, and its ids
	// were minted after those on screen. Ids compare as strings, so `call-z`
	// stands for such a call; the group is still named after `a`.
	it("keeps its key when calls join in front of it", () => {
		const keyOf = (entries: ReturnType<typeof rowEntries>) =>
			entries[0].kind === "summary" ? entries[0].key : undefined;
		const shown = keyOf(rowEntries([bash("a"), bash("b")]));
		expect(shown).toBeDefined();
		expect(keyOf(rowEntries([bash("z"), bash("a"), bash("b")]))).toBe(shown);
	});

	// The pinned failure is in sight and speaks for itself; the summary counts
	// the folded calls only, live and settled alike.
	it("is on the newest running call, and counts only the folded calls", () => {
		const summary = summaryOf([
			bash("a", "running"),
			bash("b", "error"),
			bash("c", "running"),
			bash("d"),
			bash("e"),
		]);
		expect(summary?.current?.id).toBe("c");
		expect(sparest(summary)).toBe("Running 2 commands · Ran 2 commands");
	});

	it("does not spin while a card in the group waits on the user", () => {
		const summary = summaryOf([
			bash("a"),
			bash("b", "running"),
			bash("c"),
			card("d", "pending"),
		]);
		expect(summary?.current).toBeUndefined();
		expect(sparest(summary)).toBe("Running 1 command · Ran 2 commands");
	});

	// The tick says every folded call is over; one still running behind a
	// waiting card is named in the present tense instead.
	it("names folded calls still running while a card waits", () => {
		const summary = summaryOf([
			read("a", "/x"),
			bash("b", "background"),
			read("e", "/y"),
			bash("c", "running"),
			card("d", "pending"),
		]);
		expect(summary?.current).toBeUndefined();
		expect(richest(summary)).toBe("Running cmd c · Read x, y");
	});

	it("stops spinning once its running call goes to the background", () => {
		const summary = summaryOf([bash("a"), bash("b"), bash("c", "background")]);
		expect(summary?.current).toBeUndefined();
	});

	// Codex reasons before nearly every call: a thinking that counted would
	// fold a lone call into a summary hiding its own title.
	it("does not count a thinking toward the minimum", () => {
		expect(shape(rowEntries([thinking(1000), bash("a")]))).toEqual([
			"thinking",
			"a",
		]);
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
				sparest(
					summaryOf([
						thinking(61_000, 19_000),
						bash("a", "interrupted"),
						call("b", "mcp__srv__do"),
					]),
				),
			).toBe("Used 1 tool · Thought for 1m 20s · 1 interrupted");
		});

		it("says only Thought when a folded thinking was not measured", () => {
			expect(
				sparest(
					summaryOf([
						thinking(1000),
						bash("a"),
						thinking(undefined),
						bash("b"),
					]),
				),
			).toBe("Ran 2 commands · Thought");
		});

		it("leaves failed and interrupted calls out of the verbs", () => {
			const summary = summaryOf([
				call("a", "Edit", { file_path: "/x" }),
				call("b", "Edit", { file_path: "/y" }, "error"),
				bash("c", "interrupted"),
				bash("d"),
			]);
			expect(sparest(summary)).toBe(
				"Edited 1 file · Ran 1 command · 1 interrupted",
			);
		});

		it("orders verbs by consequence, not by arrival", () => {
			expect(
				sparest(
					summaryOf([
						call("a", "mcp__srv__do"),
						call("b", "TodoWrite"),
						call("c", "WebFetch"),
						call("d", "Grep"),
						read("e", "/x"),
						bash("f"),
						call("g", "Write", { file_path: "/z" }),
					]),
				),
			).toBe(
				"Edited 1 file · Ran 1 command · Read 1 file · Searched once · Fetched 1 page · Updated todos · Used 1 tool",
			);
		});

		it("counts files once however often they were touched", () => {
			expect(
				sparest(
					summaryOf([
						read("a", "/x"),
						read("b", "/x"),
						call("c", "Edit", { file_path: "/x" }),
						call("d", "MultiEdit", { file_path: "/x" }),
						call("e", "Grep"),
						call("f", "Glob"),
					]),
				),
			).toBe("Edited 1 file · Read 1 file · Searched 2 times");
		});

		it("counts each file of a Codex file change", () => {
			expect(
				sparest(
					summaryOf([
						call("a", "Edit", {
							changes: [
								{ path: "/a", kind: { type: "update" }, diff: "" },
								{ path: "/b", kind: { type: "update" }, diff: "" },
							],
						}),
						bash("b"),
					]),
				),
			).toBe("Edited 2 files · Ran 1 command");
		});

		it("reads a Codex command the way its row does", () => {
			expect(
				sparest(
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
					]),
				),
			).toBe("Ran 1 command · Read 1 file · Searched once");
		});
	});

	describe("the names on the line", () => {
		const edit = (id: string, path: string) =>
			call(id, "Edit", { file_path: path });
		const run = (id: string, command: string, status?: ToolRunStatus) =>
			call(id, "Bash", { command }, status);

		it("names what each verb touched, in the order it first appeared", () => {
			expect(
				richest(
					summaryOf([
						read("a", "/w/src/b.ts"),
						edit("b", "/w/src/ToolRow.tsx"),
						read("c", "/w/src/a.ts"),
						run("d", "pnpm test"),
						call("e", "Grep", { pattern: "foo", path: "/w/src" }),
						call("f", "Glob", { pattern: "**/*.test.ts" }),
						call("g", "WebFetch", { url: "https://github.com/a/b" }),
						call("h", "mcp__pockode__work_get"),
						call("i", "TodoWrite"),
					]),
				),
			).toBe(
				'Edited ToolRow.tsx · Ran pnpm test · Read b.ts, a.ts · Searched "foo", **/*.test.ts · Fetched github.com · Updated todos · Used work_get',
			);
		});

		// The count is authoritative in every form: names shown and `+K` add
		// up to it.
		it("names at most three per verb and counts the rest", () => {
			expect(
				richest(
					summaryOf(["a", "b", "c", "d", "e"].map((n) => read(n, `/${n}.ts`))),
				),
			).toBe("Read a.ts, b.ts, c.ts +2");
		});

		it("counts a repeated call once per run, and a re-read file once", () => {
			expect(
				richest(
					summaryOf([
						run("a", "pnpm test"),
						read("b", "/x.ts"),
						run("c", "pnpm test"),
						read("d", "/x.ts"),
					]),
				),
			).toBe("Ran pnpm test ×2 · Read x.ts");
		});

		it("counts a call with nothing to name it by, and names the rest", () => {
			expect(
				richest(
					summaryOf([
						run("a", "pnpm test"),
						call("b", "BashOutput", { bash_id: "1" }),
					]),
				),
			).toBe("Ran pnpm test +1");
			expect(
				richest(
					summaryOf([
						call("a", "BashOutput", { bash_id: "1" }),
						call("b", "KillShell", { shell_id: "1" }),
					]),
				),
			).toBe("Ran 2 commands");
		});

		it("tells files with one base name apart by their paths, and only those", () => {
			expect(
				richest(
					summaryOf([
						read("a", "/w/web/index.ts"),
						read("b", "/w/server/index.ts"),
						read("c", "/w/web/main.ts"),
					]),
				),
			).toBe("Read web/index.ts, server/index.ts, main.ts");
			expect(
				richest(
					summaryOf([read("a", "/a/x/index.ts"), read("b", "/b/x/index.ts")]),
				),
			).toBe("Read a/x/index.ts, b/x/index.ts");
			expect(
				richest(
					summaryOf([
						read("a", "C:\\w\\web\\index.ts"),
						read("b", "C:\\w\\server\\index.ts"),
					]),
				),
			).toBe("Read web\\index.ts, server\\index.ts");
		});

		it("counts one file spelled with either separator once", () => {
			expect(
				richest(summaryOf([read("a", "C:\\w\\x.ts"), read("b", "C:/w/x.ts")])),
			).toBe("Read x.ts");
		});

		it("names what is under way in the present tense, ahead of what is done", () => {
			const summary = summaryOf([
				read("a", "/a.ts"),
				read("b", "/b.ts"),
				run("c", "pnpm build", "running"),
			]);
			expect(summary?.current?.id).toBe("c");
			expect(richest(summary)).toBe("Running pnpm build · Read a.ts, b.ts");
			expect(sparest(summary)).toBe("Running 1 command · Read 2 files");
		});

		it("words each verb under way the way it words it done", () => {
			const running = (item: Item) => {
				if (item.part.type === "tool_call") item.part.tool.status = "running";
				return item;
			};
			expect(
				forms(
					summaryOf([
						read("a", "/a.ts"),
						read("b", "/b.ts"),
						running(edit("c", "/c.ts")),
						running(call("d", "Grep", { pattern: "x" })),
						running(call("e", "Grep", { pattern: "y" })),
						running(call("f", "WebFetch", { url: "https://a.dev/x" })),
						running(call("g", "TodoWrite")),
						running(call("h", "mcp__srv__do")),
					]),
				).at(-1),
			).toBe(
				"Editing 1 file · Searching 2 times · Fetching 1 page · Updating todos · Using 1 tool · Read 2 files",
			);
			expect(
				sparest(
					summaryOf([
						read("a", "/a.ts"),
						read("b", "/b.ts"),
						running(call("c", "Grep", { pattern: "x" })),
					]),
				),
			).toBe("Searching · Read 2 files");
		});

		it("moves a call's name into the past once it settles", () => {
			const items = (status: ToolRunStatus) => [
				run("a", "pnpm lint"),
				run("b", "pnpm build"),
				run("c", "pnpm test", status),
			];
			expect(richest(summaryOf(items("running")))).toBe(
				"Running pnpm test · Ran pnpm lint, pnpm build",
			);
			expect(richest(summaryOf(items("success")))).toBe(
				"Ran pnpm lint, pnpm build, pnpm test",
			);
		});

		// Edits come first on the line, so they keep their names longest.
		it("gives names up one at a time from the end of the line", () => {
			expect(
				forms(
					summaryOf([
						edit("a", "/e.ts"),
						run("b", "pnpm test"),
						run("c", "pnpm test"),
						read("d", "/a.ts"),
						read("e", "/b.ts"),
						thinking(2000),
					]),
				),
			).toEqual([
				"Edited e.ts · Ran pnpm test ×2 · Read a.ts, b.ts · Thought for 2s",
				"Edited e.ts · Ran pnpm test ×2 · Read a.ts +1 · Thought for 2s",
				"Edited e.ts · Ran pnpm test ×2 · Read 2 files · Thought for 2s",
				"Edited e.ts · Ran 2 commands · Read 2 files · Thought for 2s",
				"Edited 1 file · Ran 2 commands · Read 2 files · Thought for 2s",
			]);
		});

		it("has one form when there is nothing to name", () => {
			expect(
				forms(summaryOf([call("a", "TodoWrite"), call("b", "TodoWrite")])),
			).toEqual(["Updated todos"]);
		});

		// The same act on either CLI: Codex's plan updates are `Plan` rows.
		it("folds a Codex Plan row in with the todos", () => {
			expect(
				forms(summaryOf([call("a", "Plan"), call("b", "TodoWrite")])),
			).toEqual(["Updated todos"]);
		});
	});

	// Driven through the reducer, since what dissolved a group was a call
	// changing kind under it: a row turning into a card, a failure.
	describe("as the reducer streams a turn in", () => {
		const toolCall = (id: string, name: string) => ({
			type: "tool_call",
			tool_use_id: id,
			tool_name: name,
			tool_input: name === "Read" ? { file_path: `/${id}` } : { command: id },
		});
		const result = (id: string, isError = false) => ({
			type: "tool_result",
			tool_use_id: id,
			tool_result: "ok",
			is_error: isError,
		});
		const permission = (id: string) => ({
			type: "permission_request",
			request_id: `req-${id}`,
			tool_use_id: id,
			tool_name: "Bash",
			tool_input: { command: id },
		});
		const allow = (id: string) => ({
			type: "permission_response",
			request_id: `req-${id}`,
			choice: "allow",
		});

		/** The shape after each record in turn, as the reader saw it then. */
		function shapes(...records: object[]): string[][] {
			return records.map((_, end) => {
				const messages = replayHistory([
					{ type: "message", content: "Go" },
					...records.slice(0, end + 1),
				]);
				const last = messages.at(-1);
				const parts = last?.role === "assistant" ? last.parts : [];
				return shape(rowEntries(parts.map((part) => ({ part }))));
			});
		}

		it("never groups a running row that a permission card replaces", () => {
			expect(
				shapes(
					toolCall("r", "Read"),
					result("r"),
					toolCall("b", "Bash"),
					permission("b"),
				).slice(2),
			).toEqual([
				["r", "b"],
				["r", "card:b"],
			]);
		});

		it("pins a failure inside a group without dissolving it", () => {
			expect(
				shapes(
					toolCall("r1", "Read"),
					result("r1"),
					toolCall("r2", "Read"),
					result("r2"),
					toolCall("b", "Bash"),
					result("b", true),
				).slice(4),
			).toEqual([
				["[⟳ Running 1 command · Read 2 files]", "r1↓", "r2↓", "b↓"],
				["[Read 2 files]", "r1↓", "r2↓", "b"],
			]);
		});

		// Claude's order: the call, its card in the row's place, and after the
		// approval nothing but the activity that brings the row back.
		it("keeps an approved call in sight while it runs, and folds it once it settles", () => {
			expect(
				shapes(
					toolCall("r1", "Read"),
					result("r1"),
					toolCall("r2", "Read"),
					result("r2"),
					toolCall("b", "Bash"),
					permission("b"),
					allow("b"),
					{ type: "tool_activity", tool_use_id: "b", activity: "Running" },
					result("b"),
				).slice(6),
			).toEqual([
				["[Read 2 files]", "r1↓", "r2↓", "card:b"],
				["[Read 2 files]", "r1↓", "r2↓", "card:b", "b"],
				["[Ran 1 command · Read 2 files]", "r1↓", "r2↓", "card:b↓", "b↓"],
			]);
		});
	});
});
