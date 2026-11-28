import type {
	ChatPage,
	ChatTurn,
	ChatUpdate,
	DiscardedMessage,
	ItemUpdate,
	MessageItem,
	PageItem,
	PageTurn,
	QuestionItem,
	ToolItem,
} from "../types/chatItems";

/**
 * Builders for the transcript as the server sends it: items, the turns they
 * are grouped in, pages and updates (docs/agent-chat.md#history-paging).
 *
 * Every item gets the next id and seq as it is built, so items built in the
 * order they happened are in transcript order. Nested items are built before
 * the run holding them — as its arguments — and so have smaller ids, which is
 * fine: only siblings are ordered by id. `resetItems` starts both counters over.
 */
let counter = 0;
let turnCounter = 0;

export function resetItems(): void {
	counter = 0;
	turnCounter = 0;
}

function next(): number {
	counter += 1;
	return counter;
}

/**
 * Takes a seq for a record that makes no item of its own — a turn's start,
 * say — so an update about it is newer than what came before.
 */
export function record(): number {
	return next();
}

/** The seq the next item built gets, for a test that has to name it. */
export function nextSeq(): number {
	return counter + 1;
}

const AT = "2026-01-01T00:00:00Z";

function item(kind: PageItem["kind"], payload: Partial<PageItem>): PageItem {
	const id = next();
	return { id, kind, seq: id, last_seq: id, ...payload };
}

export function msg(
	content: string,
	fields: Partial<MessageItem> = {},
): PageItem {
	return item("message", {
		message: { message_id: `msg-${counter + 1}`, content, ...fields },
	});
}

export function text(content: string, parent?: string): PageItem {
	return item("text", {
		text: { content, ...(parent ? { parent_tool_use_id: parent } : {}) },
	});
}

export function thinking(content: string, parent?: string): PageItem {
	return item("thinking", {
		thinking: { content, ...(parent ? { parent_tool_use_id: parent } : {}) },
	});
}

/**
 * A tool run, `succeeded` unless said otherwise. Its `last_seq` is the newest
 * of its own and its children's, as the server's is.
 */
export function tool(
	name: string,
	input: unknown = {},
	fields: Partial<ToolItem> = {},
): PageItem {
	const id = next();
	const children = fields.children;
	const last = Math.max(id, ...(children ?? []).map((c) => c.last_seq ?? 0));
	return {
		id,
		kind: "tool",
		seq: id,
		last_seq: last,
		tool: {
			tool_use_id: `tu-${id}`,
			tool_name: name,
			tool_input: input,
			status: "succeeded",
			...fields,
		},
	};
}

/** A tool run held at a permission request nobody has answered yet. */
export function awaiting(
	name: string,
	input: unknown,
	requestId: string,
	fields: Partial<ToolItem> = {},
): PageItem {
	const { permission, ...rest } = fields;
	return tool(name, input, {
		status: "awaiting_permission",
		permission: { request_id: requestId, status: "pending", ...permission },
		...rest,
	});
}

export function question(
	q: string,
	fields: Partial<QuestionItem> = {},
): PageItem {
	return item("question", {
		question: {
			request_id: `q-${counter + 1}`,
			question: q,
			header: q,
			options: [],
			asked_at: AT,
			status: "open",
			...fields,
		},
	});
}

export function read(messageId?: string): PageItem {
	return item("read", {
		read: { ...(messageId ? { message_id: messageId } : {}), observed_at: AT },
	});
}

export function warning(message: string, code = "warning"): PageItem {
	return item("warning", { warning: { message, code } });
}

export function error(message: string): PageItem {
	return item("error", { error: { error: message } });
}

export function system(content: string): PageItem {
	return item("system", { system: { content } });
}

export function codexPlan(
	steps: { text: string; status: "pending" | "in_progress" | "completed" }[],
): PageItem {
	return item("plan", { plan: { plan_id: `plan-${counter + 1}`, steps } });
}

/** What a turn says about itself; ended and completed unless said otherwise. */
export interface TurnFields extends Partial<ChatTurn> {
	discarded?: DiscardedMessage[];
	continued?: boolean;
}

/**
 * A stretch of one turn. Its opener is its first message unless
 * `message_id` says otherwise; it starts at its first item's seq and ends
 * after its last, unless `ended: false`.
 */
export function turn(fields: TurnFields, ...items: PageItem[]): PageTurn {
	const { discarded, continued, ...rest } = fields;
	turnCounter += 1;
	const opener = items.find((i) => i.kind === "message");
	const ended = rest.ended ?? true;
	const start = (items[0]?.seq ?? counter + 1) - 0.5;
	const t: ChatTurn = {
		turn_id: `turn-${turnCounter}`,
		origin: "prompt",
		...(opener?.message?.message_id
			? { message_id: opener.message.message_id }
			: {}),
		start_seq: start,
		ended,
		...(ended
			? { outcome: "completed", ended_by: "done", end_seq: next() }
			: {}),
		...rest,
	};
	return {
		turn: t,
		items,
		...(continued ? { continued } : {}),
		...(discarded ? { discarded } : {}),
	};
}

/** Items outside every turn. */
export function noTurn(...items: PageItem[]): PageTurn {
	return { items };
}

export function page(
	turns: PageTurn[],
	fields: Partial<ChatPage> = {},
): ChatPage {
	return { turns, has_more: false, through_seq: counter, ...fields };
}

/**
 * An update. Items are upserted at the top level of `turnId` unless they name
 * a parent; its `through_seq` is the newest seq built so far.
 */
export function update(
	fields: Partial<Omit<ChatUpdate, "type" | "items">> & {
		items?: (PageItem | ItemUpdate)[];
		turnId?: string;
	} = {},
): ChatUpdate {
	const { items, turnId, ...rest } = fields;
	return {
		type: "update",
		through_seq: counter,
		...rest,
		...(items
			? {
					items: items.map((i) =>
						"item" in i
							? i
							: { item: i, ...(turnId ? { turn_id: turnId } : {}) },
					),
				}
			: {}),
	};
}

/** An item as an update carries it: a run's children are never in one. */
export function withoutChildren(i: PageItem): PageItem {
	if (!i.tool?.children) return i;
	const { children: _, ...tool } = i.tool;
	return { ...i, tool };
}

/** The same item, changed — what an upsert of it says. */
export function changed(i: PageItem, fields: Partial<PageItem>): PageItem {
	return withoutChildren({ ...i, ...fields, last_seq: next() });
}

/** A tool item, changed. */
export function changedTool(i: PageItem, fields: Partial<ToolItem>): PageItem {
	return withoutChildren({
		...i,
		last_seq: next(),
		tool: { ...(i.tool as ToolItem), ...fields },
	});
}

/** A turn's state for an update's `turns`. */
export function ended(
	t: PageTurn,
	fields: Partial<ChatTurn> = {},
): { turn: ChatTurn } {
	return {
		turn: {
			...(t.turn as ChatTurn),
			ended: true,
			outcome: "completed",
			ended_by: "done",
			end_seq: next(),
			...fields,
		},
	};
}
