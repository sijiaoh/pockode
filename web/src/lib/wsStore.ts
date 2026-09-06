import { JSONRPCClient, type JSONRPCRequester } from "json-rpc-2.0";
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
	/** Skip the remaining backoff and attempt to reconnect immediately. */
	retryNow: () => void;
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
	/**
	 * Consecutive failed reconnects. The UI reads it to tell a blip apart from
	 * an outage: "reconnecting" alone looks identical after 1 second and after
	 * 10 minutes, and silently looking identical forever is the failure this
	 * store used to have.
	 */
	reconnectAttempts: number;
	projectTitle: string;
	workDir: string;
	actions: RPCActions;
}

// Module-level state for mutable objects (not reactive)
let ws: WebSocket | null = null;
let rpcReceiver: JSONRPCClient | null = null;
let rpcRequester: JSONRPCRequester<void> | null = null;
let currentToken: string | null = null;
let reconnectTimeout: number | undefined;
const fsWatchCallbacks = new Map<string, () => void>();
const gitWatchCallbacks = new Map<string, () => void>();
const gitDiffWatchCallbacks = new Map<
	string,
	(params: GitDiffChangedNotification) => void
>();
const worktreeWatchCallbacks = new Map<string, () => void>();
const sessionListWatchCallbacks = new Map<
	string,
	(params: SessionListChangedNotification) => void
>();
// Key: subscriptionId -> callback (unified with other watchers)
const chatMessagesCallbacks = new Map<
	string,
	(notification: ServerNotification) => void
>();
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
 * Clear all local watch subscriptions.
 * Called when switching worktrees or disconnecting.
 *
 * NOTE: When adding new watcher types, add cleanup here.
 * This mirrors server-side Worktree.UnsubscribeConnection().
 */
function clearWatchSubscriptions(): void {
	fsWatchCallbacks.clear();
	gitWatchCallbacks.clear();
	gitDiffWatchCallbacks.clear();
	sessionListWatchCallbacks.clear();
	chatMessagesCallbacks.clear();
	workListWatchCallbacks.clear();
	workDetailWatchCallbacks.clear();
	agentRoleListWatchCallbacks.clear();
	// Note: worktreeWatchCallbacks and settingsWatchCallbacks are NOT cleared here
	// because they are Manager-level, not worktree-specific.
}

// Callback to clear worktree-dependent caches (set by queryClient)
let onWorktreeSwitched: (() => void) | null = null;

export function setOnWorktreeSwitched(callback: (() => void) | null) {
	onWorktreeSwitched = callback;
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const RECONNECT_JITTER = 0.2;

/**
 * Milliseconds to wait before reconnect attempt `attempt`, counting from 0.
 *
 * There is no attempt limit. A phone that loses signal in a lift, or a laptop
 * whose lid was shut, must recover by itself when the network returns; giving
 * up after a fixed count left the app permanently dead after a blip that
 * outlasted the count. At the ceiling an idle client costs two attempts a
 * minute, which is cheap enough to keep doing indefinitely.
 *
 * Jitter matters because every client of a restarting server begins its backoff
 * at the same instant, and would otherwise retry in lockstep.
 */
function reconnectDelay(attempt: number): number {
	const base = Math.min(
		RECONNECT_BASE_DELAY_MS * 2 ** attempt,
		RECONNECT_MAX_DELAY_MS,
	);
	return Math.round(base * (1 + RECONNECT_JITTER * (2 * Math.random() - 1)));
}

function scheduleReconnect(): void {
	if (reconnectTimeout !== undefined) return;

	const attempts = useWSStore.getState().reconnectAttempts;
	const delay = reconnectDelay(attempts);
	// "reconnecting" rather than "disconnected", which means the user asked to
	// stop and must not be reconnected.
	useWSStore.setState({
		status: "reconnecting",
		reconnectAttempts: attempts + 1,
	});

	reconnectTimeout = window.setTimeout(() => {
		reconnectTimeout = undefined;
		// Only disconnect() clears the token, and it stops reconnection by way
		// of the "disconnected" status, so this is a type narrowing rather than
		// a case that happens.
		if (currentToken) {
			useWSStore.getState().actions.connect(currentToken);
		}
	}, delay);
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
	reconnectAttempts: 0,
	projectTitle: "",
	workDir: "",

	actions: {
		connect: (token: string) => {
			const currentStatus = get().status;
			// "error" is a terminal state requiring user intervention (page refresh)
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
						reconnectAttempts: 0,
						projectTitle: result.title,
						workDir: result.work_dir,
					});
				} catch (error) {
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
				ws = null;
				rpcReceiver = null;
				rpcRequester = null;
				clearWatchSubscriptions();

				const currentStatus = get().status;
				// Don't reconnect on auth failure or intentional disconnect
				if (
					currentStatus === "auth_failed" ||
					currentStatus === "disconnected"
				) {
					return;
				}

				scheduleReconnect();
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
			set({ status: "disconnected", reconnectAttempts: 0 });
			if (ws) {
				ws.close(1000, "disconnect");
				ws = null;
				rpcReceiver = null;
				rpcRequester = null;
			}
		},

		retryNow: () => {
			if (!currentToken) return;
			if (reconnectTimeout !== undefined) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = undefined;
			}
			// The attempt counter is deliberately left alone: an immediate retry
			// that also fails should resume the backoff where it was, not restart
			// it, or a series of recovery events could retry without limit.
			get().actions.connect(currentToken);
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

listenForRecovery();

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
		clearWatchSubscriptions();
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
		reconnectAttempts: 0,
		projectTitle: "",
		workDir: "",
	});
}
