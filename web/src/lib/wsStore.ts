import { JSONRPCClient } from "json-rpc-2.0";
import { create } from "zustand";
import type {
	AttachParams,
	AttachResult,
	AuthParams,
	InterruptParams,
	MessageParams,
	PermissionResponseParams,
	QuestionResponseParams,
	ServerMethod,
	ServerNotification,
} from "../types/message";
import { getWebSocketUrl } from "../utils/config";
import { authActions } from "./authStore";
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
	| "error";

type NotificationListener = (notification: ServerNotification) => void;

interface RPCActions {
	connect: () => void;
	disconnect: () => void;
	attach: (sessionId: string) => Promise<AttachResult>;
	sendMessage: (sessionId: string, content: string) => Promise<void>;
	interrupt: (sessionId: string) => Promise<void>;
	permissionResponse: (params: PermissionResponseParams) => Promise<void>;
	questionResponse: (params: QuestionResponseParams) => Promise<void>;
	subscribeNotification: (listener: NotificationListener) => () => void;
}

interface WSState {
	status: ConnectionStatus;
	actions: RPCActions;
}

// Module-level state for mutable objects (not reactive)
let ws: WebSocket | null = null;
let rpcClient: JSONRPCClient | null = null;
let reconnectAttempts = 0;
let reconnectTimeout: number | undefined;
let authFailed = false;
const notificationListeners = new Set<NotificationListener>();

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 3000;

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

export const useWSStore = create<WSState>((set, get) => ({
	status: "disconnected",

	actions: {
		connect: () => {
			const token = authActions.getToken();
			if (!token) {
				set({ status: "error" });
				return;
			}

			// Close existing connection
			if (ws) {
				ws.close();
				ws = null;
				rpcClient = null;
			}

			set({ status: "connecting" });
			authFailed = false;

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
					authFailed = true;
					set({ status: "error" });
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
				set({ status: "error" });
			};

			socket.onclose = () => {
				ws = null;
				rpcClient = null;

				if (authFailed) {
					return;
				}

				if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
					set({ status: "disconnected" });
					reconnectAttempts += 1;
					reconnectTimeout = window.setTimeout(() => {
						get().actions.connect();
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
			reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
			if (ws) {
				ws.close();
				ws = null;
				rpcClient = null;
			}
			set({ status: "disconnected" });
		},

		attach: async (sessionId: string): Promise<AttachResult> => {
			if (!rpcClient) {
				throw new Error("Not connected");
			}
			return rpcClient.request("chat.attach", {
				session_id: sessionId,
			} as AttachParams);
		},

		sendMessage: async (sessionId: string, content: string): Promise<void> => {
			if (!rpcClient) {
				throw new Error("Not connected");
			}
			await rpcClient.request("chat.message", {
				session_id: sessionId,
				content,
			} as MessageParams);
		},

		interrupt: async (sessionId: string): Promise<void> => {
			if (!rpcClient) {
				throw new Error("Not connected");
			}
			await rpcClient.request("chat.interrupt", {
				session_id: sessionId,
			} as InterruptParams);
		},

		permissionResponse: async (
			params: PermissionResponseParams,
		): Promise<void> => {
			if (!rpcClient) {
				throw new Error("Not connected");
			}
			await rpcClient.request("chat.permission_response", params);
		},

		questionResponse: async (params: QuestionResponseParams): Promise<void> => {
			if (!rpcClient) {
				throw new Error("Not connected");
			}
			await rpcClient.request("chat.question_response", params);
		},

		subscribeNotification: (listener: NotificationListener) => {
			notificationListeners.add(listener);
			return () => {
				notificationListeners.delete(listener);
			};
		},
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
	if (reconnectTimeout) {
		clearTimeout(reconnectTimeout);
		reconnectTimeout = undefined;
	}
	reconnectAttempts = 0;
	authFailed = false;
	notificationListeners.clear();
	useWSStore.setState({ status: "disconnected" });
}
