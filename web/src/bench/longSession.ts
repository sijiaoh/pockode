import type {
	ChatPage,
	ChatTurn,
	ChatUpdate,
	ItemUpdate,
	PageItem,
	PageTurn,
	ToolItem,
} from "../types/chatItems";

/**
 * A long Claude session as the server would send it: its newest page of
 * items, plus factories for the live updates a benchmark streams into it.
 *
 * The shape is what a busy agent produces over a working day — every turn
 * plans (TodoWrite + `plan`), thinks, talks between runs of top-level calls,
 * spawns subagents that do their own calls and talk, and now and then resumes
 * an earlier subagent (`SendMessage`), whose new work is filed under the call
 * that spawned it. The last turn is still open: a subagent of it is running,
 * in the foreground or in the background, and is what child items stream
 * into.
 */

export interface LongSessionOptions {
	/** Settled turns before the open one. */
	turns: number;
	/** Top-level calls per turn, not counting TodoWrite or subagents. */
	callsPerTurn: number;
	/** Subagents spawned per turn. */
	agentsPerTurn: number;
	/** Calls each subagent makes. */
	childrenPerAgent: number;
	/** Every how many turns one earlier subagent is resumed. */
	resumeEvery: number;
	/**
	 * Whether the open turn's subagent was sent to the background, the main
	 * agent waiting on it — the attention strip's background row.
	 */
	background: boolean;
}

export const DEFAULT_LONG_SESSION: LongSessionOptions = {
	turns: 300,
	callsPerTurn: 56,
	agentsPerTurn: 2,
	childrenPerAgent: 10,
	resumeEvery: 10,
	background: false,
};

export interface LongSession {
	/** The whole session as one page. */
	page: ChatPage;
	/** How many tool calls the history holds, at every depth. */
	toolCalls: number;
	/** The open turn's running subagent's `tool_use_id`. */
	liveAgentId: string;
	/** Its item, which child items are nested in. */
	liveAgent: PageItem;
	liveTurnId: string;
	/** Seq and item id for the next live item, past everything the page holds. */
	nextSeq: number;
}

const TOOLS = ["Read", "Bash", "Grep", "Edit", "Glob"] as const;

function toolInput(name: string, n: number): unknown {
	const file = `/work/project/server/internal/pkg${n % 37}/module${n % 101}.go`;
	switch (name) {
		case "Read":
			return { file_path: file };
		case "Bash":
			return { command: `go test ./internal/pkg${n % 37}/... -run Test${n}` };
		case "Grep":
			return { pattern: `func Handle${n % 53}`, path: "/work/project" };
		case "Edit":
			return {
				file_path: file,
				old_string: `return nil // ${n}`,
				new_string: `return fmt.Errorf("case %d", ${n})`,
			};
		default:
			return { pattern: `**/*${n % 13}.go` };
	}
}

function toolResult(name: string, n: number): string {
	switch (name) {
		case "Read":
			return `package pkg${n % 37}\n\nfunc Handle() error {\n\treturn nil\n}\n`;
		case "Bash":
			return `ok  \tproject/internal/pkg${n % 37}\t0.${n % 900}s`;
		case "Edit":
			return "The file has been updated.";
		default:
			return `/work/project/a${n}.go\n/work/project/b${n}.go`;
	}
}

const PARAGRAPH =
	"Looked at how the handler retries; the backoff is applied twice when the server sends Retry-After, so the second attempt waits far longer than intended.";

/**
 * Builds items as the server's projection states them: each with the next id
 * and seq, a subagent's work nested in its call, every call settled with its
 * result unless left running.
 */
class Writer {
	readonly turns: PageTurn[] = [];
	private items: PageItem[] = [];
	private turn?: ChatTurn;
	private readonly runs = new Map<string, PageItem>();
	seq = 1;
	ids = 0;
	toolCalls = 0;
	private next(): number {
		return this.seq++;
	}
	private place(item: PageItem, parent?: string) {
		const run = parent ? this.runs.get(parent) : undefined;
		if (run?.tool) {
			run.tool.children = [...(run.tool.children ?? []), item];
			run.last_seq = item.last_seq;
		} else {
			this.items.push(item);
		}
	}
	id(prefix: string): string {
		return `${prefix}-${this.ids++}`;
	}
	say(content: string, parent?: string) {
		const n = this.next();
		this.place(
			{
				id: n,
				kind: "text",
				seq: n,
				last_seq: n,
				text: { content, ...(parent ? { parent_tool_use_id: parent } : {}) },
			},
			parent,
		);
	}
	think(content: string) {
		const n = this.next();
		this.place({
			id: n,
			kind: "thinking",
			seq: n,
			last_seq: n,
			thinking: { content, duration_ms: 1200 },
		});
	}
	message(content: string) {
		const n = this.next();
		const messageId = this.id("msg");
		this.turn = {
			turn_id: this.id("turn"),
			origin: "prompt",
			message_id: messageId,
			start_seq: n,
			ended: false,
		};
		this.items = [];
		this.place({
			id: n,
			kind: "message",
			seq: n,
			last_seq: n,
			message: { content, message_id: messageId },
		});
	}
	call(
		name: string,
		input: unknown,
		parent?: string,
		fields: Partial<ToolItem> = {},
	): PageItem {
		this.toolCalls++;
		const n = this.next();
		const id = this.id("call");
		const item: PageItem = {
			id: n,
			kind: "tool",
			seq: n,
			last_seq: n,
			tool: {
				tool_use_id: id,
				tool_name: name,
				tool_input: input,
				status: "running",
				...(parent ? { parent_tool_use_id: parent } : {}),
				...fields,
			},
		};
		this.runs.set(id, item);
		this.place(item, parent);
		return item;
	}
	result(item: PageItem, text: string, fields: Partial<ToolItem> = {}) {
		const n = this.next();
		item.last_seq = Math.max(item.last_seq ?? 0, n);
		if (item.tool) {
			Object.assign(item.tool, {
				status: "succeeded",
				result: { text, duration_ms: 800, seq: n },
				...fields,
			});
		}
	}
	tool(n: number, parent?: string) {
		const name = TOOLS[n % TOOLS.length];
		this.result(
			this.call(name, toolInput(name, n), parent),
			toolResult(name, n),
		);
	}
	plan(done: number, total: number) {
		const item = this.call("TodoWrite", { todos: [] });
		this.result(item, "Todos have been modified successfully.", {
			plan: {
				steps: Array.from({ length: total }, (_, i) => ({
					id: String(i + 1),
					text: `Step ${i + 1} of the plan`,
					status:
						i < done ? "completed" : i === done ? "in_progress" : "pending",
				})),
			},
		});
	}
	/** A subagent's call and its work; its result only when `settle`. */
	agent(n: number, children: number, settle: boolean): PageItem {
		const item = this.call("Agent", {
			description: `Investigate area ${n}`,
			subagent_type: "Explore",
			prompt: "Find where the retry is applied.",
		});
		const id = item.tool?.tool_use_id ?? "";
		this.say("Starting with the transport package.", id);
		for (let c = 0; c < children; c++) this.tool(n * 100 + c, id);
		this.say(PARAGRAPH, id);
		if (settle) {
			this.result(item, `${PARAGRAPH}\n\nagentId: agent-${id}`, {
				result: {
					text: `${PARAGRAPH}\n\nagentId: agent-${id}`,
					subagent: { agent_id: `agent-${id}`, agent_type: "Explore" },
				},
			});
		}
		return item;
	}
	resume(agentId: string, children: number, n: number) {
		const item = this.call("SendMessage", {
			to: `agent-${agentId}`,
			summary: "Follow up",
			message: "Now check the client side too.",
		});
		for (let c = 0; c < children; c++) this.tool(n * 1000 + c, agentId);
		this.result(item, "Message sent.");
	}
	/** Ends the turn the last message opened; `open` leaves it running. */
	close(open = false) {
		if (!this.turn) return;
		const turn: ChatTurn = open
			? this.turn
			: {
					...this.turn,
					ended: true,
					outcome: "completed",
					ended_by: "done",
					end_seq: this.next(),
				};
		this.turns.push({ turn, items: this.items });
	}
}

export function longSession(
	options: LongSessionOptions = DEFAULT_LONG_SESSION,
): LongSession {
	const w = new Writer();
	const agents: string[] = [];
	for (let t = 0; t < options.turns; t++) {
		w.message(`Turn ${t}: fix the retry handling in package ${t}.`);
		w.think("Planning how to approach this.");
		w.say(`On it — turn ${t}.`);
		w.plan(3, 5);
		for (let c = 0; c < options.callsPerTurn; c++) {
			w.tool(t * 1000 + c);
			if (c % 8 === 7) w.say(PARAGRAPH);
		}
		for (let a = 0; a < options.agentsPerTurn; a++) {
			const agent = w.agent(t * 10 + a, options.childrenPerAgent, true);
			agents.push(agent.tool?.tool_use_id ?? "");
		}
		if (t > 0 && t % options.resumeEvery === 0) {
			w.resume(agents[agents.length - 3], 3, t);
		}
		w.say(`${PARAGRAPH}\n\n${PARAGRAPH}`);
		w.close();
	}

	// The open turn: a plan under way, calls made, a subagent still working.
	w.message("Now the client side, please.");
	w.say("Looking at the client.");
	w.plan(1, 6);
	for (let c = 0; c < 30; c++) w.tool(9_000_000 + c);
	const live = w.agent(9_999, 5, false);
	if (options.background) {
		live.tool = {
			...(live.tool as ToolItem),
			status: "background",
			backgrounded: true,
			placeholder: "Async agent launched successfully.",
		};
	}
	w.close(true);
	const liveTurn = w.turns.at(-1)?.turn;

	return {
		page: { turns: w.turns, has_more: false, through_seq: w.seq - 1 },
		toolCalls: w.toolCalls,
		liveAgentId: live.tool?.tool_use_id ?? "",
		liveAgent: live,
		liveTurnId: liveTurn?.turn_id ?? "",
		nextSeq: w.seq,
	};
}

/**
 * The live updates a benchmark streams, one kind at a time. Each makes a new
 * item, or changes one, with a seq past the page's, so none is skipped as
 * already loaded.
 */
export function liveRecords(session: LongSession) {
	let seq = session.nextSeq;
	let n = 0;
	const turnId = session.liveTurnId;
	const { children: _, ...agentTool } = session.liveAgent.tool as ToolItem;
	const agent = { ...session.liveAgent, tool: agentTool };
	const at = (fields: Omit<PageItem, "id" | "seq" | "last_seq">): PageItem => {
		const s = seq++;
		return { id: s, seq: s, last_seq: s, ...fields } as PageItem;
	};
	const updateOf = (...items: ItemUpdate[]): ChatUpdate => ({
		type: "update",
		through_seq: seq - 1,
		items,
	});
	/** A child changing: its run's `last_seq` moves with it. */
	const inAgent = (child: PageItem): ChatUpdate =>
		updateOf(
			{ turn_id: turnId, item: { ...agent, last_seq: child.last_seq } },
			{ parent: agent.id, item: child },
		);
	const settled = (call: PageItem, text: string): PageItem => ({
		...call,
		last_seq: seq++,
		tool: {
			...(call.tool as ToolItem),
			status: "succeeded",
			result: { text },
		},
	});
	return {
		/**
		 * The main agent's words. Back to back they join into one text part, so
		 * the open paragraph grows with every one and is parsed again each time:
		 * kept to a sentence, so that growth stays the size of a long reply
		 * rather than of a book.
		 */
		text: (): ChatUpdate =>
			updateOf({
				turn_id: turnId,
				item: at({
					kind: "text",
					text: { content: `Checked the retry path (${n++}).` },
				}),
			}),
		/** A top-level call, then its result. */
		topLevelCall: (): ChatUpdate[] => {
			const call = at({
				kind: "tool",
				tool: {
					tool_use_id: `live-top-${n++}`,
					tool_name: "Read",
					tool_input: { file_path: `/work/project/web/src/file${n}.ts` },
					status: "running",
				},
			});
			return [
				updateOf({ turn_id: turnId, item: call }),
				updateOf({ turn_id: turnId, item: settled(call, "ok") }),
			];
		},
		/** A call of the running subagent's, then its result. */
		childCall: (): ChatUpdate[] => {
			const call = at({
				kind: "tool",
				tool: {
					tool_use_id: `live-child-${n++}`,
					tool_name: "Grep",
					tool_input: { pattern: `retry${n}`, path: "/work/project/web" },
					parent_tool_use_id: session.liveAgentId,
					status: "running",
				},
			});
			return [inAgent(call), inAgent(settled(call, "web/src/lib/retry.ts:12"))];
		},
		/** The running subagent's words. */
		childText: (): ChatUpdate =>
			inAgent(
				at({
					kind: "text",
					text: {
						content: `Checked candidate ${n++}.`,
						parent_tool_use_id: session.liveAgentId,
					},
				}),
			),
	};
}

/** Records an item stands for, as the server's page budget counts them. */
function recordsOf(item: PageItem): number {
	const tool = item.tool;
	if (!tool) return 1;
	let n = tool.result ? 2 : 1;
	for (const child of tool.children ?? []) n += recordsOf(child);
	return n;
}

/**
 * The session cut into pages the way the server cuts them: newest first,
 * `limit` records each, ending on the item that uses the budget up, a turn
 * split across pages marked `continued` on its newer part. Oldest page first,
 * as `resetChatHistoryServer` takes them.
 */
export function pagedSession(session: LongSession, limit = 50): ChatPage[] {
	const flat = session.page.turns.flatMap((t) =>
		t.items.map((item, i) => ({ turn: t.turn, item, first: i === 0 })),
	);
	const pages: ChatPage[] = [];
	let end = flat.length;
	while (end > 0) {
		let start = end;
		let budget = 0;
		while (start > 0 && budget < limit) budget += recordsOf(flat[--start].item);
		const turns: PageTurn[] = [];
		for (let i = start; i < end; i++) {
			const { turn, item, first } = flat[i];
			const last = turns.at(-1);
			if (last && last.turn === turn) last.items.push(item);
			else turns.push({ turn, continued: !first, items: [item] });
		}
		pages.unshift({ turns, has_more: start > 0 });
		end = start;
	}
	const newest = pages.at(-1);
	if (newest) newest.through_seq = session.page.through_seq;
	return pages;
}
