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
 */
export interface Echo {
	message: UserMessage;
	/** The reply bubble a message sent to an idle agent opened. */
	replyId?: string;
	/** The item the transcript holds this message as, once it is known. */
	itemId?: number;
	/** Still waiting for the server's reply to the send. */
	awaitingReply: boolean;
	/** Why the send failed, drawn as a failed reply under the message. */
	error?: string;
	/** When the reply it opened began, from the send's reply (epoch ms). */
	openedAt?: number;
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
 * or a viewed session's — with the live streams it came with. Messages this
 * client sent and is still waiting on stay, and so do the part ids, so a
 * re-subscribe redraws nothing that did not change.
 */
export function installNewestPage(
	store: ChatItems,
	page: ChatPage,
	streams: ChatStreams | undefined,
	clock: ServerClockReading | undefined,
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
	const heldThrough = store.throughSeq;
	store.throughSeq = page.through_seq;
	store.clock = clock;
	addPage(store, page, clock);
	setToolStreams(store, streams?.tools);
	claimEchoes(store, heldThrough);
	// A send still in flight, or one that failed, is still this client's to
	// draw; one the server took is the page's now, or on a page further back.
	store.echoes = store.echoes.filter(
		(echo) =>
			echo.awaitingReply ||
			echo.error !== undefined ||
			(echo.itemId !== undefined && store.nodes.has(echo.itemId)),
	);
	store.echoVersion++;
}

/**
 * Gives a send still unaccounted for — waiting on its reply, or failed on a
 * dropped connection that may have delivered it — the message a fresh page
 * holds for it: one recorded since the transcript last stood, with what was
 * typed. Without this the page's copy and the echo would both be drawn.
 */
function claimEchoes(store: ChatItems, since: HistorySeq | undefined): void {
	const claimed = new Set(
		store.echoes.flatMap((e) => (e.itemId !== undefined ? [e.itemId] : [])),
	);
	let changed = false;
	const echoes = store.echoes.map((echo) => {
		if (echo.itemId !== undefined && store.nodes.has(echo.itemId)) return echo;
		if (!echo.awaitingReply && echo.error === undefined) return echo;
		const match = store.top.find((id) => {
			const item = store.nodes.get(id)?.item;
			return (
				item?.kind === "message" &&
				!claimed.has(id) &&
				(since === undefined || (item.seq ?? 0) > since) &&
				item.message?.content === echo.message.content &&
				!!echo.message.content
			);
		});
		if (match === undefined) return echo;
		claimed.add(match);
		changed = true;
		const { error: _, ...rest } = echo;
		return { ...rest, itemId: match, awaitingReply: echo.awaitingReply };
	});
	if (changed) store.echoes = echoes;
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
	if (!held && item.kind === "message") adoptEcho(store, node, update);
}

/**
 * Takes a message item this client sent as its echo's, when it arrives before
 * the reply that would say so: the sender is left out of the update for its
 * own message, so a message item it first hears of from a later record — the
 * turn the message opened taking it in — is its own.
 */
function adoptEcho(store: ChatItems, node: ItemNode, update: ChatUpdate): void {
	if (node.item.seq === undefined || update.through_seq === undefined) return;
	const content = node.item.message?.content;
	// A send that failed here may still have been recorded — a reply lost to
	// a timeout or a dropped connection. Its own record can reach this client
	// too, over a connection that is not the one it was sent on, so only what
	// was typed tells it.
	const failed = store.echoes.find(
		(e) =>
			e.error !== undefined &&
			e.itemId === undefined &&
			!!content &&
			e.message.content === content,
	);
	if (update.through_seq <= node.item.seq) {
		if (failed) claimEcho(store, failed, node.id);
		return;
	}
	const waiting = store.echoes.filter(
		(e) => e.awaitingReply && e.itemId === undefined,
	);
	// Two records send a message back to its sender: the turn it opened taking
	// it in, and a Stop discarding it. Which of several sends in flight it is
	// is told by what was typed where that says, and otherwise by which kind
	// of send it can be — only one sent to an idle agent opens a turn.
	const messageId = node.item.message?.message_id;
	const opens = (update.turns ?? []).some(
		({ turn }) => messageId !== undefined && turn.message_id === messageId,
	);
	const echo =
		waiting.find((e) => content && e.message.content === content) ??
		waiting.find((e) => (e.replyId !== undefined) === opens) ??
		failed;
	if (echo) claimEcho(store, echo, node.id);
}

/** Gives `echo` the item it became; a failed one was not a failure after all. */
function claimEcho(store: ChatItems, echo: Echo, itemId: number): void {
	store.echoes = store.echoes.map((e) => {
		if (e !== echo) return e;
		const { error: _, ...rest } = e;
		return { ...rest, itemId };
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
		{ ...echo, after: store.top.at(-1) ?? 0, ...(turnId ? { turnId } : {}) },
	];
	store.echoVersion++;
}

export function removeEcho(store: ChatItems, messageId: string): void {
	store.echoes = store.echoes.filter((e) => e.message.id !== messageId);
	store.echoVersion++;
}

export function failEcho(
	store: ChatItems,
	messageId: string,
	error: string,
): void {
	store.echoes = store.echoes.map((e) =>
		e.message.id === messageId ? { ...e, awaitingReply: false, error } : e,
	);
	store.echoVersion++;
}

/** What the server's reply to a send says about the message it recorded. */
export interface SentRecord {
	itemId?: number;
	seq?: HistorySeq;
	/** What the record holds that the echo did not know. */
	update: Partial<UserMessage>;
	/** The record's `observed_at`, epoch ms on the server's clock. */
	observedAt?: number;
}

/**
 * Files the server's reply to a send. The sender is left out of the update
 * carrying its message, so the item is written here from what was sent and
 * what the reply adds — unless an update already brought it (`adoptEcho`).
 * A reply naming no item leaves the echo drawn on its own: the message was
 * not recorded, or the server is too old to say where.
 */
export function settleEcho(
	store: ChatItems,
	messageId: string,
	sent: SentRecord,
): void {
	const at = store.echoes.findIndex((e) => e.message.id === messageId);
	if (at === -1) return;
	const echo = store.echoes[at];
	const message = { ...echo.message, ...sent.update };
	// The reply names the message's item for certain; an adoption was a guess,
	// and one that took another send's item gives it back.
	const itemId = sent.itemId ?? echo.itemId;
	store.echoes = store.echoes.map((e, i) =>
		i === at
			? {
					...e,
					message,
					awaitingReply: false,
					...(itemId !== undefined ? { itemId } : {}),
					...(sent.observedAt !== undefined
						? { openedAt: sent.observedAt }
						: {}),
				}
			: itemId !== undefined && e.itemId === itemId && e.awaitingReply
				? { ...e, itemId: undefined }
				: e,
	);
	store.echoVersion++;
	if (itemId === undefined || store.nodes.has(itemId)) return;
	if (
		store.cursor !== undefined &&
		sent.seq !== undefined &&
		sent.seq < store.cursor
	)
		return;
	// The turn it went into, unless that turn ended before the server took the
	// message: it is then in none, until a turn takes it in.
	const sentInto =
		echo.turnId && !store.turns.get(echo.turnId)?.turn.ended
			? echo.turnId
			: undefined;
	const turnId = openerTurn(store, message.messageId) ?? sentInto;
	const node: ItemNode = {
		id: itemId,
		partId: partIdOf(store, itemId),
		children: [],
		...(turnId ? { turnId } : {}),
		item: {
			id: itemId,
			kind: "message",
			...(sent.seq !== undefined ? { seq: sent.seq, last_seq: sent.seq } : {}),
			message: {
				content: message.content,
				...(message.messageId ? { message_id: message.messageId } : {}),
				...(sent.observedAt !== undefined
					? { observed_at: new Date(sent.observedAt).toISOString() }
					: {}),
				...(message.answering ? { answering: message.answering } : {}),
				...(message.command ? { command: message.command } : {}),
				...(message.attachments ? { attachments: message.attachments } : {}),
				...(message.htmlAction ? { html_action: message.htmlAction } : {}),
			},
		},
	};
	setNode(store, node);
	insertTop(store, itemId);
}

function openerTurn(
	store: ChatItems,
	messageId: string | undefined,
): string | undefined {
	if (!messageId) return undefined;
	for (const { turn } of store.turns.values()) {
		if (turn.message_id === messageId) return turn.turn_id;
	}
	return undefined;
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
