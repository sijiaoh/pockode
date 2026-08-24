import {
	JSONRPCClient,
	JSONRPCErrorException,
	type JSONRPCRequester,
} from "json-rpc-2.0";
import { create } from "zustand";
import type {
	AgentRole,
	AgentRoleListChangedNotification,
	AgentRoleListSubscribeResult,
} from "../types/agentRole";
import type {
	GitDiffChangedNotification,
	GitDiffSubscribeResult,
} from "../types/git";
import type {
	AuthParams,
	AuthResult,
	ChatMessagesSubscribeResult,
	ServerNotification,
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
import {
	type AgentRoleActions,
	type ChatActions,
	type CommandActions,
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
}

// TODO: Implement retry logic for watcher subscriptions.
// Currently callers must handle failures; retry only happens on WebSocket reconnect.

/** Base result for all watch subscriptions */
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
	) => Promise<WatchSubscribeResult<GitDiffSubscribeResult>>;
	gitDiffUnsubscribe: (id: string) => Promise<void>;
	worktreeSubscribe: (callback: () => void) => Promise<WatchSubscribeResult>;
	worktreeUnsubscribe: (id: string) => Promise<void>;
	sessionListSubscribe: (
		callback: (params: SessionListChangedNotification) => void,
	) => Promise<WatchSubscribeResult<SessionListItem[]>>;
	sessionListUnsubscribe: (id: string) => Promise<void>;
	chatMessagesSubscribe: (
		sessionId: string,
		callback: (notification: ServerNotification) => void,
	) => Promise<WatchSubscribeResult<ChatMessagesSubscribeResult>>;
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
	projectTitle: string;
	workDir: string;
	actions: RPCActions;
}

// Module-level state for mutable objects (not reactive)
let ws: WebSocket | null = null;
let rpcReceiver: JSONRPCClient | null = null;
let rpcRequester: JSONRPCRequester<void> | null = null;
let currentToken: string | null = null;
let reconnectAttempts = 0;
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

// A relay tunnel can be down for ~20s before the server even notices (its
// keepalive detection window), and the server then reconnects with its own
// backoff. A client that gives up after a fixed handful of attempts is
// therefore guaranteed to be gone before the tunnel is back, leaving a dead
// page that only a manual refresh recovers. So retry indefinitely and back off
// instead: a long outage costs one attempt per RECONNECT_MAX_DELAY_MS rather
// than a hot loop, and a brief blip still recovers within a second.
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

function reconnectDelay(attempt: number): number {
	return Math.min(
		RECONNECT_BASE_DELAY_MS * 2 ** attempt,
		RECONNECT_MAX_DELAY_MS,
	);
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
	return rpcRequester;
}

const RPC_TIMEOUT_MS = 30000;

interface RPCClients {
	base: JSONRPCClient;
	withTimeout: JSONRPCRequester<void>;
}

function createRPCClient(socket: WebSocket): RPCClients {
	const base = new JSONRPCClient((request) => {
		if (socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket is not connected"));
		}
		socket.send(JSON.stringify(request));
	});
	return { base, withTimeout: base.timeout(RPC_TIMEOUT_MS) };
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

// Create namespace-specific actions
const agentRoleActions = createAgentRoleActions(getClient);
const chatActions = createChatActions(getClient);
const commandActions = createCommandActions(getClient);
const sessionActions = createSessionActions(getClient);
const settingsActions = createSettingsActions(getClient);
const fileActions = createFileActions(getClient);
const gitActions = createGitActions(getClient);
const workActions = createWorkActions(getClient);
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
	projectTitle: "",
	workDir: "",

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
				rpcReceiver = clients.base;
				rpcRequester = clients.withTimeout;

				try {
					const currentWorktree = worktreeActions.getCurrent();
					const result = (await rpcRequester.request("auth", {
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
						projectTitle: result.title,
						workDir: result.work_dir,
					});
					reconnectAttempts = 0;
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
						rpcReceiver?.receive(data);
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
				rpcReceiver = null;
				rpcRequester = null;
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
				set({ status: "reconnecting" });
				const delay = reconnectDelay(reconnectAttempts);
				reconnectAttempts += 1;
				reconnectTimeout = window.setTimeout(() => {
					if (currentToken) {
						get().actions.connect(currentToken);
					}
				}, delay);
			};

			ws = socket;
		},

		disconnect: () => {
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = undefined;
			}
			currentToken = null;
			// Auto-reconnect is already off: onclose bails on "disconnected" and the
			// pending timer checks currentToken. Reset so a later connect() starts
			// at the short end of the backoff.
			reconnectAttempts = 0;
			// Set status BEFORE closing so onclose sees correct state
			set({ status: "disconnected" });
			if (ws) {
				ws.close(1000, "disconnect");
				ws = null;
				rpcReceiver = null;
				rpcRequester = null;
				// onclose used to do this on its way past; it now ignores a socket
				// that is no longer the current one, and this one just stopped being
				// it. Doing it here also frees the callbacks immediately rather than
				// whenever the close handshake happens to finish.
				clearAllWatchSubscriptions();
			}
		},

		fsSubscribe: async (path: string, callback: () => void) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("fs.subscribe", { path })) as {
				id: string;
			};
			fsWatchCallbacks.set(result.id, callback);
			return { id: result.id };
		},

		fsUnsubscribe: async (id: string) => {
			fsWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("fs.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		gitSubscribe: async (callback: () => void) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("git.subscribe", {})) as {
				id: string;
			};
			gitWatchCallbacks.set(result.id, callback);
			return { id: result.id };
		},

		gitUnsubscribe: async (id: string) => {
			gitWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("git.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		gitDiffSubscribe: async (
			path: string,
			staged: boolean,
			hideWhitespace: boolean,
			callback: (params: GitDiffChangedNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("git.diff.subscribe", {
				path,
				staged,
				hide_whitespace: hideWhitespace,
			})) as GitDiffSubscribeResult;
			gitDiffWatchCallbacks.set(result.id, callback);
			return { id: result.id, initial: result };
		},

		gitDiffUnsubscribe: async (id: string) => {
			gitDiffWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("git.diff.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		worktreeSubscribe: async (callback: () => void) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("worktree.subscribe", {})) as {
				id: string;
			};
			worktreeWatchCallbacks.set(result.id, callback);
			return { id: result.id };
		},

		worktreeUnsubscribe: async (id: string) => {
			worktreeWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("worktree.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		sessionListSubscribe: async (
			callback: (params: SessionListChangedNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request(
				"session.list.subscribe",
				{},
			)) as SessionListSubscribeResult;
			sessionListWatchCallbacks.set(result.id, callback);
			return { id: result.id, initial: result.sessions };
		},

		sessionListUnsubscribe: async (id: string) => {
			sessionListWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("session.list.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		chatMessagesSubscribe: async (
			sessionId: string,
			callback: (notification: ServerNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("chat.messages.subscribe", {
				session_id: sessionId,
			})) as ChatMessagesSubscribeResult;
			chatMessagesCallbacks.set(result.id, callback);
			return { id: result.id, initial: result };
		},

		chatMessagesUnsubscribe: async (id: string) => {
			chatMessagesCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("chat.messages.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		settingsSubscribe: async (
			callback: (params: SettingsChangedNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request(
				"settings.subscribe",
				{},
			)) as SettingsSubscribeResult;
			settingsWatchCallbacks.set(result.id, callback);
			return { id: result.id, initial: result.settings };
		},

		settingsUnsubscribe: async (id: string) => {
			settingsWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("settings.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		workListSubscribe: async (
			callback: (params: WorkListChangedNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request(
				"work.list.subscribe",
				{},
			)) as WorkListSubscribeResult;
			workListWatchCallbacks.set(result.id, callback);
			return { id: result.id, initial: result.items };
		},

		workListUnsubscribe: async (id: string) => {
			workListWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("work.list.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		workDetailSubscribe: async (
			workId: string,
			callback: (params: WorkDetailChangedNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("work.detail.subscribe", {
				work_id: workId,
			})) as WorkDetailSubscribeResult;
			workDetailWatchCallbacks.set(result.id, callback);
			return { id: result.id, initial: result };
		},

		workDetailUnsubscribe: async (id: string) => {
			workDetailWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("work.detail.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		agentRoleListSubscribe: async (
			callback: (params: AgentRoleListChangedNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request(
				"agent_role.list.subscribe",
				{},
			)) as AgentRoleListSubscribeResult;
			agentRoleListWatchCallbacks.set(result.id, callback);
			return { id: result.id, initial: result.items };
		},

		agentRoleListUnsubscribe: async (id: string) => {
			agentRoleListWatchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				try {
					await client.request("agent_role.list.unsubscribe", { id });
				} catch {
					// Ignore errors (connection might be closed)
				}
			}
		},

		// Spread namespace-specific actions
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

type SwitchResult = "success" | "not_connected" | "failed";

// Switch worktree on existing connection
async function switchWorktreeRPC(name: string): Promise<SwitchResult> {
	if (!rpcRequester) {
		return "not_connected";
	}

	try {
		const result = (await rpcRequester.request("worktree.switch", {
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
	rpcReceiver = null;
	rpcRequester = null;
	currentToken = null;
	if (reconnectTimeout) {
		clearTimeout(reconnectTimeout);
		reconnectTimeout = undefined;
	}
	reconnectAttempts = 0;
	fsWatchCallbacks.clear();
	gitWatchCallbacks.clear();
	gitDiffWatchCallbacks.clear();
	worktreeWatchCallbacks.clear();
	sessionListWatchCallbacks.clear();
	chatMessagesCallbacks.clear();
	settingsWatchCallbacks.clear();
	workListWatchCallbacks.clear();
	workDetailWatchCallbacks.clear();
	agentRoleListWatchCallbacks.clear();
	worktreeDeletedListener = null;
	onWorktreeSwitched = null;
	useWSStore.setState({
		status: "disconnected",
		projectTitle: "",
		workDir: "",
	});
}
