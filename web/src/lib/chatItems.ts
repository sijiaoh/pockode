import type {
	ChatPage,
	ChatStreams,
	ChatTurn,
	ChatUpdate,
	DiscardedMessage,
	ItemUpdate,
	PageItem,
	ToolStream,
} from "../types/chatItems";
import type {
	ChatResume,
	HistorySeq,
	SubagentProgress,
	UserMessage,
} from "../types/message";
import { newPartId } from "./partTree";

/**
 * The client's copy of a session's transcript: the items the server sent, by
 * id, as the server last stated each (docs/agent-chat.md#history-paging). It
 * holds them and nothing derived from them: what a page or an update says is
 * stored as said, and turning it into bubbles and rows is the presentation's
 * (`buildTranscript`).
 *
 * Mutable, and owned by one `useChatMessages`: every change goes through the
 * functions below, which replace each changed node object — and every node
 * above it — rather than editing it. A node's identity is therefore its
 * version, which is what lets the presentation keep what it built for every
 * part of the transcript that did not change.
 */
export interface ChatItems {
	nodes: Map<number, ItemNode>;
	/** Top-level item ids, in id order — the transcript's order. */
	top: number[];
	turns: Map<string, TurnEntry>;
	/** Tool items by `tool_use_id`, and by the permission request they hold. */
	byToolUse: Map<string, number>;
	byRequest: Map<string, number>;
	/** Fetches (`origin_tool_use_id`) by the call they read, in id order. */
	fetchesOf: Map<string, number[]>;
	/**
	 * The seq of the oldest loaded item, while older items are still on the
	 * server: an item older than it is on a page this client never loaded.
	 */
	cursor?: HistorySeq;
	/**
	 * The oldest loaded item, while the server says the item before it, on a
	 * page not loaded yet, is of the same turn (its stretch is `continued`):
	 * whatever opened the reply it is in may be on that page.
	 */
	continuedFrom?: number;
	throughSeq?: HistorySeq;
	/**
	 * The server instance `throughSeq` was read from
	 * (`AuthResult.server_instance`): the one whose item ids this copy holds,
	 * and the one instance that can resume it (`resumeFrom`). Absent for a
	 * viewed session's copy.
	 */
	instance?: string;
	/**
	 * Whether `instance` may continue this copy; not once a resync has said
	 * it has a hole in it (`forgetResume`). Apart from `instance`, which still
	 * says whose numbering the copy is in until a page replaces it.
	 */
	resumable?: boolean;
	/**
	 * Set while an older page is being fetched (`beginOlderPage`): the upserts
	 * dropped meanwhile for naming an item that page may hold. The server cuts
	 * the page and sends the subscription's updates independently, so an
	 * update can arrive before a page cut ahead of its record, which would
	 * then bring the item as it stood before the change.
	 */
	missedOlder?: MissedUpsert[];
	/** What calls in flight have said about themselves, by `tool_use_id`. */
	streams: Map<string, LiveToolStream>;
	/** Answers this client pressed that the server has not recorded yet. */
	pressed: Map<string, PressedAnswer>;
	/** Messages this client sent, until the transcript has them. */
	echoes: Echo[];
	/**
	 * Part ids by item id, minted the first time the item was seen and kept for
	 * as long as this store lives, across a re-subscribe too: list keys sort by
	 * them (`oldestPart`), so an item paged in later sorts after the rest.
	 */
	partIds: Map<number, string>;
	/** Bumped by any change to `echoes`, which the transcript cache reads. */
	echoVersion: number;
	/** The id the next unrecorded item gets; see `upsertItem`. */
	nextLocalId: number;
	/** The subscription's server clock reading, for items updates bring. */
	clock?: ServerClockReading;
	/**
	 * The smallest top-level id whose row changed — replaced, added, removed —
	 * since `rowsTakenBy` last took it (`takeRowsChangedFrom`); `-Infinity`
	 * when every row may have, `Infinity` when none did.
	 */
	rowsChangedFrom: number;
	rowsTakenBy?: object;
}

interface MissedUpsert {
	up: ItemUpdate;
	update: ChatUpdate;
	now: Date;
}

/** One item, its children by id. */
export interface ItemNode {
	/** As the server last sent it, `tool.children` left out. */
	item: PageItem;
	id: number;
	partId: string;
	/** The run this item is nested in; absent at the top level. */
	parent?: number;
	/** A top-level item's turn; absent for none. */
	turnId?: string;
	children: number[];
	/**
	 * When a tool item started running on this client's clock: when an update
	 * said so while this client watched, or its `started_at` read through the
	 * page's server clock (`ServerClockReading`).
	 */
	seenAt?: Date;
}

export interface TurnEntry {
	turn: ChatTurn;
	discarded: DiscardedMessage[];
}

export interface LiveToolStream {
	activity?: string;
	output?: string;
	/** How many first lines `output` has lost to `MAX_LIVE_OUTPUT_LINES`. */
	droppedLines?: number;
	subagentProgress?: SubagentProgress;
}

/** A press on a permission card, or what undid one (`resetPressed`). */
export type PressedAnswer = "allowed" | "denied" | "pending" | "expired";

/**
 * A message this client sent. Drawn on its own until the transcript holds its
 * item, and after that only lends the item its row keys, so the bubble the
 * user watched appear is the one that stays.
 *
 * `message.id` is the id it was sent under, which its record carries as
 * `message_id`: the item is this echo's when it carries that id
 * (`claimEcho`), however it arrives — an update, a page, a resume — and
 * whether or not the send's reply ever did.
 */
export interface Echo {
	message: UserMessage;
	/** The reply bubble a message sent to an idle agent opened. */
	replyId?: string;
	/** The item the transcript holds this message as, once it has arrived. */
	itemId?: number;
	/** Still waiting for the server's reply to the send. */
	awaitingReply: boolean;
	/** Why the send failed, drawn as a failed reply under the message. */
	error?: string;
	/**
	 * The server itself answered the send with `error`. Its record arriving
	 * does not take that back: the record is written before the message is
	 * handed to the agent, and the handover is what failed. A failure the
	 * transport reported says nothing either way, so the record is taken as
	 * the answer — wrongly only when the handover failed too and the server's
	 * saying so was lost with the connection.
	 */
	failedOnServer?: boolean;
	/**
	 * Where it was sent: after this top-level item, into this turn — a turn
	 * running when it was sent, which it went into; none for one sent to an
	 * idle agent. Set by `addEcho`.
	 */
	after?: number;
	turnId?: string;
}

/**
 * The server's clock read against this client's: a reply's `server_time`,
 * and when the reply arrived here. It carries a server timestamp over to this
 * clock — `receivedAt - (serverTime - t)` — without asking the two clocks to
 * agree (the turn clock's rule, docs/turn-progress-ui.md §2.3).
 */
export interface ServerClockReading {
	serverTime: number;
	receivedAt: number;
}

/**
 * A server timestamp as epoch ms, or undefined when there is none — never
 * zero, which would read as a moment in 1970.
 */
export function serverTime(raw: unknown): number | undefined {
	if (typeof raw !== "string") return undefined;
	const ms = Date.parse(raw);
	return Number.isNaN(ms) ? undefined : ms;
}

/** The reading a reply carries; none without one. */
export function readServerClock(
	reply: { server_time?: string },
	receivedAt = Date.now(),
): ServerClockReading | undefined {
	const at = serverTime(reply.server_time);
	return at === undefined ? undefined : { serverTime: at, receivedAt };
}

function onClientClock(
	at: number | undefined,
	clock: ServerClockReading | undefined,
): Date | undefined {
	if (at === undefined || !clock) return undefined;
	return new Date(clock.receivedAt - (clock.serverTime - at));
}

/**
 * How much of a running call's output is kept. The row reads its last
 * non-empty line and the body its last 50, so older lines are only read again
 * by a build that prints a hundred thousand of them into a transcript that
 * stays open for hours. The whole output arrives with the result.
 */
const MAX_LIVE_OUTPUT_LINES = 200;

export function createChatItems(): ChatItems {
	return {
		nodes: new Map(),
		top: [],
		turns: new Map(),
		byToolUse: new Map(),
		byRequest: new Map(),
		fetchesOf: new Map(),
		streams: new Map(),
		pressed: new Map(),
		echoes: [],
		partIds: new Map(),
		echoVersion: 0,
		nextLocalId: 0,
		rowsChangedFrom: Number.NEGATIVE_INFINITY,
	};
}

/**
 * Where the rows have changed since `taker` last called this: every
 * top-level id below it is the row it was then, in the same place.
 * `buildTranscript` reads it to walk only from there. Whoever else took it
 * in between has the changes since, so `taker` is told all rows may have.
 */
export function takeRowsChangedFrom(store: ChatItems, taker: object): number {
	const from =
		store.rowsTakenBy === taker
			? store.rowsChangedFrom
			: Number.NEGATIVE_INFINITY;
	store.rowsTakenBy = taker;
	store.rowsChangedFrom = Number.POSITIVE_INFINITY;
	return from;
}

function rowChanged(store: ChatItems, id: number): void {
	if (id < store.rowsChangedFrom) store.rowsChangedFrom = id;
}

/** Every write to `nodes` goes through here, so a row's change is seen. */
function setNode(store: ChatItems, node: ItemNode): void {
	store.nodes.set(node.id, node);
	if (node.parent === undefined) rowChanged(store, node.id);
}

function insertTop(store: ChatItems, id: number): void {
	insertSorted(store.top, id);
	rowChanged(store, id);
}

function removeTop(store: ChatItems, id: number): void {
	removeFrom(store.top, id);
	rowChanged(store, id);
}

/** Replaces node `id` with `next`, and every run above it with a new copy. */
function putNode(store: ChatItems, next: ItemNode): void {
	setNode(store, next);
	let parent = next.parent;
	while (parent !== undefined) {
		const node = store.nodes.get(parent);
		if (!node) return;
		setNode(store, { ...node });
		parent = node.parent;
	}
}

/** Gives node `id` and the runs above it new identities: something drawn with it changed. */
function touch(store: ChatItems, id: number | undefined): void {
	if (id === undefined) return;
	const node = store.nodes.get(id);
	if (node) putNode(store, { ...node });
}

function partIdOf(store: ChatItems, id: number): string {
	let partId = store.partIds.get(id);
	if (!partId) {
		partId = newPartId();
		store.partIds.set(id, partId);
	}
	return partId;
}

/** Where `id` goes in an id-ordered list. */
function insertSorted(list: number[], id: number): void {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid] < id) lo = mid + 1;
		else hi = mid;
	}
	if (list[lo] !== id) list.splice(lo, 0, id);
}

function removeFrom(list: number[], id: number): void {
	const at = list.indexOf(id);
	if (at !== -1) list.splice(at, 1);
}

function index(store: ChatItems, node: ItemNode, previous?: PageItem): void {
	const tool = node.item.tool;
	const before = previous?.tool;
	if (
		before?.origin_tool_use_id &&
		before.origin_tool_use_id !== tool?.origin_tool_use_id
	) {
		const list = store.fetchesOf.get(before.origin_tool_use_id);
		if (list) removeFrom(list, node.id);
		// The run it was filed under drew it, and must stop.
		touch(store, store.byToolUse.get(before.origin_tool_use_id));
	}
	if (!tool) return;
	if (tool.tool_use_id && store.byToolUse.get(tool.tool_use_id) !== node.id) {
		store.byToolUse.set(tool.tool_use_id, node.id);
		// A fetch of this call drawn as a row of its own is filed on it now.
		for (const fetch of store.fetchesOf.get(tool.tool_use_id) ?? []) {
			touch(store, fetch);
		}
	}
	if (tool.permission?.request_id) {
		store.byRequest.set(tool.permission.request_id, node.id);
		// The server has the answer now; the press stood in for it until here.
		if (tool.permission.status !== "pending") {
			store.pressed.delete(tool.permission.request_id);
		}
	}
	if (tool.origin_tool_use_id) {
		let list = store.fetchesOf.get(tool.origin_tool_use_id);
		if (!list) {
			list = [];
			store.fetchesOf.set(tool.origin_tool_use_id, list);
		}
		insertSorted(list, node.id);
		// The run it is filed under draws it.
		touch(store, store.byToolUse.get(tool.origin_tool_use_id));
	}
}

/** Files a page item and everything nested in it, unless the store has it. */
function addPageItem(
	store: ChatItems,
	item: PageItem,
	place: { parent?: number; turnId?: string },
	clock: ServerClockReading | undefined,
): void {
	if (item.id === undefined) return;
	if (store.nodes.has(item.id)) return;
	let stored = item;
	let children: PageItem[] = [];
	if (item.tool) {
		const { children: nested, ...tool } = item.tool;
		stored = { ...item, tool };
		children = nested ?? [];
	}
	const node: ItemNode = {
		item: stored,
		id: item.id,
		partId: partIdOf(store, item.id),
		children: [],
		...(place.parent !== undefined ? { parent: place.parent } : {}),
		...(place.parent === undefined && place.turnId
			? { turnId: place.turnId }
			: {}),
		...seenAtOnPage(stored, clock),
	};
	setNode(store, node);
	if (place.parent === undefined) insertTop(store, node.id);
	else {
		const parent = store.nodes.get(place.parent);
		if (parent) insertSorted(parent.children, node.id);
	}
	index(store, node);
	claimEcho(store, node);
	for (const child of children) {
		addPageItem(store, child, { parent: node.id }, clock);
	}
}

function seenAtOnPage(
	item: PageItem,
	clock: ServerClockReading | undefined,
): { seenAt?: Date } {
	const seenAt = onClientClock(serverTime(item.tool?.started_at), clock);
	return seenAt ? { seenAt } : {};
}

function putTurn(
	store: ChatItems,
	turn: ChatTurn,
	discarded: DiscardedMessage[] | undefined,
): void {
	store.turns.set(turn.turn_id, { turn, discarded: discarded ?? [] });
}

function setToolStreams(store: ChatItems, tools: ChatStreams["tools"]): void {
	store.streams = new Map();
	for (const [toolUseId, stream] of Object.entries(tools ?? {})) {
		store.streams.set(
			toolUseId,
			extendStream(undefined, { ...stream, replace: true }),
		);
	}
}

/**
 * Starts the transcript over from the newest page — a subscription's snapshot,
 * or a viewed session's — with the live streams it came with. `instance` is
 * the server instance a subscription's came from, which can resume it; a
 * viewed session's has none. Messages this client sent and is still waiting
 * on stay, and so do the part ids, so a re-subscribe redraws nothing that did
 * not change.
 */
export function installNewestPage(
	store: ChatItems,
	page: ChatPage,
	streams: ChatStreams | undefined,
	clock: ServerClockReading | undefined,
	instance?: string,
): void {
	store.nodes = new Map();
	store.top = [];
	store.rowsChangedFrom = Number.NEGATIVE_INFINITY;
	store.turns = new Map();
	store.byToolUse = new Map();
	store.byRequest = new Map();
	store.fetchesOf = new Map();
	store.pressed = new Map();
	store.missedOlder = undefined;
	store.throughSeq = page.through_seq;
	// Another server instance may number items differently, so nothing keyed
	// by an item id the last one gave carries over: part ids are minted
	// afresh, and echoes are claimed afresh from the page.
	const renumbered =
		store.instance !== undefined &&
		instance !== undefined &&
		store.instance !== instance;
	store.instance = instance;
	store.resumable = instance !== undefined;
	store.clock = clock;
	if (renumbered) store.partIds = new Map();
	store.echoes = store.echoes.map(({ itemId: _, ...echo }) => echo);
	addPage(store, page, clock);
	setToolStreams(store, streams?.tools);
	// A send still in flight, or one that failed, is still this client's to
	// draw; one the server took is the page's now, or on a page further back —
	// or it was never recorded, and a reload would not show it either.
	const end = store.top.at(-1) ?? 0;
	store.echoes = store.echoes
		.filter(
			(echo) =>
				echo.awaitingReply ||
				echo.error !== undefined ||
				echo.itemId !== undefined,
		)
		.map((echo) => {
			if (!renumbered || echo.itemId !== undefined) return echo;
			// Where it was sent is named in the old numbering; the end of the
			// newest page is where a send not on it was made, as far as this
			// copy can tell.
			const { turnId: _, ...rest } = echo;
			return { ...rest, after: end };
		});
	store.echoVersion++;
}

/**
 * What a re-subscribe asks to continue from, when this copy can be continued
 * at all: it has read something, from a server instance it knows.
 */
export function resumeFrom(store: ChatItems): ChatResume | undefined {
	if (!store.resumable || !store.instance || store.throughSeq === undefined) {
		return undefined;
	}
	return { server_instance: store.instance, after_seq: store.throughSeq };
}

/**
 * Says this copy is not to be continued: the next subscription starts over
 * from a page. For a resync, whose hole the copy cannot know the extent of.
 */
export function forgetResume(store: ChatItems): void {
	store.resumable = false;
}

/**
 * Brings the copy up to date from a resumed subscription: `update` is what
 * the records after its `throughSeq` changed, applied as a `chat.update` is,
 * and `streams` are the live streams as they stand now, which replace the
 * ones held — those stopped being continued with the connection. Everything
 * else stays: the older pages paged in, the part ids, the sends this client
 * is still accounting for (a message of theirs recorded meanwhile arrives in
 * `update` and takes its echo, `claimEcho`).
 */
export function resumeTranscript(
	store: ChatItems,
	update: Omit<ChatUpdate, "type" | "streams_ended">,
	streams: ChatStreams | undefined,
	clock: ServerClockReading | undefined,
	now: Date,
	instance: string | undefined,
): void {
	store.instance = instance;
	// Upserts held for an older page that was asked for over the connection
	// that is gone: the page is not coming, and asking again brings them.
	store.missedOlder = undefined;
	store.clock = clock;
	applyUpdate(store, { type: "update", ...update }, now);
	const held = [...store.streams.keys()];
	setToolStreams(store, streams?.tools);
	for (const toolUseId of new Set([...held, ...store.streams.keys()])) {
		touch(store, store.byToolUse.get(toolUseId));
	}
}

/**
 * Adds a page older than everything loaded. Items the store already holds
 * keep what the newer account said; a turn it holds is replaced only when the
 * page knows more of it (an ending).
 */
export function addOlderPage(
	store: ChatItems,
	page: ChatPage,
	clock: ServerClockReading | undefined,
): void {
	const missed = store.missedOlder ?? [];
	store.missedOlder = undefined;
	addPage(store, page, clock);
	for (const { up, update, now } of missed) {
		if (
			update.through_seq === undefined ||
			page.through_seq === undefined ||
			update.through_seq > page.through_seq
		) {
			upsertItem(store, up, update, now);
		}
	}
}

/** Marks an older page as being fetched; see `ChatItems.missedOlder`. */
export function beginOlderPage(store: ChatItems): void {
	store.missedOlder = [];
}

/** The older page being fetched is not coming. */
export function abandonOlderPage(store: ChatItems): void {
	store.missedOlder = undefined;
}

function addPage(
	store: ChatItems,
	page: ChatPage,
	clock: ServerClockReading | undefined,
): void {
	for (const stretch of page.turns) {
		const turn = stretch.turn;
		if (turn) {
			const held = store.turns.get(turn.turn_id);
			if (!held || (!held.turn.ended && turn.ended)) {
				putTurn(store, turn, stretch.discarded);
			}
		}
		for (const item of stretch.items) {
			addPageItem(store, item, { turnId: turn?.turn_id }, clock);
		}
	}
	store.cursor = page.has_more ? page.next_before_seq : undefined;
	// Only a page's first stretch can be continued, and the page just added is
	// the oldest loaded.
	const first = page.turns[0];
	store.continuedFrom = first?.continued ? first.items[0]?.id : undefined;
}

/**
 * Applies one `chat.update`. `now` is when it arrived: a call it starts is
 * counted from then.
 */
export function applyUpdate(
	store: ChatItems,
	update: ChatUpdate,
	now: Date,
): void {
	for (const toolUseId of update.streams_ended?.tools ?? []) {
		store.streams.delete(toolUseId);
		touch(store, store.byToolUse.get(toolUseId));
	}
	// Already in the page: an update for a record written between the
	// subscription and the page being cut.
	if (
		update.through_seq !== undefined &&
		store.throughSeq !== undefined &&
		update.through_seq <= store.throughSeq
	) {
		return;
	}
	if (update.through_seq !== undefined) store.throughSeq = update.through_seq;
	for (const { turn, discarded } of update.turns ?? []) {
		putTurn(store, turn, discarded);
	}
	for (const up of update.items ?? []) upsertItem(store, up, update, now);
}

function upsertItem(
	store: ChatItems,
	up: ItemUpdate,
	update: ChatUpdate,
	now: Date,
): void {
	const { item, parent, turn_id: turnId } = up;
	// The warning standing in for a record nobody could write: in no history,
	// never updated. It goes after everything there is.
	let id = item.id;
	if (id === undefined) {
		store.nextLocalId += 1;
		id = (store.top.at(-1) ?? 0) + store.nextLocalId / 1_000_000;
	}
	const held = store.nodes.get(id);
	// Nested in a run this client does not hold, or an item on a page this
	// client never loaded (it is not new, it changed): nowhere it can be
	// drawn — unless that page is on its way.
	if (
		(parent !== undefined && !store.nodes.has(parent)) ||
		(!held &&
			parent === undefined &&
			store.cursor !== undefined &&
			item.seq !== undefined &&
			item.seq < store.cursor)
	) {
		store.missedOlder?.push({ up, update, now });
		return;
	}
	const tool = item.tool;
	const startedChanged =
		tool?.started_at !== undefined &&
		tool.started_at !== held?.item.tool?.started_at;
	// A call that starts while this client watches counts from when it saw
	// the start; one first heard of long after — moved in from a page never
	// loaded — from its own start, read through the subscription's clock.
	const seenAt =
		startedChanged && held === undefined
			? (onClientClock(serverTime(tool?.started_at), store.clock) ?? now)
			: now;
	const node: ItemNode = {
		item,
		id,
		partId: partIdOf(store, id),
		children: held?.children ?? [],
		...(parent !== undefined ? { parent } : {}),
		...(parent === undefined && turnId ? { turnId } : {}),
		...(startedChanged
			? { seenAt }
			: held?.seenAt
				? { seenAt: held.seenAt }
				: {}),
	};
	if (held && held.parent !== node.parent) {
		if (held.parent === undefined) removeTop(store, id);
		else {
			const from = store.nodes.get(held.parent);
			if (from) {
				const children = from.children.filter((c) => c !== id);
				putNode(store, { ...from, children });
			}
		}
	}
	if (!held || held.parent !== node.parent) {
		if (parent === undefined) insertTop(store, id);
		else {
			const to = store.nodes.get(parent);
			if (to) {
				const children = [...to.children];
				insertSorted(children, id);
				setNode(store, { ...to, children });
			}
		}
	}
	putNode(store, node);
	index(store, node, held?.item);
	if (!held) claimEcho(store, node);
}

/**
 * Gives the echo sent under a message item's `message_id` the item. A send
 * whose reply was lost to a timeout or a dropped connection was not a failure
 * after all once its record arrives; one the server said failed still was.
 */
function claimEcho(store: ChatItems, node: ItemNode): void {
	const messageId = node.item.message?.message_id;
	if (node.item.kind !== "message" || !messageId) return;
	const echo = store.echoes.find(
		(e) => e.itemId === undefined && e.message.id === messageId,
	);
	if (!echo) return;
	store.echoes = store.echoes.map((e) => {
		if (e !== echo) return e;
		if (e.failedOnServer) return { ...e, itemId: node.id };
		const { error: _, ...rest } = e;
		return { ...rest, itemId: node.id };
	});
	store.echoVersion++;
}

/** One `chat.delta` for a call in flight. */
export function applyToolDelta(
	store: ChatItems,
	toolUseId: string,
	delta: ToolStream & { replace?: boolean },
): void {
	store.streams.set(
		toolUseId,
		extendStream(store.streams.get(toolUseId), delta),
	);
	touch(store, store.byToolUse.get(toolUseId));
}

function extendStream(
	held: LiveToolStream | undefined,
	delta: ToolStream & { replace?: boolean },
): LiveToolStream {
	const base: LiveToolStream = delta.replace ? {} : { ...held };
	// An empty activity leaves the last one standing: a line that blinks in
	// and out re-flows every row below it.
	if (delta.activity) base.activity = delta.activity;
	if (delta.subagent_progress) {
		const progress = subagentProgress(delta.subagent_progress);
		if (progress) base.subagentProgress = progress;
	}
	if (delta.output) {
		const combined = (base.output ?? "") + delta.output;
		const lines = combined.split("\n");
		if (lines.length <= MAX_LIVE_OUTPUT_LINES) base.output = combined;
		else {
			base.output = lines.slice(-MAX_LIVE_OUTPUT_LINES).join("\n");
			base.droppedLines =
				(base.droppedLines ?? 0) + lines.length - MAX_LIVE_OUTPUT_LINES;
		}
	}
	return base;
}

function optionalCount(raw: unknown): number | undefined {
	return typeof raw === "number" && raw >= 0 ? raw : undefined;
}

/** A stream's `subagent_progress`; undefined when it says nothing. */
function subagentProgress(raw: unknown): SubagentProgress | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const fields = raw as Record<string, unknown>;
	const toolUses = optionalCount(fields.tool_uses);
	const totalTokens = optionalCount(fields.total_tokens);
	const lastToolName =
		typeof fields.last_tool_name === "string" && fields.last_tool_name
			? fields.last_tool_name
			: undefined;
	const progress: SubagentProgress = {
		...(toolUses !== undefined ? { toolUses } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(lastToolName ? { lastToolName } : {}),
	};
	return Object.keys(progress).length > 0 ? progress : undefined;
}

/**
 * A press on a permission card, drawn until the server records an answer. A
 * card the server already says was answered keeps that answer: a reviewer's
 * that beat the press is what happened.
 */
export function pressAnswer(
	store: ChatItems,
	requestId: string,
	answer: PressedAnswer,
): void {
	const id = store.byRequest.get(requestId);
	const status =
		id === undefined
			? undefined
			: store.nodes.get(id)?.item.tool?.permission?.status;
	if (status !== undefined && status !== "pending") return;
	if (answer === "pending") store.pressed.delete(requestId);
	else store.pressed.set(requestId, answer);
	touch(store, id);
}

/** Adds a message this client is sending, where the transcript ends now. */
export function addEcho(store: ChatItems, echo: Echo): void {
	const turnId = echo.replyId === undefined ? openTurnId(store) : undefined;
	store.echoes = [
		...store.echoes,
		{
			...echo,
			after: store.top.at(-1) ?? 0,
			...(turnId ? { turnId } : {}),
		},
	];
	store.echoVersion++;
}

/**
 * Takes back a send that failed leaving nothing written. One whose record has
 * arrived meanwhile was written after all, so it stays: with `error` under it
 * when the server said the send failed (the record goes before the handover,
 * which is what failed), as sent when only the transport did.
 */
export function takeBackEcho(
	store: ChatItems,
	messageId: string,
	error: string,
	onServer: boolean,
): void {
	const echo = store.echoes.find((e) => e.message.id === messageId);
	if (echo?.itemId !== undefined) {
		failEcho(store, messageId, error, onServer);
		return;
	}
	store.echoes = store.echoes.filter((e) => e.message.id !== messageId);
	store.echoVersion++;
}

/**
 * Says the send failed. `onServer` is whether the server said so (see
 * `Echo.failedOnServer`); a failure only the transport reported is dropped
 * when the record has arrived already, which says the server took it.
 */
export function failEcho(
	store: ChatItems,
	messageId: string,
	error: string,
	onServer: boolean,
): void {
	store.echoes = store.echoes.map((e) =>
		e.message.id !== messageId
			? e
			: onServer
				? { ...e, awaitingReply: false, error, failedOnServer: true }
				: e.itemId !== undefined
					? { ...e, awaitingReply: false }
					: { ...e, awaitingReply: false, error },
	);
	store.echoVersion++;
}

/** The server has the message; its record arrives, or has, on its own. */
export function sentEcho(store: ChatItems, messageId: string): void {
	store.echoes = store.echoes.map((e) =>
		e.message.id === messageId ? { ...e, awaitingReply: false } : e,
	);
	store.echoVersion++;
}

/** The newest turn, while it has not ended. */
function openTurnId(store: ChatItems): string | undefined {
	let newest: ChatTurn | undefined;
	for (const { turn } of store.turns.values()) {
		if (!newest || (turn.start_seq ?? 0) >= (newest.start_seq ?? 0))
			newest = turn;
	}
	return newest && !newest.ended ? newest.turn_id : undefined;
}
