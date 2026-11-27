/**
 * A long Claude session as the server would replay it: history records, oldest
 * first, plus factories for the live records a benchmark streams into it.
 *
 * The shape is what a busy agent produces over a working day — every turn
 * plans (TodoWrite + `plan`), thinks, talks between runs of top-level calls,
 * spawns subagents that do their own calls and talk, and now and then resumes
 * an earlier subagent (`SendMessage`), whose new work is filed under the call
 * that spawned it. The last turn is still open: a subagent of it is running,
 * in the foreground or in the background, and is what child records stream
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
	history: unknown[];
	/** How many tool calls the history holds, at every depth. */
	toolCalls: number;
	/** The open turn's running subagent, which child records go under. */
	liveAgentId: string;
	/** Seq for the next live record, past everything the history holds. */
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

/** Builds records with increasing seqs and unique ids. */
class Writer {
	readonly records: unknown[] = [];
	seq = 1;
	ids = 0;
	toolCalls = 0;
	private push(record: Record<string, unknown>) {
		this.records.push({ ...record, seq: this.seq++ });
	}
	id(prefix: string): string {
		return `${prefix}-${this.ids++}`;
	}
	say(content: string, parent?: string) {
		this.push({
			type: "text",
			content,
			...(parent ? { parent_tool_use_id: parent } : {}),
		});
	}
	think(content: string) {
		this.push({ type: "thinking", content, duration_ms: 1200 });
	}
	message(content: string) {
		this.push({ type: "message", content, message_id: this.id("msg") });
	}
	call(name: string, input: unknown, parent?: string, id = this.id("call")) {
		this.toolCalls++;
		this.push({
			type: "tool_call",
			tool_use_id: id,
			tool_name: name,
			tool_input: input,
			...(parent ? { parent_tool_use_id: parent } : {}),
		});
		return id;
	}
	result(id: string, content: string, extra: Record<string, unknown> = {}) {
		this.push({
			type: "tool_result",
			tool_use_id: id,
			tool_result: content,
			duration_ms: 800,
			...extra,
		});
	}
	tool(n: number, parent?: string) {
		const name = TOOLS[n % TOOLS.length];
		const id = this.call(name, toolInput(name, n), parent);
		this.result(id, toolResult(name, n));
	}
	plan(done: number, total: number) {
		const id = this.call("TodoWrite", { todos: [] });
		this.result(id, "Todos have been modified successfully.");
		this.push({
			type: "plan",
			tool_use_id: id,
			steps: Array.from({ length: total }, (_, i) => ({
				id: String(i + 1),
				text: `Step ${i + 1} of the plan`,
				status: i < done ? "completed" : i === done ? "in_progress" : "pending",
			})),
		});
	}
	/** A subagent's call and its work; its result only when `settle`. */
	agent(n: number, children: number, settle: boolean) {
		const id = this.call("Agent", {
			description: `Investigate area ${n}`,
			subagent_type: "Explore",
			prompt: "Find where the retry is applied.",
		});
		this.say("Starting with the transport package.", id);
		for (let c = 0; c < children; c++) this.tool(n * 100 + c, id);
		this.say(PARAGRAPH, id);
		if (settle) {
			this.result(id, `${PARAGRAPH}\n\nagentId: agent-${id}`, {
				subagent: { agent_id: `agent-${id}`, agent_type: "Explore" },
			});
		}
		return id;
	}
	resume(agentId: string, children: number, n: number) {
		const id = this.call("SendMessage", {
			to: `agent-${agentId}`,
			summary: "Follow up",
			message: "Now check the client side too.",
		});
		for (let c = 0; c < children; c++) this.tool(n * 1000 + c, agentId);
		this.result(id, "Message sent.");
	}
	done() {
		this.push({ type: "done" });
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
			agents.push(w.agent(t * 10 + a, options.childrenPerAgent, true));
		}
		if (t > 0 && t % options.resumeEvery === 0) {
			w.resume(agents[agents.length - 3], 3, t);
		}
		w.say(`${PARAGRAPH}\n\n${PARAGRAPH}`);
		w.done();
	}

	// The open turn: a plan under way, calls made, a subagent still working.
	w.message("Now the client side, please.");
	w.say("Looking at the client.");
	w.plan(1, 6);
	for (let c = 0; c < 30; c++) w.tool(9_000_000 + c);
	const live = w.agent(9_999, 5, false);
	if (options.background) {
		w.result(live, "Async agent launched successfully.", {
			subtype: "background_started",
		});
	}

	return {
		history: w.records,
		toolCalls: w.toolCalls,
		liveAgentId: live,
		nextSeq: w.seq,
	};
}

/**
 * The live records a benchmark streams, one kind at a time. Each call makes a
 * new record with a seq past the history's, so none is skipped as already
 * loaded.
 */
export function liveRecords(session: LongSession) {
	let seq = session.nextSeq;
	let n = 0;
	const stamp = (record: Record<string, unknown>) => ({
		...record,
		seq: seq++,
	});
	return {
		/**
		 * The main agent's words. Back to back they join into one text part, as
		 * the reducer joins whole messages, so the open paragraph grows with
		 * every one and is parsed again each time: kept to a sentence, so that
		 * growth stays the size of a long reply rather than of a book.
		 */
		text: () =>
			stamp({ type: "text", content: `Checked the retry path (${n++}).` }),
		/** A top-level call, then its result. */
		topLevelCall: () => {
			const id = `live-top-${n++}`;
			return [
				stamp({
					type: "tool_call",
					tool_use_id: id,
					tool_name: "Read",
					tool_input: { file_path: `/work/project/web/src/file${n}.ts` },
				}),
				stamp({ type: "tool_result", tool_use_id: id, tool_result: "ok" }),
			];
		},
		/** A call of the running subagent's, then its result. */
		childCall: () => {
			const id = `live-child-${n++}`;
			return [
				stamp({
					type: "tool_call",
					tool_use_id: id,
					tool_name: "Grep",
					tool_input: { pattern: `retry${n}`, path: "/work/project/web" },
					parent_tool_use_id: session.liveAgentId,
				}),
				stamp({
					type: "tool_result",
					tool_use_id: id,
					tool_result: "web/src/lib/retry.ts:12",
				}),
			];
		},
		/** The running subagent's words. */
		childText: () =>
			stamp({
				type: "text",
				content: `Checked candidate ${n++}.`,
				parent_tool_use_id: session.liveAgentId,
			}),
	};
}
