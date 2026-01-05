import { JSONRPCClient } from "json-rpc-2.0";
import { create } from "zustand";
import type {
	AuthParams,
	ServerMethod,
	ServerNotification,
} from "../types/message";
import { getWebSocketUrl } from "../utils/config";
import {
	type ChatActions,
	createChatActions,
	createSessionActions,
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

type RPCActions = ConnectionActions & ChatActions & SessionActions;

interface WSState {
	status: ConnectionStatus;
	actions: RPCActions;
}

// Module-level state for mutable objects (not reactive)
let ws: WebSocket | null = null;
let rpcClient: JSONRPCClient | null = null;
let currentToken: string | null = null;
let reconnectAttempts = 0;
let reconnectTimeout: number | undefined;
const notificationListeners = new Set<NotificationListener>();

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 3000;

function getClient(): JSONRPCClient | null {
	return rpcClient;
}

function createRPCClient(socket: WebSocket): JSONRPCClient {
	return new JSONRPCClient((request) => {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(request));
		} else {
			return Promise.reject(new Error("WebSocket is not connected"));
		}
	});
}

function stripNamespace(method: string): string {
	const dotIndex = method.indexOf(".");
	return dotIndex >= 0 ? method.slice(dotIndex + 1) : method;
}

function handleNotification(method: string, params: unknown): void {
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
		!SILENT_EVENTS.has(eventType as ServerMethod)
	) {
		unreadActions.markUnread(sessionId);
	}

	for (const listener of notificationListeners) {
		listener(notification);
	}
}

// Create namespace-specific actions
const chatActions = createChatActions(getClient);
const sessionActions = createSessionActions(getClient);

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
				const client = createRPCClient(socket);
				rpcClient = client;

				try {
					await client.request("auth", { token } as AuthParams);
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
						rpcClient?.receive(data);
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
				rpcClient = null;

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
				rpcClient = null;
			}
		},

		subscribeNotification: (listener: NotificationListener) => {
			notificationListeners.add(listener);
			return () => {
				notificationListeners.delete(listener);
			};
		},

		// Spread namespace-specific actions
		...chatActions,
		...sessionActions,
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
	rpcClient = null;
	currentToken = null;
	if (reconnectTimeout) {
		clearTimeout(reconnectTimeout);
		reconnectTimeout = undefined;
	}
	reconnectAttempts = 0;
	notificationListeners.clear();
	useWSStore.setState({ status: "disconnected" });
}
