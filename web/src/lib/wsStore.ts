import { JSONRPCClient, type JSONRPCRequester } from "json-rpc-2.0";
import { create } from "zustand";
import type {
	GitDiffChangedNotification,
	GitDiffSubscribeResult,
} from "../types/git";
import type {
	AuthParams,
	AuthResult,
	ChatMessagesSubscribeResult,
	ServerMethod,
	ServerNotification,
	SessionListChangedNotification,
	SessionListSubscribeResult,
	SessionMeta,
} from "../types/message";
import { getWebSocketUrl } from "../utils/config";
import {
	type ChatActions,
	type CommandActions,
	createChatActions,
	createCommandActions,
	createFileActions,
	createGitActions,
	createSessionActions,
	createWorktreeActions,
	type FileActions,
	type GitActions,
	type SessionActions,
	type WorktreeActions,
} from "./rpc";
import { unreadActions } from "./unreadStore";
import { APP_VERSION } from "./version";
import { worktreeActions } from "./worktreeStore";

// Events that should NOT trigger unread notifications.
// These are either streaming events (continuous output) or control messages.
// Any new event type not listed here will trigger unread by default (safe fallback).
const SILENT_EVENTS = new Set<ServerMethod>([
	"text",
	"tool_call",
	"tool_result",
	"system",
]);

export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
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
		callback: (params: GitDiffChangedNotification) => void,
	) => Promise<WatchSubscribeResult<GitDiffSubscribeResult>>;
	gitDiffUnsubscribe: (id: string) => Promise<void>;
	worktreeSubscribe: (callback: () => void) => Promise<WatchSubscribeResult>;
	worktreeUnsubscribe: (id: string) => Promise<void>;
	sessionListSubscribe: (
		callback: (params: SessionListChangedNotification) => void,
	) => Promise<WatchSubscribeResult<SessionMeta[]>>;
	sessionListUnsubscribe: (id: string) => Promise<void>;
	chatMessagesSubscribe: (
		sessionId: string,
		callback: (notification: ServerNotification) => void,
	) => Promise<WatchSubscribeResult<ChatMessagesSubscribeResult>>;
	chatMessagesUnsubscribe: (id: string) => Promise<void>;
}

type RPCActions = ConnectionActions &
	ChatActions &
	CommandActions &
	SessionActions &
	FileActions &
	GitActions &
	WatchActions &
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
	// Note: worktreeWatchCallbacks is NOT cleared here because it's Manager-level,
	// not worktree-specific. It persists across worktree switches.
}

// Callback to check if a session exists (set by useSession hook)
let sessionExistsChecker: ((sessionId: string) => boolean) | null = null;

export function setSessionExistsChecker(
	checker: ((sessionId: string) => boolean) | null,
) {
	sessionExistsChecker = checker;
}

// Callback to clear worktree-dependent caches (set by queryClient)
let onWorktreeSwitched: (() => void) | null = null;

export function setOnWorktreeSwitched(callback: (() => void) | null) {
	onWorktreeSwitched = callback;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 3000;

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
};

function handleNotification(method: string, params: unknown): void {
	// Try watch notification handlers first
	const handler = watchNotificationHandlers[method];
	if (handler?.(params)) {
		return;
	}

	// Handle chat.* events from ChatMessagesWatcher (subscription ID based routing)
	if (method.startsWith("chat.")) {
		const { id, ...rest } = params as { id: string; session_id: string };
		const eventType = stripNamespace(method);
		const notification = {
			type: eventType,
			...rest,
		} as ServerNotification;

		const sessionId = notification.session_id;
		if (sessionId) {
			// Mark as unread if not viewing
			if (
				!unreadActions.isViewing(sessionId) &&
				!SILENT_EVENTS.has(eventType as ServerMethod) &&
				sessionExistsChecker?.(sessionId)
			) {
				unreadActions.markUnread(sessionId);
			}
		}

		// Route by subscription ID (consistent with other watchers)
		chatMessagesCallbacks.get(id)?.(notification);
	}
}

// Create namespace-specific actions
const chatActions = createChatActions(getClient);
const commandActions = createCommandActions(getClient);
const sessionActions = createSessionActions(getClient);
const fileActions = createFileActions(getClient);
const gitActions = createGitActions(getClient);
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

export const useWSStore = create<WSState>((set, get) => ({
	status: "disconnected",
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

			currentToken = token;
			set({ status: "connecting" });

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
					const currentWorktree = worktreeActions.getCurrent();
					// If auth failed with a specific worktree, reset to main and retry
					if (currentWorktree) {
						console.warn(
							"Auth failed with worktree, retrying with main:",
							currentWorktree,
						);
						worktreeActions.setCurrent("");
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

				// Retry if we have attempts left and a token
				if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && currentToken) {
					set({ status: "disconnected" });
					reconnectAttempts += 1;
					reconnectTimeout = window.setTimeout(() => {
						if (currentToken) {
							get().actions.connect(currentToken);
						}
					}, RECONNECT_INTERVAL);
				} else {
					set({ status: "error" });
				}
			};

			ws = socket;
		},

		disconnect: () => {
			if (reconnectTimeout) {
				clearTimeout(reconnectTimeout);
				reconnectTimeout = undefined;
			}
			currentToken = null;
			reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
			// Set status BEFORE closing so onclose sees correct state
			set({ status: "disconnected" });
			if (ws) {
				ws.close(1000, "disconnect");
				ws = null;
				rpcReceiver = null;
				rpcRequester = null;
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
			callback: (params: GitDiffChangedNotification) => void,
		) => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("git.diff.subscribe", {
				path,
				staged,
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

		// Spread namespace-specific actions
		...chatActions,
		...commandActions,
		...sessionActions,
		...fileActions,
		...gitActions,
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
	reconnectAttempts = 0;
	fsWatchCallbacks.clear();
	gitWatchCallbacks.clear();
	gitDiffWatchCallbacks.clear();
	worktreeWatchCallbacks.clear();
	sessionListWatchCallbacks.clear();
	chatMessagesCallbacks.clear();
	sessionExistsChecker = null;
	worktreeDeletedListener = null;
	onWorktreeSwitched = null;
	useWSStore.setState({
		status: "disconnected",
		projectTitle: "",
		workDir: "",
	});
}
