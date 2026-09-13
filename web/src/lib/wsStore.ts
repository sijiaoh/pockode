import {
	createJSONRPCErrorResponse,
	JSONRPCClient,
	JSONRPCErrorException,
	type JSONRPCID,
	type JSONRPCRequester,
} from "json-rpc-2.0";
import { create } from "zustand";
import type {
	AgentRole,
	AgentRoleListChangedNotification,
	AgentRoleListSubscribeResult,
} from "../types/agentRole";
import type { GitDiffChangedNotification, GitDiffData } from "../types/git";
import type {
	AuthParams,
	AuthResult,
	ChatMessagesHistoryParams,
	ChatMessagesHistoryResult,
	ChatMessagesSubscribeResult,
	HistorySeq,
	ServerNotification,
	SessionDetailChangedNotification,
	SessionDetailSubscribeResult,
	SessionListChangedNotification,
	SessionListItem,
	SessionListSubscribeResult,
} from "../types/message";
import type {
	Settings,
	SettingsChangedNotification,
	SettingsSubscribeResult,
} from "../types/settings";
import type {
	Work,
	WorkDetailChangedNotification,
	WorkDetailSubscribeResult,
	WorkListChangedNotification,
	WorkListSubscribeResult,
} from "../types/work";
import { getWebSocketUrl } from "../utils/config";
import { generateUUID } from "../utils/uuid";
import {
	type AgentActions,
	type AgentRoleActions,
	type ChatActions,
	type CommandActions,
	createAgentActions,
	createAgentRoleActions,
	createChatActions,
	createCommandActions,
	createFileActions,
	createGitActions,
	createSessionActions,
	createSettingsActions,
	createWorkActions,
	createWorktreeActions,
	type FileActions,
	type GitActions,
	type SessionActions,
	type SettingsActions,
	type WorkActions,
	type WorktreeActions,
} from "./rpc";
import { APP_VERSION } from "./version";
import { worktreeActions } from "./worktreeStore";

export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "reconnecting"
	| "auth_failed"
	| "error";

interface ConnectionActions {
	connect: (token: string) => void;
	disconnect: () => void;
	/** Skip the remaining backoff and attempt to reconnect immediately. */
	retryNow: () => void;
}

// TODO: Implement retry logic for watcher subscriptions.
// Currently callers must handle failures; retry only happens on WebSocket reconnect.
// A timed-out subscribe is already cleaned up rather than retried; see
// openSubscription.

/**
 * Base result for all watch subscriptions.
 *
 * `id` names the subscription: what notifications are routed under and what to
 * unsubscribe by. It is the client's own, chosen by `openSubscription` before
 * the request went out, not something the reply carried back.
 */
export interface WatchSubscribeResult<TInitial = void> {
	id: string;
	initial?: TInitial;
}

export interface WatchActions {
	fsSubscribe: (
		path: string,
		callback: () => void,
	) => Promise<WatchSubscribeResult>;
	fsUnsubscribe: (id: string) => Promise<void>;
	gitSubscribe: (callback: () => void) => Promise<WatchSubscribeResult>;
	gitUnsubscribe: (id: string) => Promise<void>;
	gitDiffSubscribe: (
		path: string,
		staged: boolean,
		hideWhitespace: boolean,
		callback: (params: GitDiffChangedNotification) => void,
	) => Promise<WatchSubscribeResult<GitDiffData>>;
	gitDiffUnsubscribe: (id: string) => Promise<void>;
	worktreeSubscribe: (callback: () => void) => Promise<WatchSubscribeResult>;
	worktreeUnsubscribe: (id: string) => Promise<void>;
	sessionListSubscribe: (
		callback: (params: SessionListChangedNotification) => void,
	) => Promise<WatchSubscribeResult<SessionListItem[]>>;
	sessionListUnsubscribe: (id: string) => Promise<void>;
	sessionDetailSubscribe: (
		sessionId: string,
		callback: (params: SessionDetailChangedNotification) => void,
	) => Promise<WatchSubscribeResult<SessionDetailSubscribeResult>>;
	sessionDetailUnsubscribe: (id: string) => Promise<void>;
	chatMessagesSubscribe: (
		sessionId: string,
		callback: (notification: ServerNotification) => void,
	) => Promise<WatchSubscribeResult<ChatMessagesSubscribeResult>>;
	/** Fetches the page of history older than `beforeSeq` (exclusive). */
	chatMessagesHistory: (
		sessionId: string,
		beforeSeq: HistorySeq,
	) => Promise<ChatMessagesHistoryResult>;
	chatMessagesUnsubscribe: (id: string) => Promise<void>;
	settingsSubscribe: (
		callback: (params: SettingsChangedNotification) => void,
	) => Promise<WatchSubscribeResult<Settings>>;
	settingsUnsubscribe: (id: string) => Promise<void>;
	workListSubscribe: (
		callback: (params: WorkListChangedNotification) => void,
	) => Promise<WatchSubscribeResult<Work[]>>;
	workListUnsubscribe: (id: string) => Promise<void>;
	workDetailSubscribe: (
		workId: string,
		callback: (params: WorkDetailChangedNotification) => void,
	) => Promise<WatchSubscribeResult<WorkDetailSubscribeResult>>;
	workDetailUnsubscribe: (id: string) => Promise<void>;
	agentRoleListSubscribe: (
		callback: (params: AgentRoleListChangedNotification) => void,
	) => Promise<WatchSubscribeResult<AgentRole[]>>;
	agentRoleListUnsubscribe: (id: string) => Promise<void>;
}

type RPCActions = ConnectionActions &
	AgentActions &
	AgentRoleActions &
	ChatActions &
	CommandActions &
	SessionActions &
	SettingsActions &
	FileActions &
	GitActions &
	WatchActions &
	WorkActions &
	WorktreeActions;

interface WSState {
	status: ConnectionStatus;
	/**
	 * Consecutive failed reconnects. Because reconnection never gives up,
	 * "reconnecting" on its own looks the same after one second as after ten
	 * minutes; the count is what lets the UI escalate.
	 */
	reconnectAttempts: number;
	projectTitle: string;
	workDir: string;
	/** See `AuthResult.max_upload_size`; 0 until an auth reply has arrived. */
	maxUploadSize: number;
	actions: RPCActions;
}

// Module-level state for mutable objects (not reactive)
let ws: WebSocket | null = null;
let rpcClients: RPCClients | null = null;
let currentToken: string | null = null;
let reconnectTimeout: number | undefined;
// Worktree-scoped watch callbacks.
// Their server-side watchers live on the worktree and are torn down when the
// connection switches worktree, so these must be cleared on switch.
const fsWatchCallbacks = new Map<string, () => void>();
const gitWatchCallbacks = new Map<string, () => void>();
const gitDiffWatchCallbacks = new Map<
	string,
	(params: GitDiffChangedNotification) => void
>();
const sessionListWatchCallbacks = new Map<
	string,
	(params: SessionListChangedNotification) => void
>();
const sessionDetailWatchCallbacks = new Map<
	string,
	(params: SessionDetailChangedNotification) => void
>();
// Key: subscriptionId -> callback (unified with other watchers)
const chatMessagesCallbacks = new Map<
	string,
	(notification: ServerNotification) => void
>();

// App-level (global) watch callbacks.
// Their server-side watchers are Manager/app-level and span all worktrees; the
// server keeps pushing to them across worktree switches, so these must survive
// a switch and are only cleared when the connection itself goes away.
const worktreeWatchCallbacks = new Map<string, () => void>();
const settingsWatchCallbacks = new Map<
	string,
	(params: SettingsChangedNotification) => void
>();
const workListWatchCallbacks = new Map<
	string,
	(params: WorkListChangedNotification) => void
>();
const workDetailWatchCallbacks = new Map<
	string,
	(params: WorkDetailChangedNotification) => void
>();
const agentRoleListWatchCallbacks = new Map<
	string,
	(params: AgentRoleListChangedNotification) => void
>();

/**
 * Clear worktree-scoped watch subscriptions. Called when switching worktrees.
 *
 * App-level subscriptions (work list/detail, agent role list, settings,
 * worktree list) are intentionally preserved: their server watchers are global
 * and keep pushing across worktrees, so clearing them here would silently drop
 * notifications for hooks that don't resubscribe on switch.
 *
 * NOTE: When adding a new worktree-scoped watcher type, add cleanup here.
 * This mirrors server-side Worktree teardown on switch.
 */
function clearWorktreeWatchSubscriptions(): void {
	fsWatchCallbacks.clear();
	gitWatchCallbacks.clear();
	gitDiffWatchCallbacks.clear();
	sessionListWatchCallbacks.clear();
	sessionDetailWatchCallbacks.clear();
	chatMessagesCallbacks.clear();
}

/**
 * Clear all watch subscriptions, including app-level ones.
 * Called on disconnect, when the connection and all its server-side
 * subscriptions are gone.
 */
function clearAllWatchSubscriptions(): void {
	clearWorktreeWatchSubscriptions();
	worktreeWatchCallbacks.clear();
	settingsWatchCallbacks.clear();
	workListWatchCallbacks.clear();
	workDetailWatchCallbacks.clear();
	agentRoleListWatchCallbacks.clear();
}

// Callback to clear worktree-dependent caches (set by queryClient)
let onWorktreeSwitched: (() => void) | null = null;

export function setOnWorktreeSwitched(callback: (() => void) | null) {
	onWorktreeSwitched = callback;
}

// Retry forever, backing off. A client that gives up after a fixed handful of
// attempts is guaranteed to be gone before a real outage ends: the server's own
// uplink can be down for the better part of a minute before its keepalive
// notices, and it then reconnects with a backoff of its own. What that left was
// a dead page only a manual refresh recovered — after a lift, a shut lid, or a
// server restart. Backing off keeps the cost of a long outage to one attempt
// per RECONNECT_MAX_DELAY_MS rather than a hot loop, while a brief blip still
// recovers within a second.
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
// Every client of a restarting server begins its backoff at the same instant
// and would otherwise retry in lockstep, arriving as one burst.
const RECONNECT_JITTER = 0.2;

/** Milliseconds to wait before reconnect attempt `attempt`, counting from 0. */
function reconnectDelay(attempt: number): number {
	const base = Math.min(
		RECONNECT_BASE_DELAY_MS * 2 ** attempt,
		RECONNECT_MAX_DELAY_MS,
	);
	return Math.round(base * (1 + RECONNECT_JITTER * (2 * Math.random() - 1)));
}

/**
 * The browser knows a retry is worth attempting before the timer does: regained
 * connectivity, or a backgrounded tab coming back, both mean waiting out the
 * rest of a 30 second backoff is pointless.
 *
 * The "reconnecting" check is not just throttling. connect() does not guard
 * against "auth_failed", and the token outlives the rejection, so without it
 * every wake-up would re-offer a token the server has already refused.
 */
function listenForRecovery(): void {
	if (typeof window === "undefined") return;

	const retryIfWaiting = () => {
		const store = useWSStore.getState();
		if (store.status === "reconnecting") {
			store.actions.retryNow();
		}
	};
	window.addEventListener("online", retryIfWaiting);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") retryIfWaiting();
	});
}

/**
 * Whether a rejected auth request means the server actually turned us away.
 *
 * json-rpc-2.0 surfaces its own client-side timeout as a JSON-RPC error too,
 * but with DefaultErrorCode (0); a real rejection always carries a genuine
 * (negative) JSON-RPC code, and a dead transport rejects with a plain Error.
 * The distinction matters because "auth_failed" is terminal: misreading a
 * timeout as bad credentials strands the user whenever the tunnel is merely
 * slow or down.
 */
function isAuthRejection(error: unknown): boolean {
	return error instanceof JSONRPCErrorException && error.code !== 0;
}

function getClient(): JSONRPCRequester<void> | null {
	return rpcClients?.withTimeout ?? null;
}

function getAgentStartClient(): JSONRPCRequester<void> | null {
	return rpcClients?.withAgentStartTimeout ?? null;
}

const RPC_TIMEOUT_MS = 30000;

const RPC_TIMEOUT_MESSAGE = "Request timed out";

/**
 * Whether a request was given up on by our own clock rather than answered.
 *
 * The server may well still be working on it, so a caller that retries a timeout
 * stacks a second copy of the same work on top of the first — which is how one
 * slow response turns into four.
 */
export function isRPCTimeout(error: unknown): boolean {
	// Code 0 first: the server can word an error however it likes, and only a
	// client-side failure carries DefaultErrorCode. See isAuthRejection.
	return (
		error instanceof JSONRPCErrorException &&
		error.code === 0 &&
		error.message === RPC_TIMEOUT_MESSAGE
	);
}

// Where: server/agent/codex/codex.go's versionProbeTimeout (10s) and
// handshakeTimeout (30s), which run in series inside codex.Start.
const CODEX_START_BUDGET_MS = 10000 + 30000;

/**
 * Timeout for the RPCs that are given room to wait out an agent CLI start:
 * `chat.message` and `work.start`.
 *
 * Both reach `GetOrCreateProcess` -> `Agent.Start` on their own request path —
 * `chat.message` directly, `work.start` through the kickoff (or restart) message
 * it awaits before replying. Requests that only address a process already there
 * (permission, question, interrupt) keep RPC_TIMEOUT_MS.
 *
 * Why it must exceed CODEX_START_BUDGET_MS: the server ends a hung start with an
 * error naming the step that stalled ("codex did not answer the MCP handshake
 * within 30s"). Give up before that error is written and the user gets
 * "Request timed out" instead — every time, not occasionally, since the two
 * deadlines are fixed. The extra margin covers what those two constants don't:
 * spawning the process and building its pipes, the file writes a request makes
 * around that (`work.start` claims the work item and creates its session first),
 * a loaded disk, the round trip.
 *
 * Overshooting costs little: a dead socket rejects everything still pending at
 * once (see `onclose`) rather than leaving it to sit out the clock, so the extra
 * seconds are only ever spent on a server that is genuinely still working.
 */
const AGENT_START_RPC_TIMEOUT_MS = CODEX_START_BUDGET_MS + 20000;

interface RPCClients {
	base: JSONRPCClient;
	withTimeout: JSONRPCRequester<void>;
	/** For agent-starting requests only; see AGENT_START_RPC_TIMEOUT_MS. */
	withAgentStartTimeout: JSONRPCRequester<void>;
}

function createRPCClient(socket: WebSocket): RPCClients {
	const base = new JSONRPCClient((request) => {
		if (socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket is not connected"));
		}
		socket.send(JSON.stringify(request));
	});
	// Code 0 is json-rpc-2.0's DefaultErrorCode, the same one it uses for its own
	// timeouts; isAuthRejection reads that code as "the transport gave up", as
	// opposed to a genuine (negative) code meaning the server said no.
	const timedOut = (id: JSONRPCID) =>
		createJSONRPCErrorResponse(id, 0, RPC_TIMEOUT_MESSAGE);
	return {
		base,
		withTimeout: base.timeout(RPC_TIMEOUT_MS, timedOut),
		withAgentStartTimeout: base.timeout(AGENT_START_RPC_TIMEOUT_MS, timedOut),
	};
}

function stripNamespace(method: string): string {
	const dotIndex = method.indexOf(".");
	return dotIndex >= 0 ? method.slice(dotIndex + 1) : method;
}

function createIdBasedHandler(
	callbacks: Map<string, () => void>,
): (params: unknown) => boolean {
	return (params) => {
		const { id } = params as { id: string };
		callbacks.get(id)?.();
		return true;
	};
}

type WatchNotificationHandler = (params: unknown) => boolean;

const watchNotificationHandlers: Record<string, WatchNotificationHandler> = {
	"fs.changed": createIdBasedHandler(fsWatchCallbacks),
	"git.changed": createIdBasedHandler(gitWatchCallbacks),
	"git.diff.changed": (params) => {
		const diffParams = params as GitDiffChangedNotification;
		gitDiffWatchCallbacks.get(diffParams.id)?.(diffParams);
		return true;
	},
	"worktree.changed": createIdBasedHandler(worktreeWatchCallbacks),
	"worktree.deleted": (params) => {
		const { name } = params as { name: string };
		const wasCurrentWorktree = worktreeActions.getCurrent() === name;
		if (wasCurrentWorktree) {
			worktreeActions.setCurrent("");
		}
		worktreeDeletedListener?.(name, wasCurrentWorktree);
		return true;
	},
	"session.list.changed": (params) => {
		const changedParams = params as SessionListChangedNotification;
		sessionListWatchCallbacks.get(changedParams.id)?.(changedParams);
		return true;
	},
	"session.detail.changed": (params) => {
		const changedParams = params as SessionDetailChangedNotification;
		sessionDetailWatchCallbacks.get(changedParams.id)?.(changedParams);
		return true;
	},
	"settings.changed": (params) => {
		const changedParams = params as SettingsChangedNotification;
		settingsWatchCallbacks.get(changedParams.id)?.(changedParams);
		return true;
	},
	"work.list.changed": (params) => {
		const changedParams = params as WorkListChangedNotification;
		workListWatchCallbacks.get(changedParams.id)?.(changedParams);
		return true;
	},
	"work.detail.changed": (params) => {
		const changedParams = params as WorkDetailChangedNotification;
		workDetailWatchCallbacks.get(changedParams.id)?.(changedParams);
		return true;
	},
	"agent_role.list.changed": (params) => {
		const changedParams = params as AgentRoleListChangedNotification;
		agentRoleListWatchCallbacks.get(changedParams.id)?.(changedParams);
		return true;
	},
};

function handleNotification(method: string, params: unknown): void {
	// Try watch notification handlers first
	const handler = watchNotificationHandlers[method];
	if (handler?.(params)) {
		return;
	}

	// Handle chat.* events from ChatMessagesWatcher (subscription ID based routing)
	if (method.startsWith("chat.")) {
		const { id, ...rest } = params as { id: string };
		const eventType = stripNamespace(method);
		const notification = {
			type: eventType,
			...rest,
		} as ServerNotification;

		// Route by subscription ID (consistent with other watchers)
		chatMessagesCallbacks.get(id)?.(notification);
	}
}

/**
 * Opens a watch subscription, with no window in which a notification can be lost.
 *
 * The subscription id is the client's: the callback goes into `callbacks` before
 * the request is sent, so a change the server notifies the instant it registers
 * the subscription already has a receiver here. Letting the server name the
 * subscription is what left a gap — it registers before it reads the snapshot it
 * replies with, so a notification could arrive addressed to an id this side had
 * not learned yet, and routing dropped it with nothing left to say the snapshot
 * on screen had gone stale.
 *
 * Ordering between the reply and such a notification is not guaranteed (the
 * server writes them from different goroutines); handling that is
 * `useSubscription`'s job, which holds early notifications until the snapshot is
 * in.
 *
 * Rolling the callback back on failure also keeps a refused or timed-out
 * subscribe from leaving an entry behind that nothing will ever remove.
 */
async function openSubscription<TCallback>(
	method: string,
	params: Record<string, unknown>,
	callbacks: Map<string, TCallback>,
	callback: TCallback,
): Promise<{ id: string; result: unknown }> {
	const client = getClient();
	if (!client) {
		throw new Error("Not connected");
	}

	// A UUID, not a per-page counter: one watcher's id space is shared by every
	// client the server has, and it refuses an id already in use.
	const id = generateUUID();
	callbacks.set(id, callback);
	try {
		const result = await client.request(method, { ...params, id });
		return { id, result };
	} catch (err) {
		callbacks.delete(id);
		// A timeout is our own clock giving up, not an answer: the server may well
		// have registered the subscription, and one nobody is listening to lives
		// until the connection dies. Naming it ourselves is what makes it
		// cancellable — before, the id only came back in a reply that never came.
		// Only on a timeout: a subscribe refused because the id is already in use
		// was answered, and that id belongs to the subscription already holding it.
		if (isRPCTimeout(err)) {
			closeSubscription(unsubscribeMethodFor(method), id, callbacks);
		}
		throw err;
	}
}

/** `x.subscribe` -> `x.unsubscribe`; the pairing is the wire protocol's. */
function unsubscribeMethodFor(subscribeMethod: string): string {
	return subscribeMethod.replace(/\.subscribe$/, ".unsubscribe");
}

/**
 * Closes a watch subscription.
 *
 * The callback goes first, so that a hook which has moved on hears nothing more
 * even if the request is still in flight. A failed request is ignored: the
 * connection is the usual reason, and a connection that is gone took every
 * subscription on it along.
 */
async function closeSubscription<TCallback>(
	method: string,
	id: string,
	callbacks: Map<string, TCallback>,
): Promise<void> {
	callbacks.delete(id);
	const client = getClient();
	if (!client) return;
	try {
		await client.request(method, { id });
	} catch {
		// Ignore errors (connection might be closed)
	}
}

// Create namespace-specific actions
const agentActions = createAgentActions(getClient);
const agentRoleActions = createAgentRoleActions(getClient);
const chatActions = createChatActions(getClient, getAgentStartClient);
const commandActions = createCommandActions(getClient);
const sessionActions = createSessionActions(getClient);
const settingsActions = createSettingsActions(getClient);
const fileActions = createFileActions(getClient);
const gitActions = createGitActions(getClient);
const workActions = createWorkActions(getClient, getAgentStartClient);
const worktreeRpcActions = createWorktreeActions(getClient);

// Listener for worktree deleted notification
type WorktreeDeletedListener = (
	name: string,
	wasCurrentWorktree: boolean,
) => void;
let worktreeDeletedListener: WorktreeDeletedListener | null = null;

export function setWorktreeDeletedListener(
	listener: WorktreeDeletedListener | null,
) {
	worktreeDeletedListener = listener;
}

// Listener called when auth fails due to non-existent worktree
type WorktreeNotFoundListener = () => void;
let worktreeNotFoundListener: WorktreeNotFoundListener | null = null;

export function setWorktreeNotFoundListener(
	listener: WorktreeNotFoundListener | null,
) {
	worktreeNotFoundListener = listener;
}

export const useWSStore = create<WSState>((set, get) => ({
	status: "disconnected",
	reconnectAttempts: 0,
	projectTitle: "",
	workDir: "",
	maxUploadSize: 0,

	actions: {
		connect: (token: string) => {
			const currentStatus = get().status;
			// "error" now means only "no token to connect with", which genuinely
			// needs the user; a connection that keeps failing stays in
			// "reconnecting" and retries on its own.
			if (
				currentStatus === "connecting" ||
				currentStatus === "connected" ||
				currentStatus === "error"
			) {
				return;
			}

			if (!token) {
				set({ status: "error" });
				return;
			}

			// A retry is already armed while status is "reconnecting"; leaving it
			// there would open a second socket a moment from now and orphan this
			// one. Mirrors web-cluster's connectInternal.
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = undefined;
			}

			const isReconnecting = currentStatus === "reconnecting";
			currentToken = token;
			// Keep "reconnecting" status to preserve UI state during reconnection
			if (!isReconnecting) {
				set({ status: "connecting" });
			}

			const url = getWebSocketUrl();
			const socket = new WebSocket(url);

			socket.onopen = async () => {
				const clients = createRPCClient(socket);
				rpcClients = clients;

				try {
					const currentWorktree = worktreeActions.getCurrent();
					const result = (await clients.withTimeout.request("auth", {
						token,
						worktree: currentWorktree || undefined,
					} as AuthParams)) as AuthResult;

					if (result.version !== APP_VERSION) {
						console.info(
							`Version mismatch: client=${APP_VERSION}, server=${result.version}. Reloading...`,
						);
						window.location.reload();
						return;
					}

					document.title = `${result.title} | Pockode`;

					set({
						status: "connected",
						reconnectAttempts: 0,
						projectTitle: result.title,
						workDir: result.work_dir,
						maxUploadSize: result.max_upload_size,
					});
				} catch (error) {
					// Not a rejection: the request timed out or the socket died
					// mid-auth. Close (a no-op if it is already gone) and let onclose
					// run the normal reconnect path.
					if (!isAuthRejection(error)) {
						console.warn("WebSocket auth did not complete, retrying:", error);
						socket.close(1000, "auth_incomplete");
						return;
					}

					const currentWorktree = worktreeActions.getCurrent();
					// If auth failed with a specific worktree, reset to main and retry
					if (currentWorktree) {
						console.warn(
							"Auth failed with worktree, retrying with main:",
							currentWorktree,
						);
						worktreeActions.setCurrent("");
						worktreeNotFoundListener?.();
						socket.close(1000, "auth_retry");
						// Retry connection with main worktree
						setTimeout(() => get().actions.connect(token), 100);
						return;
					}
					console.error("WebSocket auth failed:", error);
					set({ status: "auth_failed" });
					socket.close(1000, "auth_failed");
				}
			};

			socket.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);

					// JSON-RPC 2.0 response (has id)
					if ("id" in data && data.id !== null) {
						rpcClients?.base.receive(data);
						return;
					}

					// JSON-RPC 2.0 notification (no id, has method)
					if ("method" in data) {
						handleNotification(data.method, data.params);
					}
				} catch (e) {
					console.warn("Failed to parse WebSocket message:", event.data, e);
				}
			};

			socket.onerror = () => {
				// Error is always followed by close, let onclose handle state
			};

			socket.onclose = () => {
				// A newer socket may already have replaced this one. Closing is not
				// instant — the handshake against a dead relay drags on for seconds —
				// and reconnectWebSocket() opens the replacement only 100ms after
				// asking for the close, so a superseded socket routinely outlives its
				// successor's setup. Without this guard it would then strip the live
				// connection of its RPC client and subscriptions and demote it to
				// "reconnecting", leaving a healthy socket that nothing can reach and
				// that disconnect() can no longer close.
				if (ws !== socket) {
					return;
				}

				ws = null;
				// Their answers can only have come down this socket, so waiting out
				// the RPC timeout would just be a slower way of failing.
				rpcClients?.base.rejectAllPendingRequests("Connection lost");
				rpcClients = null;
				clearAllWatchSubscriptions();

				const currentStatus = get().status;
				// Don't reconnect on auth failure or intentional disconnect
				if (
					currentStatus === "auth_failed" ||
					currentStatus === "disconnected"
				) {
					return;
				}

				// Without a token there is nothing to retry with; that needs the user.
				if (!currentToken) {
					set({ status: "error" });
					return;
				}

				// Use "reconnecting" to preserve UI state; "disconnected" is for intentional disconnect
				const attempts = get().reconnectAttempts;
				set({ status: "reconnecting", reconnectAttempts: attempts + 1 });
				reconnectTimeout = window.setTimeout(() => {
					if (currentToken) {
						get().actions.connect(currentToken);
					}
				}, reconnectDelay(attempts));
			};

			ws = socket;
		},

		disconnect: () => {
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = undefined;
			}
			currentToken = null;
			// Set status BEFORE closing so onclose sees "disconnected" and does
			// not treat an intentional close as a drop worth reconnecting.
			//
			// Auto-reconnect is already off: onclose bails on "disconnected" and
			// the pending timer checks currentToken. Reset the attempt count so a
			// later connect() starts at the short end of the backoff.
			set({ status: "disconnected", reconnectAttempts: 0 });
			if (ws) {
				ws.close(1000, "disconnect");
				ws = null;
				// onclose will ignore this socket for the same reason it ignores any
				// superseded one, so nothing else is going to settle these.
				rpcClients?.base.rejectAllPendingRequests("Connection lost");
				rpcClients = null;
				// onclose used to do this on its way past; it now ignores a socket
				// that is no longer the current one, and this one just stopped being
				// it. Doing it here also frees the callbacks immediately rather than
				// whenever the close handshake happens to finish.
				clearAllWatchSubscriptions();
			}
		},

		retryNow: () => {
			if (!currentToken) return;
			// connect() disarms the pending retry itself. The attempt counter is
			// deliberately left alone: an immediate retry that also fails should
			// resume the backoff where it was, not restart it, or a series of
			// recovery events could retry without limit.
			get().actions.connect(currentToken);
		},

		fsSubscribe: async (path: string, callback: () => void) => {
			const { id } = await openSubscription(
				"fs.subscribe",
				{ path },
				fsWatchCallbacks,
				callback,
			);
			return { id };
		},

		fsUnsubscribe: (id: string) =>
			closeSubscription("fs.unsubscribe", id, fsWatchCallbacks),

		gitSubscribe: async (callback: () => void) => {
			const { id } = await openSubscription(
				"git.subscribe",
				{},
				gitWatchCallbacks,
				callback,
			);
			return { id };
		},

		gitUnsubscribe: (id: string) =>
			closeSubscription("git.unsubscribe", id, gitWatchCallbacks),

		gitDiffSubscribe: async (
			path: string,
			staged: boolean,
			hideWhitespace: boolean,
			callback: (params: GitDiffChangedNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"git.diff.subscribe",
				{ path, staged, hide_whitespace: hideWhitespace },
				gitDiffWatchCallbacks,
				callback,
			);
			return { id, initial: result as GitDiffData };
		},

		gitDiffUnsubscribe: (id: string) =>
			closeSubscription("git.diff.unsubscribe", id, gitDiffWatchCallbacks),

		worktreeSubscribe: async (callback: () => void) => {
			const { id } = await openSubscription(
				"worktree.subscribe",
				{},
				worktreeWatchCallbacks,
				callback,
			);
			return { id };
		},

		worktreeUnsubscribe: (id: string) =>
			closeSubscription("worktree.unsubscribe", id, worktreeWatchCallbacks),

		sessionListSubscribe: async (
			callback: (params: SessionListChangedNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"session.list.subscribe",
				{},
				sessionListWatchCallbacks,
				callback,
			);
			return { id, initial: (result as SessionListSubscribeResult).sessions };
		},

		sessionListUnsubscribe: (id: string) =>
			closeSubscription(
				"session.list.unsubscribe",
				id,
				sessionListWatchCallbacks,
			),

		sessionDetailSubscribe: async (
			sessionId: string,
			callback: (params: SessionDetailChangedNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"session.detail.subscribe",
				{ session_id: sessionId },
				sessionDetailWatchCallbacks,
				callback,
			);
			return { id, initial: result as SessionDetailSubscribeResult };
		},

		sessionDetailUnsubscribe: (id: string) =>
			closeSubscription(
				"session.detail.unsubscribe",
				id,
				sessionDetailWatchCallbacks,
			),

		chatMessagesSubscribe: async (
			sessionId: string,
			callback: (notification: ServerNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"chat.messages.subscribe",
				{ session_id: sessionId },
				chatMessagesCallbacks,
				callback,
			);
			return { id, initial: result as ChatMessagesSubscribeResult };
		},

		chatMessagesHistory: async (sessionId: string, beforeSeq: HistorySeq) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			return (await client.request("chat.messages.history", {
				session_id: sessionId,
				before_seq: beforeSeq,
			} satisfies ChatMessagesHistoryParams)) as ChatMessagesHistoryResult;
		},

		chatMessagesUnsubscribe: (id: string) =>
			closeSubscription("chat.messages.unsubscribe", id, chatMessagesCallbacks),

		settingsSubscribe: async (
			callback: (params: SettingsChangedNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"settings.subscribe",
				{},
				settingsWatchCallbacks,
				callback,
			);
			return { id, initial: (result as SettingsSubscribeResult).settings };
		},

		settingsUnsubscribe: (id: string) =>
			closeSubscription("settings.unsubscribe", id, settingsWatchCallbacks),

		workListSubscribe: async (
			callback: (params: WorkListChangedNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"work.list.subscribe",
				{},
				workListWatchCallbacks,
				callback,
			);
			return { id, initial: (result as WorkListSubscribeResult).items };
		},

		workListUnsubscribe: (id: string) =>
			closeSubscription("work.list.unsubscribe", id, workListWatchCallbacks),

		workDetailSubscribe: async (
			workId: string,
			callback: (params: WorkDetailChangedNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"work.detail.subscribe",
				{ work_id: workId },
				workDetailWatchCallbacks,
				callback,
			);
			return { id, initial: result as WorkDetailSubscribeResult };
		},

		workDetailUnsubscribe: (id: string) =>
			closeSubscription(
				"work.detail.unsubscribe",
				id,
				workDetailWatchCallbacks,
			),

		agentRoleListSubscribe: async (
			callback: (params: AgentRoleListChangedNotification) => void,
		) => {
			const { id, result } = await openSubscription(
				"agent_role.list.subscribe",
				{},
				agentRoleListWatchCallbacks,
				callback,
			);
			return { id, initial: (result as AgentRoleListSubscribeResult).items };
		},

		agentRoleListUnsubscribe: (id: string) =>
			closeSubscription(
				"agent_role.list.unsubscribe",
				id,
				agentRoleListWatchCallbacks,
			),

		// Spread namespace-specific actions
		...agentActions,
		...agentRoleActions,
		...chatActions,
		...commandActions,
		...sessionActions,
		...settingsActions,
		...fileActions,
		...gitActions,
		...workActions,
		...worktreeRpcActions,
	},
}));

/**
 * Reconnect WebSocket with current token.
 * Used as a fallback when worktree.switch RPC fails.
 */
export function reconnectWebSocket(): void {
	if (!currentToken) return;
	const token = currentToken;
	wsActions.disconnect();
	// Small delay to ensure clean disconnect before reconnecting
	setTimeout(() => {
		useWSStore.getState().actions.connect(token);
	}, 100);
}

// Expose actions for non-React contexts (e.g., authStore logout)
export const wsActions = useWSStore.getState().actions;

listenForRecovery();

type SwitchResult = "success" | "not_connected" | "failed";

// Switch worktree on existing connection
async function switchWorktreeRPC(name: string): Promise<SwitchResult> {
	const client = getClient();
	if (!client) {
		return "not_connected";
	}

	try {
		const result = (await client.request("worktree.switch", {
			name,
		})) as { work_dir: string; worktree_name: string };

		useWSStore.setState({ workDir: result.work_dir });
		clearWorktreeWatchSubscriptions();
		onWorktreeSwitched?.();
		worktreeActions.notifyWorktreeSwitchEnd();
		return "success";
	} catch (error) {
		console.warn("Worktree switch RPC failed:", error);
		return "failed";
	}
}

// Handle worktree change: try RPC switch, fall back to reconnect if needed
worktreeActions.onWorktreeChange((_prev, next) => {
	void switchWorktreeRPC(next).then((result) => {
		if (result === "failed") {
			// RPC failed while connected - reconnect to recover
			reconnectWebSocket();
		}
		// "not_connected": auth will bind to correct worktree on connect
		// "success": done
	});
});

// Reset function for testing
export function resetWSStore() {
	if (ws) {
		ws.close(1000, "disconnect");
		ws = null;
	}
	rpcClients = null;
	currentToken = null;
	if (reconnectTimeout) {
		clearTimeout(reconnectTimeout);
		reconnectTimeout = undefined;
	}
	clearAllWatchSubscriptions();
	worktreeDeletedListener = null;
	onWorktreeSwitched = null;
	useWSStore.setState({
		status: "disconnected",
		reconnectAttempts: 0,
		projectTitle: "",
		workDir: "",
	});
}
