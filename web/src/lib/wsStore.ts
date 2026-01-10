import { JSONRPCClient, type JSONRPCRequester } from "json-rpc-2.0";
import { create } from "zustand";
import type {
	AuthParams,
	ServerMethod,
	ServerNotification,
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
	type FileActions,
	type GitActions,
	type SessionActions,
} from "./rpc";
import { unreadActions } from "./unreadStore";

// Events that should NOT trigger unread notifications.
// These are either streaming events (continuous output) or control messages.
// Any new event type not listed here will trigger unread by default (safe fallback).
const SILENT_EVENTS = new Set<ServerMethod>([
	"text",
	"tool_call",
	"tool_result",
	"system",
	"watch_changed", // Watch notifications don't trigger unread
]);

export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "auth_failed"
	| "error";

type NotificationListener = (notification: ServerNotification) => void;

interface ConnectionActions {
	connect: (token: string) => void;
	disconnect: () => void;
	subscribeNotification: (listener: NotificationListener) => () => void;
}

export interface WatchActions {
	watchSubscribe: (path: string, callback: () => void) => Promise<string>;
	watchUnsubscribe: (id: string) => Promise<void>;
}

type RPCActions = ConnectionActions &
	ChatActions &
	CommandActions &
	SessionActions &
	FileActions &
	GitActions &
	WatchActions;

interface WSState {
	status: ConnectionStatus;
	actions: RPCActions;
}

// Module-level state for mutable objects (not reactive)
let ws: WebSocket | null = null;
let rpcReceiver: JSONRPCClient | null = null;
let rpcRequester: JSONRPCRequester<void> | null = null;
let currentToken: string | null = null;
let reconnectAttempts = 0;
let reconnectTimeout: number | undefined;
const notificationListeners = new Set<NotificationListener>();
const watchCallbacks = new Map<string, () => void>();

// Callback to check if a session exists (set by useSession hook)
let sessionExistsChecker: ((sessionId: string) => boolean) | null = null;

export function setSessionExistsChecker(
	checker: ((sessionId: string) => boolean) | null,
) {
	sessionExistsChecker = checker;
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

function handleNotification(method: string, params: unknown): void {
	// Handle watch.changed notifications specially via callback
	if (method === "watch.changed") {
		const { id } = params as { id: string; data: unknown };
		const callback = watchCallbacks.get(id);
		callback?.();
		return;
	}

	const eventType = stripNamespace(method);
	const notification = {
		type: eventType,
		...(params as object),
	} as ServerNotification;

	// Mark session as unread if not currently viewing it
	const sessionId = notification.session_id;
	if (
		sessionId &&
		!unreadActions.isViewing(sessionId) &&
		!SILENT_EVENTS.has(eventType as ServerMethod) &&
		sessionExistsChecker?.(sessionId)
	) {
		unreadActions.markUnread(sessionId);
	}

	for (const listener of notificationListeners) {
		listener(notification);
	}
}

// Create namespace-specific actions
const chatActions = createChatActions(getClient);
const commandActions = createCommandActions(getClient);
const sessionActions = createSessionActions(getClient);
const fileActions = createFileActions(getClient);
const gitActions = createGitActions(getClient);

export const useWSStore = create<WSState>((set, get) => ({
	status: "disconnected",

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
					await rpcRequester.request("auth", { token } as AuthParams);
					set({ status: "connected" });
					reconnectAttempts = 0;
				} catch (error) {
					console.error("WebSocket auth failed:", error);
					set({ status: "auth_failed" });
					socket.close();
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
				watchCallbacks.clear();

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
				ws.close();
				ws = null;
				rpcReceiver = null;
				rpcRequester = null;
			}
		},

		subscribeNotification: (listener: NotificationListener) => {
			notificationListeners.add(listener);
			return () => {
				notificationListeners.delete(listener);
			};
		},

		watchSubscribe: async (
			path: string,
			callback: () => void,
		): Promise<string> => {
			const client = getClient();
			if (!client) {
				throw new Error("Not connected");
			}
			const result = (await client.request("watch.subscribe", { path })) as {
				id: string;
			};
			watchCallbacks.set(result.id, callback);
			return result.id;
		},

		watchUnsubscribe: async (id: string): Promise<void> => {
			watchCallbacks.delete(id);
			const client = getClient();
			if (client) {
				await client.request("watch.unsubscribe", { id }).catch(() => {
					// Ignore errors (connection might be closed)
				});
			}
		},

		// Spread namespace-specific actions
		...chatActions,
		...commandActions,
		...sessionActions,
		...fileActions,
		...gitActions,
	},
}));

// Expose actions for non-React contexts (e.g., authStore logout)
export const wsActions = useWSStore.getState().actions;

// Reset function for testing
export function resetWSStore() {
	if (ws) {
		ws.close();
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
	notificationListeners.clear();
	watchCallbacks.clear();
	sessionExistsChecker = null;
	useWSStore.setState({ status: "disconnected" });
}
