import type {
	DiscardedMessage,
	PageItem,
	PlanItem,
	QuestionItem,
	ToolItem,
} from "../types/chatItems";
import type {
	AssistantMessage,
	AwaitedFetch,
	ContentPart,
	ExpiryReason,
	HistorySeq,
	HtmlAction,
	Message,
	MessageOrigin,
	PermissionReview,
	PermissionStatus,
	PermissionUpdate,
	PlanStep,
	PockodeCommandInvocation,
	QuestionAnswerRecord,
	QuestionRecordStatus,
	RecordedAccount,
	SubagentReport,
	Thought,
	ToolFetch,
	ToolRun,
	ToolRunPermission,
	ToolRunStatus,
	UserMessage,
	WorkRef,
} from "../types/message";
import type * as Wire from "../types/wire.generated";
import { AGENT_TYPES } from "./agentType";
import type { ChatItems, Echo, ItemNode, TurnEntry } from "./chatItems";
import { serverTime, takeRowsChangedFrom } from "./chatItems";
import { parseContentBlocks, parseFileBlocks } from "./contentBlocks";
import { editAtPath, findPartPath, findToolRunPath } from "./partTree";
import { isStopTool } from "./taskStop";
import { isDrawnThought } from "./thinking";
import { PLAN_TOOL_NAME } from "./toolSummary";

/*
 * The transcript as the chat draws it, built from the items the server sent
 * (`ChatItems`). Everything about what an item *is* — a call's status, its
 * permission and answer, a question's fate, a turn's ending — is the server's
 * and is read as sent. What is decided here is only how it is drawn:
 *
 * - **Bubbles.** A turn's items are a user message and the reply under it. A
 *   message sent into a running turn is drawn under the reply that was being
 *   written when it arrived, and the reply splits only where the agent read it
 *   (a `read` item); a turn's ending goes on its last bubble.
 * - **Rows.** Consecutive texts and thinking of one speaker are one part; a
 *   call held on a permission request is drawn as the card in its row's place;
 *   a posted question takes the place of the `question_post` call that posted
 *   it; a fetch of an earlier call's task is filed on that call.
 * - **Live state.** What a call in flight says about itself (`streams`), and a
 *   press on a permission card the server has not recorded yet.
 */

// Legacy history recorded system messages with origin "work" before the
// concept was renamed to "system".
function normalizeOrigin(raw: unknown): MessageOrigin | undefined {
	if (raw === "system" || raw === "work") return "system";
	if (raw === "user") return "user";
	if (raw === "agent") return "agent";
	return undefined;
}

// Checked at the wire boundary like every other closed set: a reason this
// build does not know reads as none, which is a banner true of all of them.
const EXPIRY_REASONS: readonly string[] = [
	"process_ended",
	"timeout",
	"work_closed",
	"step_done",
];

function normalizeExpiryReason(raw: unknown): ExpiryReason | undefined {
	return typeof raw === "string" && EXPIRY_REASONS.includes(raw)
		? (raw as ExpiryReason)
		: undefined;
}

function optionalString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function optionalCount(raw: unknown): number | undefined {
	return typeof raw === "number" && raw >= 0 ? raw : undefined;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === "object" && raw !== null;
}

/** A result's `subagent`; undefined when it says nothing. */
function parseSubagentReport(raw: unknown): SubagentReport | undefined {
	if (!isRecord(raw)) return undefined;
	const agentId = optionalString(raw.agent_id);
	const agentType = optionalString(raw.agent_type);
	const toolUses = optionalCount(raw.tool_uses);
	const totalTokens = optionalCount(raw.total_tokens);
	const report: SubagentReport = {
		...(agentId ? { agentId } : {}),
		...(agentType ? { agentType } : {}),
		...(toolUses !== undefined ? { toolUses } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
	};
	return Object.keys(report).length > 0 ? report : undefined;
}

/**
 * A result's `work_ref`; undefined unless it names a work by id and a known
 * type. A missing title reads as empty: the id is still where *Open* leads.
 */
function parseWorkRef(raw: unknown): WorkRef | undefined {
	if (!isRecord(raw)) return undefined;
	const { id, type, title } = raw;
	if (typeof id !== "string" || id === "") return undefined;
	if (type !== "story" && type !== "task" && type !== "job") return undefined;
	return { id, type, title: typeof title === "string" ? title : "" };
}

const PLAN_STEP_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** A plan's steps; a step this build cannot read is left out. */
function parsePlanSteps(raw: unknown): PlanStep[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((step): PlanStep[] => {
		if (!isRecord(step) || typeof step.text !== "string") return [];
		if (!PLAN_STEP_STATUSES.has(step.status as string)) return [];
		const id = optionalString(step.id);
		const activeText = optionalString(step.active_text);
		return [
			{
				...(id ? { id } : {}),
				text: step.text,
				...(activeText ? { activeText } : {}),
				status: step.status as PlanStep["status"],
			},
		];
	});
}

/**
 * The CLI and account an `auth_failure` or `usage_limit` mark names. An agent
 * this build does not know reads as no mark, and a missing `profile_id` stays
 * missing — the account of a record kept before accounts were is unknown.
 */
function normalizeRecordedAccount(raw: unknown): RecordedAccount | undefined {
	const mark = raw as { agent?: unknown; profile_id?: unknown } | null;
	const agent = AGENT_TYPES.find((type) => type === mark?.agent);
	if (!agent) return undefined;
	return typeof mark?.profile_id === "string"
		? { agent, profileId: mark.profile_id }
		: { agent };
}

/**
 * A message's `command`, kept only when it names one. Also reads the same
 * field on the `chat.message` reply.
 */
export function normalizeCommand(
	raw: unknown,
): PockodeCommandInvocation | undefined {
	const fields = raw as Record<string, unknown> | null | undefined;
	if (typeof fields?.name !== "string" || !fields.name) return undefined;
	return typeof fields.args === "string" && fields.args
		? { name: fields.name, args: fields.args }
		: { name: fields.name };
}

/**
 * A message's `html_action`, kept only when it names a page and an action.
 * Also reads the same field on the `chat.html_action` reply.
 */
export function normalizeHtmlAction(raw: unknown): HtmlAction | undefined {
	const fields = raw as Record<string, unknown> | null | undefined;
	if (typeof fields?.page !== "string" || !fields.page) return undefined;
	if (typeof fields.action !== "string" || !fields.action) return undefined;
	return {
		page: fields.page,
		action: fields.action,
		data: fields.data === undefined ? {} : fields.data,
	};
}

/**
 * Index of the bubble the open turn is writing into — the last assistant still
 * `sending` or `streaming` — or -1 when no turn is writing. Not "the last
 * message": a message sent into a running turn is drawn under that turn's
 * reply, and a failed send's reason under the message.
 */
export function openAssistantIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		if (m.status === "sending" || m.status === "streaming") return i;
	}
	return -1;
}

/** What `buildTranscript` keeps between builds; one per transcript. */
export interface TranscriptCache {
	/** The messages built for each stretch, by its key. */
	stretches: Map<string, BuiltStretch>;
	/** The row each echo is drawn as, while the transcript does not hold it. */
	echoes: WeakMap<Echo, Row>;
	/** Rows built from one node, or a run starting at it, by node version. */
	parts: WeakMap<ItemNode, { nodes: ItemNode[]; part: ContentPart }>;
	users: WeakMap<ItemNode, UserMessage>;
	/**
	 * The last build's stretches, in order, of `store`, with the lowest id of
	 * the echo rows it drew (`Infinity` for none): what the next build keeps
	 * the part of that no row changed in.
	 */
	last?: { store: ChatItems; stretches: Stretch[]; echoesFrom: number };
}

interface BuiltStretch {
	/** What the stretch was built from besides its rows. */
	deps: unknown[];
	nodes: Row[];
	messages: Message[];
}

export function createTranscriptCache(): TranscriptCache {
	return {
		stretches: new Map(),
		echoes: new WeakMap(),
		parts: new WeakMap(),
		users: new WeakMap(),
	};
}

export interface TranscriptOptions {
	/**
	 * Whether the transcript is followed live. A read-only one (another
	 * worktree's) will never be continued, so a turn it shows as open is drawn
	 * as finished.
	 */
	live: boolean;
}

/**
 * A top-level item, or a message this client sent that the transcript does
 * not hold yet — drawn where it was sent, in the turn it went into.
 */
type Row = ItemNode & { echo?: Echo };

interface Stretch {
	key: string;
	turnId?: string;
	nodes: Row[];
}

/** The echoes the transcript does not hold, as rows placed where they were sent. */
function echoRows(store: ChatItems, cache: TranscriptCache): Row[] {
	const rows: Row[] = [];
	// Sends are drawn in the order they were made: one never goes above the
	// item an earlier send became, though both were sent after the same item.
	let floor = 0;
	store.echoes.forEach((echo, i) => {
		const recorded = echo.itemId !== undefined && store.nodes.has(echo.itemId);
		const id = Math.max(echo.after ?? 0, floor) + (i + 1) / 1000;
		floor = Math.max(floor, recorded ? (echo.itemId as number) : id);
		if (recorded) return;
		let row = cache.echoes.get(echo);
		if (!row || row.id !== id) {
			row = {
				id,
				partId: echo.message.id,
				children: [],
				item: { kind: "message" },
				echo,
				...(echo.turnId ? { turnId: echo.turnId } : {}),
			};
			cache.echoes.set(echo, row);
		}
		rows.push(row);
	});
	return rows;
}

/**
 * The top-level items and the echoes, cut into runs of one turn, in order.
 *
 * A record changes rows near the end, so the stretches of the last build that
 * lie wholly before the first changed row are kept as they were, and only the
 * rest is walked — all but the last of them, which the row after it may have
 * joined. A stretch walked whose rows are the ones it had gets the same array
 * back. An echo row changes without the store marking a row, so a stretch
 * is kept only if it lies wholly before every echo row of this build and the
 * last — which, sends going at the end, is all but the newest few; an echo
 * left failed and unrecorded does not make every later build walk it all.
 */
function stretchesOf(store: ChatItems, cache: TranscriptCache): Stretch[] {
	const from = takeRowsChangedFrom(store, cache);
	const echoes = echoRows(store, cache);
	let echoesFrom = Number.POSITIVE_INFINITY;
	for (const echo of echoes) echoesFrom = Math.min(echoesFrom, echo.id);
	const stretches: Stretch[] = [];
	let start = 0;
	const last = cache.last;
	if (last?.store === store && from !== Number.NEGATIVE_INFINITY) {
		let before = 0;
		while (
			before < last.stretches.length &&
			(last.stretches[before].nodes.at(-1)?.id ?? 0) < from
		) {
			before++;
		}
		const keep = before - 1;
		const first = keep > 0 ? last.stretches[keep].nodes[0]?.id : undefined;
		if (first !== undefined) {
			const at = lowerBound(store.top, first);
			if (
				store.top[at] === first &&
				Math.min(echoesFrom, last.echoesFrom) > first
			) {
				stretches.push(...last.stretches.slice(0, keep));
				start = at;
			}
		}
	}

	let current: Stretch | undefined;
	// The current stretch's rows at the last build, and how many of them it
	// has matched so far — while it matches, `current.nodes` is that array.
	let held: Row[] | undefined;
	let matched = 0;
	const finish = () => {
		if (current && held && current.nodes === held && matched !== held.length) {
			current.nodes = held.slice(0, matched);
		}
	};
	const add = (node: Row) => {
		if (!current || current.turnId !== node.turnId) {
			finish();
			const key = `${node.turnId ?? "-"}@${node.partId}`;
			held = cache.stretches.get(key)?.nodes;
			matched = 0;
			current = { key, turnId: node.turnId, nodes: held ?? [] };
			stretches.push(current);
		}
		if (held && current.nodes === held) {
			if (held[matched] === node) {
				matched++;
				return;
			}
			current.nodes = held.slice(0, matched);
		}
		current.nodes.push(node);
	};
	let e = 0;
	for (let i = start; i < store.top.length; i++) {
		const id = store.top[i];
		const node = store.nodes.get(id);
		if (!node) continue;
		while (e < echoes.length && echoes[e].id < id) add(echoes[e++]);
		add(node);
	}
	while (e < echoes.length) add(echoes[e++]);
	finish();
	cache.last = { store, stretches, echoesFrom };
	return stretches;
}

/** The first index of the id-ordered `list` whose id is not below `id`. */
function lowerBound(list: number[], id: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid] < id) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The chat's messages, built from `store`. Whatever did not change since the
 * last build with the same cache comes back as the same objects, so a record
 * re-renders the bubble it touched and nothing else.
 */
export function buildTranscript(
	store: ChatItems,
	cache: TranscriptCache,
	options: TranscriptOptions,
): Message[] {
	const stretches = stretchesOf(store, cache);
	// The turn a stretch is the main body of, as against one of its stragglers
	// (output tagged with it after the next turn started): only the first draws
	// the turn's opening and ending.
	const firstStretchOf = new Map<string, string>();
	let newestTurn: string | undefined;
	let newestStart = -1;
	for (const stretch of stretches) {
		if (!stretch.turnId) continue;
		if (!firstStretchOf.has(stretch.turnId)) {
			firstStretchOf.set(stretch.turnId, stretch.key);
		}
		const start = store.turns.get(stretch.turnId)?.turn.start_seq ?? 0;
		if (start >= newestStart) {
			newestStart = start;
			newestTurn = stretch.turnId;
		}
	}
	const aliases = echoAliases(store);
	const out: Message[] = [];
	const built = new Map<string, BuiltStretch>();
	for (let i = 0; i < stretches.length; i++) {
		const stretch = stretches[i];
		const entry = stretch.turnId ? store.turns.get(stretch.turnId) : undefined;
		const main =
			stretch.turnId === undefined ||
			firstStretchOf.get(stretch.turnId) === stretch.key;
		const open =
			options.live &&
			entry !== undefined &&
			!entry.turn.ended &&
			stretch.turnId === newestTurn &&
			main;
		const next = stretches[i + 1]?.nodes[0]?.item.seq;
		const last = options.live && i === stretches.length - 1;
		const continued =
			store.continuedFrom !== undefined &&
			stretch.nodes[0]?.id === store.continuedFrom;
		const deps: unknown[] = [
			entry,
			main,
			open,
			next,
			last,
			continued,
			aliases.version,
		];
		const held = cache.stretches.get(stretch.key);
		const messages =
			held && held.nodes === stretch.nodes && sameList(held.deps, deps)
				? held.messages
				: buildStretch(store, cache, stretch, {
						entry,
						main,
						open,
						next,
						last,
						continued,
						aliases,
						previous: held?.messages,
					});
		built.set(stretch.key, { deps, nodes: stretch.nodes, messages });
		out.push(...messages);
	}
	cache.stretches = built;
	return out;
}

function sameList(a: unknown[], b: unknown[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface Aliases {
	version: number;
	/** The keys an echo lends the item it became, by item id. */
	byItem: Map<number, Echo>;
}

function echoAliases(store: ChatItems): Aliases {
	const byItem = new Map<number, Echo>();
	for (const echo of store.echoes) {
		if (echo.itemId !== undefined) byItem.set(echo.itemId, echo);
	}
	return { version: store.echoVersion, byItem };
}

interface StretchContext {
	entry?: TurnEntry;
	main: boolean;
	open: boolean;
	/** The seq of the item after this stretch, which a bubble's anchor stays below. */
	next?: HistorySeq;
	/** The stretch ends a transcript that is followed live. */
	last: boolean;
	/** The stretch's turn goes on above it, on a page not loaded yet. */
	continued: boolean;
	aliases: Aliases;
	previous?: Message[];
}

/** A bubble being filled, before it is closed into an `AssistantMessage`. */
interface Draft {
	id: string;
	nodes: ItemNode[];
	openedAt?: number;
	endedAt?: number;
	error?: {
		text: string;
		authFailure?: RecordedAccount;
		usageLimit?: RecordedAccount;
	};
	/** A reply no turn has started for yet: the message is still on its way. */
	sending?: boolean;
	/** Opened where the agent read a message sent into its turn. */
	read?: boolean;
	/** Opened on a page not loaded yet. */
	startNotLoaded?: boolean;
}

function buildStretch(
	store: ChatItems,
	cache: TranscriptCache,
	stretch: Stretch,
	ctx: StretchContext,
): Message[] {
	const { entry, main } = ctx;
	const turn = entry?.turn;
	const rows: (UserMessage | Draft)[] = [];
	let draft: Draft | undefined;
	// Messages sent into the turn and not read yet: drawn under the reply that
	// was being written when they arrived, once that reply is closed — with a
	// failed send's reason under its message.
	let unread: (UserMessage | Draft)[] = [];
	const close = (endedAt?: number) => {
		if (draft) {
			if (endedAt !== undefined) draft.endedAt = endedAt;
			rows.push(draft);
			draft = undefined;
		}
		rows.push(...unread);
		unread = [];
	};
	const firstBubbleId = (): string => {
		const opener = stretch.nodes.find((n) => isOpener(n, turn));
		const alias = opener
			? ctx.aliases.byItem.get(opener.id)?.replyId
			: undefined;
		return alias ?? `turn:${stretch.turnId}`;
	};
	let opened = false;
	for (const node of stretch.nodes) {
		const { item } = node;
		if (node.echo) {
			const { echo } = node;
			const failure: Draft | undefined =
				echo.error !== undefined
					? {
							id: echo.replyId ?? `${echo.message.id}:failed`,
							nodes: [],
							error: { text: echo.error },
						}
					: undefined;
			if ((turn || draft?.sending) && draft) {
				unread.push(echo.message, ...(failure ? [failure] : []));
			} else {
				close();
				rows.push(echo.message);
				if (failure) rows.push(failure);
				else if (echo.replyId) {
					// Sent to an idle agent: its reply is drawn at once.
					draft = {
						id: echo.replyId,
						nodes: [],
						openedAt: echo.openedAt,
						sending: true,
					};
				}
			}
			continue;
		}
		if (item.kind === "message") {
			const message = userMessage(cache, node, ctx.aliases);
			if (main && isOpener(node, turn) && !opened) {
				close();
				rows.push(message);
				opened = true;
				draft = {
					id: firstBubbleId(),
					nodes: [],
					openedAt: serverTime(item.message?.observed_at),
				};
			} else if ((turn || draft?.sending) && draft) {
				unread.push(message);
			} else {
				close();
				rows.push(message);
				// A message this client sent to an idle agent, recorded before its
				// turn started: the reply drawn under it since the send stays until
				// the turn takes the message in. Only this client's own — a message
				// whose turn never started is not proof of a reply on its way.
				const echo = ctx.aliases.byItem.get(node.id);
				if (!turn && echo?.replyId && ctx.last) {
					draft = {
						id: echo.replyId,
						nodes: [],
						openedAt: echo.openedAt ?? serverTime(item.message?.observed_at),
						sending: true,
					};
				}
			}
			continue;
		}
		if (item.kind === "read") {
			const at = serverTime(item.read?.observed_at);
			close(at);
			draft = {
				id: `read:${node.partId}`,
				nodes: [],
				openedAt: at,
				read: true,
			};
			opened = true;
			continue;
		}
		if (!draft) {
			draft = {
				id:
					stretch.turnId === undefined
						? `none:${node.partId}`
						: main && !opened
							? firstBubbleId()
							: `late:${node.partId}`,
				nodes: [],
				// Nothing loaded opened it, and the turn goes on above.
				...(ctx.continued && !opened ? { startNotLoaded: true } : {}),
			};
			opened = true;
		}
		if (item.kind === "error") {
			draft.error = {
				text: item.error?.error ?? "",
				authFailure: normalizeRecordedAccount(item.error?.auth_failure),
				usageLimit: normalizeRecordedAccount(item.error?.usage_limit),
			};
			draft.nodes.push(node);
			continue;
		}
		draft.nodes.push(node);
	}
	// A turn that ended with nothing in it still says how it ended, and what
	// its Stop threw away.
	const discarded = discardedIds(entry?.discarded);
	if (
		!draft &&
		main &&
		turn &&
		(turn.ended
			? endStatus(turn) !== "complete" || discarded.length > 0
			: ctx.open)
	) {
		draft = { id: firstBubbleId(), nodes: [] };
	}
	const lastDraft = draft;
	close(main && turn?.ended ? serverTime(turn.ended_at) : undefined);

	const messages: Message[] = [];
	const previous = new Map(ctx.previous?.map((m) => [m.id, m]));
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (!("nodes" in row)) {
			messages.push(row);
			continue;
		}
		const isLast = row === lastDraft;
		const status: AssistantMessage["status"] =
			isLast && main && turn
				? turn.ended
					? endStatus(turn)
					: ctx.open
						? "streaming"
						: "complete"
				: row.error
					? "error"
					: row.sending
						? "sending"
						: "complete";
		// The first row drawn after this one that has a place in history: a
		// send not recorded yet, or its failure, has none.
		let cap = ctx.next;
		for (const nextRow of rows.slice(i + 1)) {
			const seq =
				"nodes" in nextRow ? nextRow.nodes[0]?.item.seq : nextRow.anchorSeq;
			if (seq !== undefined) {
				cap = seq;
				break;
			}
		}
		const bubble = assistantMessage(store, cache, row, {
			status,
			cap,
			endSeq: isLast && main ? turn?.end_seq : undefined,
			discarded: isLast && main && discarded.length > 0 ? discarded : undefined,
			error: status === "error" ? (row.error ?? { text: "" }) : undefined,
		});
		if (
			bubble.parts.length === 0 &&
			bubble.status === "complete" &&
			!bubble.discardedMessageIds
		) {
			continue;
		}
		const held = previous.get(bubble.id);
		messages.push(
			held?.role === "assistant" && sameBubble(held, bubble) ? held : bubble,
		);
	}
	return messages;
}

/** The message that opened `turn`. */
function isOpener(
	node: ItemNode,
	turn: TurnEntry["turn"] | undefined,
): boolean {
	if (!turn || node.item.kind !== "message" || turn.origin !== "prompt") {
		return false;
	}
	return turn.message_id
		? node.item.message?.message_id === turn.message_id
		: true;
}

function endStatus(turn: TurnEntry["turn"]): AssistantMessage["status"] {
	switch (turn.ended_by) {
		case "done":
			return "complete";
		case "interrupted":
			return "interrupted";
		case "process_ended":
		case "process_started":
			return "process_ended";
		case "failed":
		case "auth_failed":
			return "error";
	}
	switch (turn.outcome) {
		case "completed":
			return "complete";
		case "failed":
		case "auth_failed":
			return "error";
		case "aborted":
			return "interrupted";
		default:
			return "complete";
	}
}

function discardedIds(discarded: DiscardedMessage[] | undefined): string[] {
	return (discarded ?? []).flatMap((d) => (d.message_id ? [d.message_id] : []));
}

function userMessage(
	cache: TranscriptCache,
	node: ItemNode,
	aliases: Aliases,
): UserMessage {
	const echo = aliases.byItem.get(node.id);
	const id = echo?.message.id ?? `user:${node.partId}`;
	const held = cache.users.get(node);
	if (held && held.id === id) return held;
	const m = node.item.message ?? {};
	const origin = normalizeOrigin(m.origin);
	const anchorSeq = node.item.last_seq ?? node.item.seq;
	const attachments = parseFileBlocks(m.attachments);
	const command = normalizeCommand(m.command);
	const htmlAction = normalizeHtmlAction(m.html_action);
	const answering =
		Array.isArray(m.answering) && m.answering.length > 0
			? (m.answering as QuestionAnswerRecord[])
			: undefined;
	const observedAt = serverTime(m.observed_at);
	const message: UserMessage = {
		id,
		role: "user",
		content: m.content ?? "",
		status: "complete",
		createdAt: echo?.message.createdAt ?? new Date(observedAt ?? 0),
		...(anchorSeq !== undefined ? { anchorSeq } : {}),
		...(m.message_id ? { messageId: m.message_id } : {}),
		// Only the messages a person did not type are tagged.
		...(origin === "system"
			? { source: origin, subtype: m.subtype, meta: m.meta }
			: {}),
		...(origin === "agent" ? { source: origin } : {}),
		...(answering ? { answering } : {}),
		...(command ? { command } : {}),
		...(attachments ? { attachments } : {}),
		...(htmlAction ? { htmlAction } : {}),
	};
	cache.users.set(node, message);
	return message;
}

function assistantMessage(
	store: ChatItems,
	cache: TranscriptCache,
	draft: Draft,
	{
		status,
		cap,
		endSeq,
		discarded,
		error,
	}: {
		status: AssistantMessage["status"];
		cap?: HistorySeq;
		endSeq?: HistorySeq;
		discarded?: string[];
		error?: Draft["error"];
	},
): AssistantMessage {
	const parts = buildParts(store, cache, draft.nodes, true);
	const anchorSeq = bubbleAnchor(draft.nodes, cap, endSeq);
	const awaitedFetch =
		status === "streaming" ? awaitedFetchOf(store, draft.nodes) : undefined;
	return {
		id: draft.id,
		role: "assistant",
		parts,
		status,
		createdAt: new Date(draft.openedAt ?? 0),
		...(error ? { error: error.text } : {}),
		...(error?.authFailure ? { authFailure: error.authFailure } : {}),
		...(error?.usageLimit ? { usageLimit: error.usageLimit } : {}),
		...(anchorSeq !== undefined ? { anchorSeq } : {}),
		...(draft.read ? { openedAtReadPoint: true as const } : {}),
		...(draft.startNotLoaded ? { startNotLoaded: true as const } : {}),
		...(draft.openedAt !== undefined ? { openedAt: draft.openedAt } : {}),
		...(draft.endedAt !== undefined && status !== "streaming"
			? { endedAt: draft.endedAt }
			: {}),
		...(discarded ? { discardedMessageIds: discarded } : {}),
		...(awaitedFetch ? { awaitedFetch } : {}),
	};
}

/**
 * The cut point a fork anchored on this bubble uses: the newest record that
 * went into it, kept below whatever is drawn after it — a call's `last_seq`
 * moves on when a background outcome arrives turns later, and a fork from
 * here must not take that in.
 */
function bubbleAnchor(
	nodes: ItemNode[],
	cap: HistorySeq | undefined,
	endSeq: HistorySeq | undefined,
): HistorySeq | undefined {
	const below = (seq: HistorySeq | undefined) =>
		seq !== undefined && (cap === undefined || seq < cap);
	let anchor: HistorySeq | undefined;
	const consider = (seq: HistorySeq | undefined) => {
		if (below(seq) && (anchor === undefined || (seq as number) > anchor)) {
			anchor = seq;
		}
	};
	for (const node of nodes) {
		consider(node.item.seq);
		consider(node.item.last_seq);
	}
	consider(endSeq);
	return anchor;
}

/**
 * The fetch the open turn is waiting on: the main agent's newest call is a
 * fetch filed under the run it reads, still running. Its row is not drawn, so
 * this is what the tail line reads (docs/turn-progress-ui.md#23-what-it-says).
 */
function awaitedFetchOf(
	store: ChatItems,
	nodes: ItemNode[],
): AwaitedFetch | undefined {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const { item } = nodes[i];
		const tool = item.tool;
		if (item.kind !== "text" && item.kind !== "thinking" && !tool) continue;
		if (item.kind === "thinking" && !isDrawnThought(thought(nodes[i]))) {
			continue;
		}
		if (!tool || !isFiledFetch(store, tool) || tool.status !== "running") {
			return undefined;
		}
		return {
			id: tool.tool_use_id ?? "",
			originToolUseId: tool.origin_tool_use_id ?? "",
			waits: fetchWaits(tool.tool_input),
		};
	}
	return undefined;
}

function sameBubble(a: AssistantMessage, b: AssistantMessage): boolean {
	return (
		a.status === b.status &&
		a.error === b.error &&
		a.anchorSeq === b.anchorSeq &&
		a.openedAt === b.openedAt &&
		a.openedAtReadPoint === b.openedAtReadPoint &&
		a.startNotLoaded === b.startNotLoaded &&
		a.endedAt === b.endedAt &&
		sameAccount(a.authFailure, b.authFailure) &&
		sameAccount(a.usageLimit, b.usageLimit) &&
		sameList(a.discardedMessageIds ?? [], b.discardedMessageIds ?? []) &&
		a.awaitedFetch?.id === b.awaitedFetch?.id &&
		a.awaitedFetch?.waits === b.awaitedFetch?.waits &&
		sameList(a.parts, b.parts)
	);
}

function sameAccount(
	a: RecordedAccount | undefined,
	b: RecordedAccount | undefined,
): boolean {
	return a?.agent === b?.agent && a?.profileId === b?.profileId;
}

/** A call that only reads an earlier call's task, and that call is loaded. */
function isFiledFetch(store: ChatItems, tool: ToolItem): boolean {
	return (
		!!tool.origin_tool_use_id &&
		!isStopTool(tool.tool_name ?? "") &&
		store.byToolUse.has(tool.origin_tool_use_id)
	);
}

/** `TaskOutput`'s `block`, true when absent: the fetch waits for the task. */
function fetchWaits(input: unknown): boolean {
	return !(isRecord(input) && input.block === false);
}

function thought(node: ItemNode): Thought {
	const t = node.item.thinking ?? {};
	return {
		id: node.partId,
		content: t.content ?? "",
		fullReasoning: t.full_reasoning ?? "",
		redacted: t.redacted === true,
		...(typeof t.duration_ms === "number" && t.duration_ms > 0
			? { durationMs: t.duration_ms }
			: {}),
	};
}

/** Whose a top-level part is when its run is not in the history. */
function speakerOf(item: PageItem): string | undefined {
	return (
		optionalString(item.text?.parent_tool_use_id) ??
		optionalString(item.thinking?.parent_tool_use_id) ??
		optionalString(item.tool?.parent_tool_use_id) ??
		optionalString(item.plan?.parent_tool_use_id)
	);
}

/**
 * The rows `nodes` draw as, in order. `topLevel` says they are a bubble's
 * rather than a run's children, where whose they are is already said by where
 * they sit.
 */
function buildParts(
	store: ChatItems,
	cache: TranscriptCache,
	nodes: ItemNode[],
	topLevel: boolean,
): ContentPart[] {
	let parts: ContentPart[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		const { item } = node;
		const speaker = topLevel ? speakerOf(item) : undefined;
		if (item.kind === "text" || item.kind === "thinking") {
			// A run of one speaker's texts, or of its thinking, is one part.
			const run: ItemNode[] = [node];
			while (
				i + 1 < nodes.length &&
				nodes[i + 1].item.kind === item.kind &&
				(topLevel ? speakerOf(nodes[i + 1].item) : undefined) === speaker
			) {
				run.push(nodes[++i]);
			}
			const part = runPart(cache, run, speaker);
			if (part) parts.push(part);
			continue;
		}
		if (item.kind === "question" && item.question) {
			parts = placeQuestion(
				parts,
				questionPart(node, item.question),
				(toolUseId) => postedDuring(store, toolUseId, item.seq),
			);
			continue;
		}
		if (
			item.kind === "error" ||
			item.kind === "message" ||
			item.kind === "read"
		) {
			continue;
		}
		if (item.tool && isFiledFetch(store, item.tool)) continue;
		const part = itemPart(store, cache, node, speaker);
		if (part) parts.push(part);
	}
	return parts;
}

function runPart(
	cache: TranscriptCache,
	run: ItemNode[],
	speaker: string | undefined,
): ContentPart | undefined {
	const held = cache.parts.get(run[0]);
	if (held && sameList(held.nodes, run)) return held.part;
	const first = run[0];
	let part: ContentPart | undefined;
	if (first.item.kind === "text") {
		part = {
			id: first.partId,
			type: "text",
			// A record is a whole message, so two are two paragraphs.
			content: run.map((n) => n.item.text?.content ?? "").join("\n\n"),
			...(speaker ? { parentToolUseId: speaker } : {}),
		};
	} else {
		const thoughts = run.map(thought).filter(isDrawnThought);
		if (thoughts.length > 0) {
			part = {
				id: thoughts[0].id,
				type: "thinking",
				thoughts,
				...(speaker ? { parentToolUseId: speaker } : {}),
			};
		}
	}
	if (part) cache.parts.set(first, { nodes: run, part });
	return part;
}

function itemPart(
	store: ChatItems,
	cache: TranscriptCache,
	node: ItemNode,
	speaker: string | undefined,
): ContentPart | undefined {
	const held = cache.parts.get(node);
	if (held && held.nodes.length === 1) return held.part;
	const part = freshItemPart(store, cache, node, speaker);
	if (part) cache.parts.set(node, { nodes: [node], part });
	return part;
}

function freshItemPart(
	store: ChatItems,
	cache: TranscriptCache,
	node: ItemNode,
	speaker: string | undefined,
): ContentPart | undefined {
	const { item, partId: id } = node;
	switch (item.kind) {
		case "tool":
			return item.tool
				? toolPart(store, cache, node, item.tool, speaker)
				: undefined;
		case "plan":
			return item.plan ? planPart(node, item.plan, speaker) : undefined;
		case "system":
			return { id, type: "system", content: item.system?.content ?? "" };
		case "raw":
			return { id, type: "raw", content: item.raw?.content ?? "" };
		case "command_output":
			return {
				id,
				type: "command_output",
				content: item.command_output?.content ?? "",
			};
		case "warning":
			return {
				id,
				type: "warning",
				message: item.warning?.message ?? "",
				code: item.warning?.code ?? "",
				authFailure: normalizeRecordedAccount(item.warning?.auth_failure),
				usageLimit: normalizeRecordedAccount(item.warning?.usage_limit),
			};
		default:
			// A kind this build does not know: drawn as what it is.
			return { id, type: "raw", content: JSON.stringify(item) };
	}
}

/**
 * A Codex plan has no call: it is a settled `Plan` row of its own, so lists,
 * groups and the work figures draw it with no special case. One filed on a
 * call the history does not hold has no row to ride on, and is dropped.
 */
function planPart(
	node: ItemNode,
	plan: PlanItem,
	speaker: string | undefined,
): ContentPart | undefined {
	if (!plan.plan_id) return undefined;
	const steps = parsePlanSteps(plan.steps);
	const explanation = optionalString(plan.explanation);
	return {
		id: node.partId,
		type: "tool_call",
		tool: {
			id: plan.plan_id,
			name: PLAN_TOOL_NAME,
			input: { steps, explanation },
			status: "success",
			plan: {
				steps,
				...(explanation ? { explanation } : {}),
				order: node.item.seq ?? 0,
			},
		},
		...(speaker ? { parentToolUseId: speaker } : {}),
	};
}

const ROW_STATUS: Record<ToolItem["status"], ToolRunStatus> = {
	running: "running",
	awaiting_permission: "running",
	background: "background",
	succeeded: "success",
	failed: "error",
	interrupted: "interrupted",
	denied: "error",
	expired: "error",
};

/**
 * A call as a row — or, while it waits on a permission request, as the card
 * in the row's place: nothing about it runs while someone decides, and a row
 * spinning above the card would say the machine is busy
 * (docs/tool-call-ui.md#the-permission-card-takes-the-rows-place). A denied
 * call stays a card until the engine reports the refusal, an expired one for
 * good, and a request naming no call is only ever a card.
 */
function toolPart(
	store: ChatItems,
	cache: TranscriptCache,
	node: ItemNode,
	tool: ToolItem,
	speaker: string | undefined,
): ContentPart {
	const permission = tool.permission;
	const pressed = permission
		? store.pressed.get(permission.request_id)
		: undefined;
	if (
		permission &&
		(!tool.tool_use_id ||
			tool.status === "awaiting_permission" ||
			tool.status === "denied" ||
			tool.status === "expired")
	) {
		const status: PermissionStatus =
			permission.status === "pending" && pressed ? pressed : permission.status;
		const by = optionalString(permission.by);
		const answeredAt = serverTime(permission.answered_at);
		const reason = normalizeExpiryReason(permission.reason);
		return {
			id: node.partId,
			type: "permission_request",
			request: {
				requestId: permission.request_id,
				toolName: tool.tool_name ?? "",
				toolInput: tool.tool_input,
				toolUseId: tool.tool_use_id ?? "",
				// The CLI's own suggestions, handed back to it with Always Allow.
				permissionSuggestions: permission.suggestions as
					| PermissionUpdate[]
					| undefined,
			},
			status,
			...(status === "expired" && reason ? { reason } : {}),
			...(by ? { by, review: permissionReview(permission.review) } : {}),
			...(permission.always ? { always: true } : {}),
			...(permission.status !== "pending" ? { answerRecorded: true } : {}),
			...(answeredAt !== undefined ? { answeredAt } : {}),
			...(speaker ? { parentToolUseId: speaker } : {}),
		};
	}
	return {
		id: node.partId,
		type: "tool_call",
		tool: toolRun(store, cache, node, tool),
		...(speaker ? { parentToolUseId: speaker } : {}),
	};
}

function permissionReview(
	raw: Wire.PermissionReview | undefined,
): PermissionReview | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	return {
		sessionId: optionalString(raw.session_id),
		category: optionalString(raw.category),
		automatic: optionalString(raw.automatic),
		reason: optionalString(raw.reason),
	};
}

function toolRun(
	store: ChatItems,
	cache: TranscriptCache,
	node: ItemNode,
	tool: ToolItem,
): ToolRun {
	const status = ROW_STATUS[tool.status];
	const result = tool.result;
	// While the work is in the background, what came back is the placeholder;
	// its outcome replaces it as the result once it reports.
	const settled = status !== "background" && status !== "running";
	const hasOutcome =
		result !== undefined && result.subtype !== "background_started";
	const stream =
		status === "running" || status === "background"
			? store.streams.get(tool.tool_use_id ?? "")
			: undefined;
	const permission = runPermission(tool);
	const plan = tool.plan
		? {
				steps: parsePlanSteps(tool.plan.steps),
				...(optionalString(tool.plan.explanation)
					? { explanation: tool.plan.explanation }
					: {}),
				order: node.item.last_seq ?? node.item.seq ?? 0,
			}
		: undefined;
	const fetches = fetchesOf(store, tool.tool_use_id);
	const children = node.children.flatMap((id) => {
		const child = store.nodes.get(id);
		return child ? [child] : [];
	});
	const contents = hasOutcome
		? parseContentBlocks(result?.contents)
		: undefined;
	const durationMs =
		typeof result?.duration_ms === "number" && result.duration_ms > 0
			? result.duration_ms
			: undefined;
	const subagent = parseSubagentReport(result?.subagent);
	const workRef = parseWorkRef(result?.work_ref);
	const htmlPage = optionalString(result?.html_page);
	const startedAt = serverTime(tool.started_at);
	const endedAt = serverTime(tool.ended_at);
	return {
		id: tool.tool_use_id ?? "",
		name: tool.tool_name ?? "",
		input: tool.tool_input,
		status,
		...(stream?.activity ? { activity: stream.activity } : {}),
		...(stream?.output !== undefined ? { output: stream.output } : {}),
		...(stream?.droppedLines
			? { outputDroppedLines: stream.droppedLines }
			: {}),
		...(stream?.subagentProgress && !settled
			? { subagentProgress: stream.subagentProgress }
			: {}),
		...(subagent ? { subagent } : {}),
		...(hasOutcome ? { result: result?.text ?? "" } : {}),
		...(contents ? { contents } : {}),
		...(tool.placeholder ? { placeholderResult: tool.placeholder } : {}),
		...(tool.backgrounded ? { fromBackground: true } : {}),
		...(tool.finished_after_stop ? { finishedAfterStop: true } : {}),
		...(tool.lost_with_process ? { lostWithProcess: true } : {}),
		...(permission ? { permission } : {}),
		...(fetches ? { fetches } : {}),
		...(plan ? { plan } : {}),
		...(tool.origin_tool_use_id && isStopTool(tool.tool_name ?? "")
			? { originToolUseId: tool.origin_tool_use_id }
			: {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		...(typeof result?.exit_code === "number"
			? { exitCode: result.exit_code }
			: {}),
		...(htmlPage ? { htmlPage } : {}),
		...(workRef ? { workRef } : {}),
		...(node.seenAt ? { seenAt: node.seenAt } : {}),
		...(children.length > 0
			? { children: buildParts(store, cache, children, false) }
			: {}),
	};
}

/** What a row keeps of the permission card that stood in its place. */
function runPermission(tool: ToolItem): ToolRunPermission | undefined {
	const permission = tool.permission;
	if (!permission) return undefined;
	if (permission.status !== "allowed" && permission.status !== "denied") {
		return undefined;
	}
	const by = optionalString(permission.by);
	const review = by ? permissionReview(permission.review) : undefined;
	return {
		answer: permission.status,
		...(by ? { by } : {}),
		...(review ? { review } : {}),
		...(permission.always ? { always: true } : {}),
		...(permission.always && permission.suggestions?.length
			? { suggestions: permission.suggestions as PermissionUpdate[] }
			: {}),
	};
}

function fetchesOf(
	store: ChatItems,
	toolUseId: string | undefined,
): ToolFetch[] | undefined {
	if (!toolUseId) return undefined;
	const ids = store.fetchesOf.get(toolUseId);
	if (!ids || ids.length === 0) return undefined;
	const fetches: ToolFetch[] = [];
	for (const id of ids) {
		const node = store.nodes.get(id);
		const tool = node?.item.tool;
		if (!node || !tool || isStopTool(tool.tool_name ?? "")) continue;
		const returned = tool.status === "succeeded" || tool.status === "failed";
		const state: ToolFetch["state"] =
			tool.status === "interrupted"
				? "interrupted"
				: returned
					? "returned"
					: "running";
		const result = tool.result;
		const contents = result ? parseContentBlocks(result.contents) : undefined;
		fetches.push({
			id: tool.tool_use_id ?? "",
			state,
			waits: fetchWaits(tool.tool_input),
			...(node.seenAt ? { seenAt: node.seenAt } : {}),
			...(result ? { result: result.text ?? "" } : {}),
			...(contents ? { contents } : {}),
			...(result?.is_error ? { isError: true } : {}),
		});
	}
	return fetches.length > 0 ? fetches : undefined;
}

const QUESTION_STATUS: Record<QuestionItem["status"], QuestionRecordStatus> = {
	open: "pending",
	answered: "answered",
	declined: "declined",
	withdrawn: "cancelled",
};

function questionPart(node: ItemNode, item: QuestionItem): QuestionCard {
	// A question a Stop reopened is drawn with the answer it threw away: the
	// card is the record of what was said, and says the answer went unread
	// (docs/answering-ui.md §6). The question is open again all the same, as
	// the session's unanswered list says.
	const q: QuestionItem =
		item.status === "open" && item.discarded_answer
			? {
					...item,
					status: item.discarded_answer.declined ? "declined" : "answered",
					answer: item.discarded_answer,
					answered_in: item.discarded_in,
				}
			: item;
	const status = QUESTION_STATUS[q.status] ?? "pending";
	const reason = normalizeExpiryReason(q.reason);
	return {
		id: node.partId,
		type: "question_record",
		record: {
			requestId: q.request_id,
			question: {
				question: q.question ?? "",
				header: q.header ?? "",
				options: q.options ?? [],
				multiSelect: q.multi_select ?? false,
			},
			...(q.asked_at ? { askedAt: q.asked_at } : {}),
		},
		status,
		...(q.answer && (status === "answered" || status === "declined")
			? { answer: q.answer as QuestionAnswerRecord }
			: {}),
		...(q.answered_in && (status === "answered" || status === "declined")
			? { answerMessageId: q.answered_in }
			: {}),
		...(status === "cancelled" && reason ? { reason } : {}),
		...(q.legacy ? { legacy: true, toolUseId: q.tool_use_id } : {}),
	};
}

type QuestionCard = Extract<ContentPart, { type: "question_record" }> & {
	/** A legacy card's ask tool call, whose row it takes. Not drawn. */
	toolUseId?: string;
};

/**
 * Puts a question card where it is drawn: in the place of the call that asked
 * it, which describes the same act.
 *
 * A legacy card (the CLI's own ask tool) names its call. A posted question
 * names none — the call reaches the server from the MCP endpoint, which does
 * not know the CLI's id for it — so it joins by position: behind the cards
 * of its batch (one call's questions share an `asked_at`), or in the place of
 * the newest `question_post` row not yet taken. A join that misses leaves the
 * row and the card side by side rather than getting one wrong
 * (docs/tool-call-ui.md).
 */
function placeQuestion(
	parts: ContentPart[],
	card: QuestionCard,
	/** Whether the call `toolUseId` was still running when the card was asked. */
	during: (toolUseId: string) => boolean,
): ContentPart[] {
	const { toolUseId, ...drawn } = card;
	if (card.legacy) {
		const sibling = findPartPath(
			parts,
			(p) =>
				p.type === "question_record" &&
				p.legacy === true &&
				p.record.requestId === card.record.requestId,
		);
		if (sibling) return insertAfter(parts, sibling, drawn);
		const row = toolUseId ? findToolRunPath(parts, toolUseId) : null;
		return row ? replaceAt(parts, row, drawn) : [...parts, drawn];
	}
	const askedAt = card.record.askedAt;
	const batch = askedAt
		? findPartPath(
				parts,
				(p) =>
					p.type === "question_record" &&
					!p.legacy &&
					p.record.askedAt === askedAt,
			)
		: null;
	if (batch) return insertAfter(parts, batch, drawn);
	const row = findPartPath(
		parts,
		(p) =>
			p.type === "tool_call" &&
			p.tool.name.endsWith("question_post") &&
			during(p.tool.id),
	);
	return row ? replaceAt(parts, row, drawn) : [...parts, drawn];
}

/**
 * Whether call `toolUseId` had not returned yet at record `seq`: the server
 * writes a posted question during the call that posts it.
 */
function postedDuring(
	store: ChatItems,
	toolUseId: string,
	seq: HistorySeq | undefined,
): boolean {
	const id = store.byToolUse.get(toolUseId);
	const result =
		id === undefined ? undefined : store.nodes.get(id)?.item.tool?.result;
	if (!result?.seq || seq === undefined) return true;
	return result.seq > seq;
}

function insertAfter(
	parts: ContentPart[],
	path: number[],
	part: ContentPart,
): ContentPart[] {
	return editAtPath(parts, path, (list, index) => {
		const updated = [...list];
		updated.splice(index + 1, 0, part);
		return updated;
	});
}

/** `part` in the place of the row at `path`, under the row's id and speaker. */
function replaceAt(
	parts: ContentPart[],
	path: number[],
	part: ContentPart,
): ContentPart[] {
	return editAtPath(parts, path, (list, index) => {
		const row = list[index];
		const speaker = row.type === "tool_call" ? row.parentToolUseId : undefined;
		const updated = [...list];
		updated[index] = {
			...part,
			id: row.id,
			...(speaker && part.type === "question_record"
				? { parentToolUseId: speaker }
				: {}),
		} as ContentPart;
		return updated;
	});
}
