import type { WSClientMessage, WSServerMessage } from "../types/message";
import { getToken, getWebSocketUrl } from "../utils/config";

export type ConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "error";

type MessageListener = (message: WSServerMessage) => void;
type StatusListener = () => void;

interface WSStore {
	// State
	status: ConnectionStatus;
	ws: WebSocket | null;

	// Connection management
	connect: () => void;
	disconnect: () => void;
	send: (message: WSClientMessage) => void;

	// Subscriptions for useSyncExternalStore
	subscribeStatus: (listener: StatusListener) => () => void;
	getStatusSnapshot: () => ConnectionStatus;

	// Message subscriptions
	subscribeMessage: (listener: MessageListener) => () => void;
}

function createWSStore(): WSStore {
	let status: ConnectionStatus = "disconnected";
	let ws: WebSocket | null = null;
	let reconnectAttempts = 0;
	let reconnectTimeout: number | undefined;

	const maxReconnectAttempts = 5;
	const reconnectInterval = 3000;

	const statusListeners = new Set<StatusListener>();
	const messageListeners = new Set<MessageListener>();

	const notifyStatusListeners = () => {
		for (const listener of statusListeners) {
			listener();
		}
	};

	const notifyMessageListeners = (message: WSServerMessage) => {
		for (const listener of messageListeners) {
			listener(message);
		}
	};

	const setStatus = (newStatus: ConnectionStatus) => {
		if (status !== newStatus) {
			status = newStatus;
			notifyStatusListeners();
		}
	};

	const connect = () => {
		const token = getToken();
		if (!token) {
			setStatus("error");
			return;
		}

		// Close existing connection
		if (ws) {
			ws.close();
			ws = null;
		}

		setStatus("connecting");

		const url = `${getWebSocketUrl()}?token=${encodeURIComponent(token)}`;
		const socket = new WebSocket(url);

		socket.onopen = () => {
			setStatus("connected");
			reconnectAttempts = 0;
		};

		socket.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as WSServerMessage;
				notifyMessageListeners(data);
			} catch {
				// Ignore parse errors
			}
		};

		socket.onerror = () => {
			setStatus("error");
		};

		socket.onclose = () => {
			setStatus("disconnected");
			ws = null;

			// Auto reconnect
			if (reconnectAttempts < maxReconnectAttempts) {
				reconnectAttempts += 1;
				reconnectTimeout = window.setTimeout(() => {
					connect();
				}, reconnectInterval);
			}
		};

		ws = socket;
	};

	const disconnect = () => {
		if (reconnectTimeout) {
			clearTimeout(reconnectTimeout);
			reconnectTimeout = undefined;
		}
		reconnectAttempts = maxReconnectAttempts; // Prevent auto-reconnect
		if (ws) {
			ws.close();
			ws = null;
		}
		setStatus("disconnected");
	};

	const send = (message: WSClientMessage) => {
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(message));
		}
	};

	const subscribeStatus = (listener: StatusListener) => {
		statusListeners.add(listener);
		return () => {
			statusListeners.delete(listener);
		};
	};

	const getStatusSnapshot = () => status;

	const subscribeMessage = (listener: MessageListener) => {
		messageListeners.add(listener);
		return () => {
			messageListeners.delete(listener);
		};
	};

	return {
		get status() {
			return status;
		},
		get ws() {
			return ws;
		},
		connect,
		disconnect,
		send,
		subscribeStatus,
		getStatusSnapshot,
		subscribeMessage,
	};
}

// Singleton instance
export const wsStore = createWSStore();
