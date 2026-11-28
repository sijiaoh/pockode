import { beforeEach, describe, expect, it } from "vitest";
import {
	changed,
	changedTool,
	codexPlan,
	ended,
	error,
	msg,
	noTurn,
	page,
	question,
	read,
	resetItems,
	text,
	thinking,
	tool,
	turn,
	update,
	warning,
} from "../test/chatItemsFixture";
import type { ChatPage, ChatTurn } from "../types/chatItems";
import type {
	AssistantMessage,
	ContentPart,
	Message,
	UserMessage,
} from "../types/message";
import {
	addEcho,
	addOlderPage,
	applyToolDelta,
	applyUpdate,
	beginOlderPage,
	type ChatItems,
	createChatItems,
	failEcho,
	installNewestPage,
	pressAnswer,
	removeEcho,
	settleEcho,
} from "./chatItems";
import { buildTranscript, createTranscriptCache } from "./transcript";

function load(p: ChatPage, live = true) {
	const store = createChatItems();
	const cache = createTranscriptCache();
	installNewestPage(store, p, undefined, undefined);
	const build = () => buildTranscript(store, cache, { live });
	return { store, build };
}

function assistants(messages: Message[]): AssistantMessage[] {
	return messages.filter((m): m is AssistantMessage => m.role === "assistant");
}

function shape(messages: Message[]): string[] {
	return messages.map((m) =>
		m.role === "user"
			? `user:${m.content}`
			: `assistant:${m.status}:${m.parts.map(partLabel).join(",")}`,
	);
}

function partLabel(part: ContentPart): string {
	switch (part.type) {
		case "text":
			return part.content;
		case "tool_call":
			return `${part.tool.name}(${part.tool.status})`;
		case "permission_request":
			return `card(${part.status})`;
		case "question_record":
			return `question(${part.status})`;
		case "thinking":
			return `thinking×${part.thoughts.length}`;
		default:
			return part.type;
	}
}

beforeEach(resetItems);

describe("buildTranscript", () => {
	it("draws a turn as its message and the reply under it", () => {
		const { build } = load(
			page([
				turn({}, msg("hi"), text("Looking."), tool("Read"), text("Done.")),
			]),
		);
		expect(shape(build())).toEqual([
			"user:hi",
			"assistant:complete:Looking.,Read(success),Done.",
		]);
	});

	it("joins a speaker's consecutive texts and thinking into one part", () => {
		const { build } = load(
			page([
				turn(
					{},
					msg("hi"),
					thinking("a"),
					thinking("b"),
					text("one"),
					text("two"),
				),
			]),
		);
		const [, reply] = build() as [UserMessage, AssistantMessage];
		expect(reply.parts.map(partLabel)).toEqual(["thinking×2", "one\n\ntwo"]);
	});

	it("leaves out a thinking that would draw nothing", () => {
		const { build } = load(
			page([turn({}, msg("hi"), thinking(""), text("ok"))]),
		);
		expect(shape(build())).toEqual(["user:hi", "assistant:complete:ok"]);
	});

	it("streams the newest turn while it is open, and finishes any other", () => {
		const { build } = load(
			page([
				turn({ ended: false }, msg("old"), text("cut off")),
				turn({ ended: false }, msg("new"), text("going")),
			]),
		);
		expect(shape(build())).toEqual([
			"user:old",
			"assistant:complete:cut off",
			"user:new",
			"assistant:streaming:going",
		]);
	});

	it("draws an open turn as finished in a transcript nobody follows", () => {
		const { build } = load(
			page([turn({ ended: false }, msg("hi"), text("going"))]),
			false,
		);
		expect(shape(build())).toEqual(["user:hi", "assistant:complete:going"]);
	});

	it("leaves an empty reply in place while its turn is open", () => {
		const { build } = load(page([turn({ ended: false }, msg("hi"))]));
		expect(shape(build())).toEqual(["user:hi", "assistant:streaming:"]);
	});

	it("draws how a turn ended on its last bubble", () => {
		const { build } = load(
			page([
				turn(
					{ outcome: "aborted", ended_by: "interrupted" },
					msg("a"),
					text("x"),
				),
				turn({ outcome: "aborted", ended_by: "process_ended" }, msg("b")),
				turn(
					{ outcome: "failed", ended_by: "failed" },
					msg("c"),
					error("boom"),
				),
				turn({}, msg("d")),
			]),
		);
		const messages = build();
		expect(shape(messages)).toEqual([
			"user:a",
			"assistant:interrupted:x",
			"user:b",
			"assistant:process_ended:",
			"user:c",
			"assistant:error:",
			"user:d",
		]);
		expect(assistants(messages)[2].error).toBe("boom");
	});

	it("says on its turn which messages a Stop threw away", () => {
		const hi = msg("hi");
		const x = text("x");
		const sent = msg("later", { discarded: true });
		const { build } = load(
			page([
				turn(
					{
						outcome: "aborted",
						ended_by: "interrupted",
						discarded: [{ message_id: sent.message?.message_id }],
					},
					hi,
					x,
					sent,
				),
			]),
		);
		const messages = build();
		expect(shape(messages)).toEqual([
			"user:hi",
			"assistant:interrupted:x",
			"user:later",
		]);
		expect(assistants(messages)[0].discardedMessageIds).toEqual([
			sent.message?.message_id,
		]);
	});

	it("draws a message sent mid-turn under the reply, split where the agent read it", () => {
		const hi = msg("hi");
		const one = text("one");
		const steer = msg("also this");
		const { build } = load(
			page([
				turn(
					{ ended: false },
					hi,
					one,
					steer,
					text("two"),
					read(steer.message?.message_id),
					text("three"),
				),
			]),
		);
		const messages = build();
		expect(shape(messages)).toEqual([
			"user:hi",
			"assistant:complete:one\n\ntwo",
			"user:also this",
			"assistant:streaming:three",
		]);
		const [, first] = messages as [UserMessage, AssistantMessage];
		// A fork from the first reply cuts above the message drawn under it.
		expect(first.anchorSeq).toBeLessThan(steer.seq as number);
		expect(first.endedAt).toBeDefined();
	});

	it("puts a turn's ending seq on its last bubble's anchor", () => {
		const t = turn({}, msg("hi"), text("x"));
		const { build } = load(page([t]));
		expect(assistants(build())[0].anchorSeq).toBe(t.turn?.end_seq);
	});

	it("draws a call waiting on permission as the card in its row's place", () => {
		const hi = msg("hi");
		const call = tool(
			"Bash",
			{ command: "ls" },
			{
				status: "awaiting_permission",
				permission: { request_id: "p1", status: "pending" },
			},
		);
		const { store, build } = load(page([turn({ ended: false }, hi, call)]));
		const card = assistants(build())[0].parts[0];
		expect(card).toMatchObject({
			id: expect.any(String),
			type: "permission_request",
			status: "pending",
			request: { requestId: "p1", toolUseId: call.tool?.tool_use_id },
		});

		pressAnswer(store, "p1", "allowed");
		expect(assistants(build())[0].parts[0]).toMatchObject({
			type: "permission_request",
			status: "allowed",
		});
		expect(store.pressed.has("p1")).toBe(true);

		applyUpdate(
			store,
			update({
				items: [
					changedTool(call, {
						status: "running",
						permission: {
							request_id: "p1",
							status: "allowed",
							choice: "allow",
						},
					}),
				],
				turnId: "turn-1",
			}),
			new Date(),
		);
		const row = assistants(build())[0].parts[0];
		expect(row).toMatchObject({
			id: (card as { id: string }).id,
			type: "tool_call",
			tool: { status: "running", permission: { answer: "allowed" } },
		});
		expect(store.pressed.has("p1")).toBe(false);
	});

	it("keeps an expired request a card, with why", () => {
		const { build } = load(
			page([
				turn(
					{},
					msg("hi"),
					tool(
						"Bash",
						{},
						{
							status: "expired",
							permission: {
								request_id: "p1",
								status: "expired",
								reason: "timeout",
							},
						},
					),
				),
			]),
		);
		expect(assistants(build())[0].parts[0]).toMatchObject({
			type: "permission_request",
			status: "expired",
			reason: "timeout",
		});
	});

	it("draws a posted question in the place of the call that posted it", () => {
		const hi = msg("hi");
		const post = tool("mcp__pockode__question_post");
		const { build } = load(
			page([
				turn(
					{},
					hi,
					post,
					question("Which?", { asked_at: "t1" }),
					question("And?", { asked_at: "t1", status: "answered" }),
				),
			]),
		);
		const parts = assistants(build())[0].parts;
		expect(parts.map(partLabel)).toEqual([
			"question(pending)",
			"question(answered)",
		]);
	});

	it("files a subagent's work under its call, and its unfiled words by whose they are", () => {
		const hi = msg("hi");
		const child = tool("Read", {}, { parent_tool_use_id: "tu-sub" });
		const sub = tool("Task", {}, { tool_use_id: "tu-sub", children: [child] });
		const { build } = load(page([turn({}, hi, sub, text("stray", "tu-gone"))]));
		const [row, stray] = assistants(build())[0].parts;
		expect(
			row.type === "tool_call" && row.tool.children?.map(partLabel),
		).toEqual(["Read(success)"]);
		expect(stray).toMatchObject({ type: "text", parentToolUseId: "tu-gone" });
	});

	it("files a fetch on the call it reads, and waits on it while it runs", () => {
		const hi = msg("hi");
		const task = tool("Bash", {}, { status: "background", backgrounded: true });
		const fetch = tool(
			"TaskOutput",
			{},
			{
				status: "running",
				origin_tool_use_id: task.tool?.tool_use_id,
			},
		);
		const { build } = load(page([turn({ ended: false }, hi, task, fetch)]));
		const reply = assistants(build())[0];
		expect(reply.parts).toHaveLength(1);
		expect(reply.parts[0]).toMatchObject({
			tool: { fetches: [{ id: fetch.tool?.tool_use_id, state: "running" }] },
		});
		expect(reply.awaitedFetch).toEqual({
			id: fetch.tool?.tool_use_id,
			originToolUseId: task.tool?.tool_use_id,
			waits: true,
		});
	});

	it("draws a fetch whose call is not loaded as a row of its own", () => {
		const { build } = load(
			page([
				turn(
					{},
					msg("hi"),
					tool("TaskOutput", {}, { origin_tool_use_id: "tu-elsewhere" }),
				),
			]),
		);
		expect(assistants(build())[0].parts.map(partLabel)).toEqual([
			"TaskOutput(success)",
		]);
	});

	it("draws a Codex plan as a settled Plan row", () => {
		const { build } = load(
			page([
				turn({}, msg("hi"), codexPlan([{ text: "a", status: "pending" }])),
			]),
		);
		expect(assistants(build())[0].parts[0]).toMatchObject({
			type: "tool_call",
			tool: {
				name: "Plan",
				status: "success",
				plan: { steps: [{ text: "a" }] },
			},
		});
	});

	it("keeps a background call's placeholder apart from its outcome", () => {
		const { build } = load(
			page([
				turn(
					{},
					msg("hi"),
					tool(
						"Bash",
						{},
						{
							status: "background",
							backgrounded: true,
							placeholder: "started",
							result: { text: "started", subtype: "background_started" },
						},
					),
				),
			]),
		);
		const row = assistants(build())[0].parts[0];
		expect(row.type === "tool_call" && row.tool).toMatchObject({
			status: "background",
			placeholderResult: "started",
			fromBackground: true,
		});
		expect(row.type === "tool_call" && row.tool.result).toBeUndefined();
	});

	it("draws items outside every turn", () => {
		const { build } = load(page([noTurn(msg("legacy"), warning("odd"))]));
		expect(shape(build())).toEqual([
			"user:legacy",
			"assistant:complete:warning",
		]);
	});
});

describe("ChatItems", () => {
	it("hands back the same objects for what an update did not touch", () => {
		const first = turn({}, msg("old"), text("done"));
		const live = turn({ ended: false }, msg("new"));
		const { store, build } = load(page([first, live]));
		const before = build();
		applyUpdate(
			store,
			update({ items: [text("more")], turnId: live.turn?.turn_id }),
			new Date(),
		);
		const after = build();
		expect(after[0]).toBe(before[0]);
		expect(after[1]).toBe(before[1]);
		expect(shape(after).at(-1)).toBe("assistant:streaming:more");
	});

	it("skips what the page already holds, but still ends its streams", () => {
		const hi = msg("hi");
		const call = tool("Bash", {}, { status: "running" });
		const p = page([turn({ ended: false }, hi, call)]);
		const store = createChatItems();
		installNewestPage(
			store,
			p,
			{
				tools: { [call.tool?.tool_use_id ?? ""]: { activity: "Running" } },
			},
			undefined,
		);
		applyUpdate(
			store,
			{
				...update({ items: [text("dup")], turnId: "turn-1" }),
				through_seq: p.through_seq,
				streams_ended: { tools: [call.tool?.tool_use_id ?? ""] },
			},
			new Date(),
		);
		const messages = buildTranscript(store, createTranscriptCache(), {
			live: true,
		});
		expect(shape(messages)).toEqual([
			"user:hi",
			"assistant:streaming:Bash(running)",
		]);
		expect(store.streams.size).toBe(0);
	});

	it("moves a call under the subagent call that arrives after it", () => {
		const hi = msg("hi");
		const child = tool(
			"Read",
			{},
			{ status: "running", parent_tool_use_id: "tu-sub" },
		);
		const t = turn({ ended: false }, hi, child);
		const { store, build } = load(page([t]));
		const sub = tool("Task", {}, { tool_use_id: "tu-sub", status: "running" });
		applyUpdate(
			store,
			update({
				items: [
					{ item: sub, turn_id: t.turn?.turn_id },
					{ item: changed(child, {}), parent: sub.id },
				],
			}),
			new Date(),
		);
		const parts = assistants(build())[0].parts;
		expect(parts.map(partLabel)).toEqual(["Task(running)"]);
		expect(
			parts[0].type === "tool_call" && parts[0].tool.children?.map(partLabel),
		).toEqual(["Read(running)"]);
	});

	it("redraws a turn a row has left, and only that turn", () => {
		const settled = turn({}, msg("old"), text("done"));
		const hi = msg("hi");
		const child = tool(
			"Read",
			{},
			{ status: "running", parent_tool_use_id: "tu-sub" },
		);
		const after = text("after");
		const t = turn({ ended: false }, hi, child, after);
		const { store, build } = load(page([settled, t]));
		const before = build();
		const sub = tool("Task", {}, { tool_use_id: "tu-sub", status: "running" });
		applyUpdate(
			store,
			update({
				items: [
					{ item: sub, turn_id: t.turn?.turn_id },
					{ item: changed(child, {}), parent: sub.id },
				],
			}),
			new Date(),
		);
		const next = build();
		expect(next[0]).toBe(before[0]);
		expect(next[1]).toBe(before[1]);
		expect(assistants(next).at(-1)?.parts.map(partLabel)).toEqual([
			"after",
			"Task(running)",
		]);
	});

	it("builds after each change what a build from nothing would", () => {
		const older = turn({}, msg("first"), text("a"), tool("Read"));
		const t1 = turn({}, msg("one"), text("b"), tool("Bash"));
		const t2 = turn({ ended: false }, msg("two"), text("c"));
		const { store, build } = load(
			page([t1, t2], {
				has_more: true,
				next_before_seq: t1.items[0].seq,
			}),
		);
		// Built from a copy, so the store's own transcript still sees only
		// what changed since it last looked.
		const fresh = () =>
			buildTranscript(
				structuredClone({ ...store, rowsTakenBy: undefined }),
				createTranscriptCache(),
				{ live: true },
			);
		const child = tool(
			"Read",
			{},
			{ status: "running", parent_tool_use_id: "tu-late" },
		);
		const late = tool("Task", {}, { tool_use_id: "tu-late" });
		const t3 = turn({ ended: false }, msg("three"));
		const steps: (() => void)[] = [
			() =>
				applyUpdate(
					store,
					update({ items: [text("more")], turnId: t2.turn?.turn_id }),
					new Date(),
				),
			() =>
				applyUpdate(
					store,
					update({ items: [child], turnId: t2.turn?.turn_id }),
					new Date(),
				),
			() =>
				applyUpdate(
					store,
					update({ items: [tool("Grep")], turnId: t2.turn?.turn_id }),
					new Date(),
				),
			() =>
				applyUpdate(
					store,
					update({
						items: [
							{ item: late, turn_id: t2.turn?.turn_id },
							{ item: changed(child, {}), parent: late.id },
						],
					}),
					new Date(),
				),
			() =>
				applyUpdate(
					store,
					update({
						turns: [ended(t2)],
						items: [
							{
								item: changedTool(t1.items[2], { status: "failed" }),
								turn_id: t1.turn?.turn_id,
							},
						],
					}),
					new Date(),
				),
			() =>
				applyUpdate(
					store,
					update({
						turns: [{ turn: t3.turn as ChatTurn }],
						items: t3.items.map((item) => ({
							item,
							turn_id: t3.turn?.turn_id,
						})),
					}),
					new Date(),
				),
			() =>
				applyUpdate(
					store,
					update({ items: [text("d")], turnId: t3.turn?.turn_id }),
					new Date(),
				),
			() => addOlderPage(store, page([older]), undefined),
			() => {},
			// A send that failed and was never recorded stays drawn; the
			// transcript keeps changing around it, and it goes.
			() =>
				addEcho(store, {
					message: {
						id: "echo-lost",
						role: "user",
						content: "lost",
						status: "complete",
						createdAt: new Date(0),
					},
					awaitingReply: true,
				}),
			() => failEcho(store, "echo-lost", "timed out"),
			() =>
				applyUpdate(
					store,
					update({ items: [text("e")], turnId: t3.turn?.turn_id }),
					new Date(),
				),
			() =>
				applyUpdate(
					store,
					update({
						turns: [ended(t3)],
						items: [
							{
								item: changedTool(t1.items[2], { status: "succeeded" }),
								turn_id: t1.turn?.turn_id,
							},
						],
					}),
					new Date(),
				),
			() => removeEcho(store, "echo-lost"),
			() =>
				applyUpdate(
					store,
					update({ items: [text("f")], turnId: t3.turn?.turn_id }),
					new Date(),
				),
		];
		expect(build()).toEqual(fresh());
		for (const step of steps) {
			step();
			expect(build()).toEqual(fresh());
		}
		// Another transcript of the same store takes what changed in between.
		applyUpdate(
			store,
			update({
				items: [changedTool(t1.items[2], { status: "succeeded" })],
				turnId: t1.turn?.turn_id,
			}),
			new Date(),
		);
		buildTranscript(store, createTranscriptCache(), { live: true });
		expect(build()).toEqual(fresh());
	});

	it("ignores a change to an item on a page it never loaded", () => {
		const old = tool("Bash", {}, { status: "background" });
		const t = turn({}, msg("hi"), text("x"));
		// `old` is item 1, older than the page's cursor.
		const { store, build } = load(
			page([t], { has_more: true, next_before_seq: 2 }),
		);
		applyUpdate(
			store,
			update({
				items: [changedTool(old, { status: "succeeded" })],
				turnId: "turn-0",
			}),
			new Date(),
		);
		expect(shape(build())).toEqual(["user:hi", "assistant:complete:x"]);
	});

	it("applies a change that beat the older page being fetched to it", () => {
		const first = msg("first");
		const bg = tool("Bash", {}, { status: "background" });
		const older = turn({ ended: false }, first, bg);
		const cut = page([older]);
		const newer = turn({}, msg("second"), text("b"));
		const { store, build } = load(
			page([newer], { has_more: true, next_before_seq: newer.items[0].seq }),
		);
		beginOlderPage(store);
		// The page was cut before the call settled, and the update saying so
		// arrived first.
		applyUpdate(
			store,
			update({
				items: [changedTool(bg, { status: "succeeded" })],
				turnId: older.turn?.turn_id,
			}),
			new Date(),
		);
		addOlderPage(store, cut, undefined);
		expect(shape(build()).slice(0, 2)).toEqual([
			"user:first",
			"assistant:complete:Bash(success)",
		]);
	});

	it("keeps an older page's item over a change the page was cut after", () => {
		const first = msg("first");
		const bg = tool("Bash", {}, { status: "background" });
		const older = turn({ ended: false }, first, bg);
		const newer = turn({}, msg("second"), text("b"));
		const { store, build } = load(
			page([newer], { has_more: true, next_before_seq: newer.items[0].seq }),
		);
		beginOlderPage(store);
		const settled = changedTool(bg, { status: "succeeded" });
		applyUpdate(
			store,
			update({ items: [settled], turnId: older.turn?.turn_id }),
			new Date(),
		);
		// Cut after a later change still: what it says is newer than the update.
		const failed = changedTool(bg, { status: "failed" });
		addOlderPage(
			store,
			page([{ ...older, items: [first, failed] }]),
			undefined,
		);
		expect(shape(build()).slice(0, 2)).toEqual([
			"user:first",
			"assistant:complete:Bash(error)",
		]);
	});

	it("adds an older page in front, keeping the part ids already drawn", () => {
		const older = turn({}, msg("first"), text("a"));
		const newer = turn({}, msg("second"), text("b"));
		const store = createChatItems();
		const cache = createTranscriptCache();
		installNewestPage(
			store,
			page([newer], { has_more: true, next_before_seq: newer.items[0].seq }),
			undefined,
			undefined,
		);
		const before = buildTranscript(store, cache, { live: true });
		addOlderPage(store, page([older]), undefined);
		const after = buildTranscript(store, cache, { live: true });
		expect(shape(after)).toEqual([
			"user:first",
			"assistant:complete:a",
			"user:second",
			"assistant:complete:b",
		]);
		expect(after[3]).toBe(before[1]);
		expect(store.cursor).toBeUndefined();
	});

	it("says which reply a page boundary cut the start off, until that page joins it", () => {
		const hi = msg("hi");
		const a = text("a");
		const b = text("b");
		const steer = msg("also this");
		const whole = turn(
			{},
			hi,
			a,
			b,
			steer,
			read(steer.message?.message_id),
			text("c"),
		);
		const rest = whole.items.slice(2);
		const store = createChatItems();
		const cache = createTranscriptCache();
		installNewestPage(
			store,
			page([{ ...whole, items: rest, continued: true }], {
				has_more: true,
				next_before_seq: rest[0].seq,
			}),
			undefined,
			undefined,
		);
		const cut = assistants(buildTranscript(store, cache, { live: true }));
		expect(cut.map((m) => m.startNotLoaded)).toEqual([true, undefined]);

		addOlderPage(store, page([{ ...whole, items: [hi, a] }]), undefined);
		const joined = assistants(buildTranscript(store, cache, { live: true }));
		expect(joined.map((m) => m.startNotLoaded)).toEqual([undefined, undefined]);
	});

	it("draws what a call in flight says about itself, until its stream ends", () => {
		const hi = msg("hi");
		const call = tool("Bash", {}, { status: "running" });
		const t = turn({ ended: false }, hi, call);
		const { store, build } = load(page([t]));
		const id = call.tool?.tool_use_id ?? "";
		applyToolDelta(store, id, { activity: "Testing", output: "ok 1\n" });
		applyToolDelta(store, id, { output: "ok 2\n" });
		const row = assistants(build())[0].parts[0];
		expect(row.type === "tool_call" && row.tool).toMatchObject({
			activity: "Testing",
			output: "ok 1\nok 2\n",
		});
		applyUpdate(
			store,
			update({
				items: [
					changedTool(call, { status: "succeeded", result: { text: "ok" } }),
				],
				turnId: t.turn?.turn_id,
				streams_ended: { tools: [id] },
			}),
			new Date(),
		);
		const settled = assistants(build())[0].parts[0];
		expect(settled.type === "tool_call" && settled.tool.output).toBeUndefined();
	});

	it("keeps only the last lines of a call's output, counting what it lost", () => {
		const hi = msg("hi");
		const call = tool("Bash", {}, { status: "running" });
		const { store, build } = load(page([turn({ ended: false }, hi, call)]));
		const lines = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
		applyToolDelta(store, call.tool?.tool_use_id ?? "", { output: lines });
		const row = assistants(build())[0].parts[0];
		expect(row.type === "tool_call" && row.tool.outputDroppedLines).toBe(50);
	});

	it("ends a turn on the bubble already drawn", () => {
		const t = turn({ ended: false }, msg("hi"), text("x"));
		const { store, build } = load(page([t]));
		applyUpdate(
			store,
			update({
				turns: [ended(t, { outcome: "aborted", ended_by: "interrupted" })],
			}),
			new Date(),
		);
		expect(shape(build())).toEqual(["user:hi", "assistant:interrupted:x"]);
	});
});

describe("a message this client sent", () => {
	function send(store: ChatItems, content: string, opensTurn = true) {
		const message: UserMessage = {
			id: `echo-${content}`,
			role: "user",
			content,
			status: "complete",
			createdAt: new Date(),
		};
		addEcho(store, {
			message,
			awaitingReply: true,
			...(opensTurn ? { replyId: `reply-${content}` } : {}),
		});
		return message;
	}

	it("is drawn at once with a placeholder, and keeps its keys once recorded", () => {
		const { store, build } = load(page([turn({}, msg("before"))]));
		send(store, "hi");
		expect(
			build()
				.slice(-2)
				.map((m) => [m.id, m.role === "assistant" && m.status]),
		).toEqual([
			["echo-hi", false],
			["reply-hi", "sending"],
		]);

		settleEcho(store, "echo-hi", {
			itemId: 100,
			seq: 100,
			update: { messageId: "m-hi" },
		});
		applyUpdate(
			store,
			{
				type: "update",
				through_seq: 101,
				turns: [
					{
						turn: {
							turn_id: "t-hi",
							origin: "prompt",
							message_id: "m-hi",
							start_seq: 101,
							ended: false,
						},
					},
				],
				items: [
					{
						turn_id: "t-hi",
						item: {
							id: 100,
							kind: "message",
							seq: 100,
							last_seq: 100,
							message: { message_id: "m-hi", content: "hi" },
						},
					},
				],
			},
			new Date(),
		);
		const tail = build().slice(-2);
		expect(tail.map((m) => m.id)).toEqual(["echo-hi", "reply-hi"]);
		expect((tail[0] as UserMessage).anchorSeq).toBe(100);
		expect((tail[1] as AssistantMessage).status).toBe("streaming");
	});

	it("is recognised in the turn it opened before the reply says where it went", () => {
		const { store, build } = load(page([turn({}, msg("before"))]));
		send(store, "hi");
		applyUpdate(
			store,
			{
				type: "update",
				through_seq: 101,
				turns: [
					{
						turn: {
							turn_id: "t-hi",
							origin: "prompt",
							message_id: "m-hi",
							start_seq: 101,
							ended: false,
						},
					},
				],
				items: [
					{
						turn_id: "t-hi",
						item: {
							id: 100,
							kind: "message",
							seq: 100,
							last_seq: 100,
							message: { message_id: "m-hi", content: "hi" },
						},
					},
				],
			},
			new Date(),
		);
		const messages = build();
		expect(
			messages.filter((m) => m.role === "user" && m.content === "hi"),
		).toHaveLength(1);
		expect(messages.slice(-2).map((m) => m.id)).toEqual([
			"echo-hi",
			"reply-hi",
		]);
	});

	it("draws two quick sends in the order they were made", () => {
		const { store, build } = load(page([turn({}, msg("before"))]));
		send(store, "A");
		send(store, "B", false);
		settleEcho(store, "echo-A", {
			itemId: 100,
			seq: 100,
			update: { messageId: "m-A" },
		});
		const users = build()
			.filter((m) => m.role === "user")
			.map((m) => m.content);
		expect(users).toEqual(["before", "A", "B"]);
	});

	it("lets the reply say which item a send became, over a guess", () => {
		const { store, build } = load(page([turn({}, msg("before"))]));
		send(store, "A", false);
		send(store, "B");
		// B's turn starts, bringing B's item before either reply.
		applyUpdate(
			store,
			{
				type: "update",
				through_seq: 102,
				turns: [
					{
						turn: {
							turn_id: "t-B",
							origin: "prompt",
							message_id: "m-B",
							start_seq: 102,
							ended: false,
						},
					},
				],
				items: [
					{
						turn_id: "t-B",
						item: {
							id: 101,
							kind: "message",
							seq: 101,
							last_seq: 101,
							message: { message_id: "m-B", content: "B" },
						},
					},
				],
			},
			new Date(),
		);
		settleEcho(store, "echo-A", {
			itemId: 100,
			seq: 100,
			update: { messageId: "m-A" },
		});
		settleEcho(store, "echo-B", {
			itemId: 101,
			seq: 101,
			update: { messageId: "m-B" },
		});
		const users = build().filter((m) => m.role === "user");
		expect(users.map((m) => [m.id, m.content])).toEqual([
			[expect.any(String), "before"],
			["echo-A", "A"],
			["echo-B", "B"],
		]);
	});

	it("is not drawn twice when a send that failed here was recorded after all", () => {
		const { store, build } = load(page([turn({}, msg("before"))]));
		send(store, "hi");
		failEcho(store, "echo-hi", "timed out");
		// Its own record, over a new connection after the one it went on dropped.
		applyUpdate(
			store,
			{
				type: "update",
				through_seq: 100,
				items: [
					{
						item: {
							id: 100,
							kind: "message",
							seq: 100,
							last_seq: 100,
							message: { message_id: "m-hi", content: "hi" },
						},
					},
				],
			},
			new Date(),
		);
		const hi = build().filter((m) => m.role === "user" && m.content === "hi");
		expect(hi).toHaveLength(1);
		expect(hi[0].id).toBe("echo-hi");
		expect(store.echoes[0].error).toBeUndefined();
	});

	it("is not drawn twice when a fresh page already holds it", () => {
		const first = page([turn({}, msg("before"))]);
		const { store, build } = load(first);
		send(store, "hi");
		installNewestPage(
			store,
			{
				...first,
				turns: [
					...first.turns,
					{
						turn: {
							turn_id: "t-hi",
							origin: "prompt",
							message_id: "m-hi",
							start_seq: 101,
							ended: false,
						},
						items: [
							{
								id: 100,
								kind: "message",
								seq: 100,
								last_seq: 100,
								message: { message_id: "m-hi", content: "hi" },
							},
						],
					},
				],
				through_seq: 101,
			},
			undefined,
			undefined,
		);
		const hi = build().filter((m) => m.role === "user" && m.content === "hi");
		expect(hi).toHaveLength(1);
		expect(hi[0].id).toBe("echo-hi");
	});
});
