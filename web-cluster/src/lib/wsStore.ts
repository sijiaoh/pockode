import { JSONRPCClient } from "json-rpc-2.0";
import { create } from "zustand";
import { createNodeActions, type NodeActions } from "./rpc";

const RPC_TIMEOUT_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL_MS = 3000;

type ConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "reconnecting"
	| "auth_failed"
	| "error";

interface AuthResult {
	version: string;
}

interface RPCActions extends NodeActions {
	connect: (token: string) => void;
	disconnect: () => void;
}

interface WSState {
	status: ConnectionStatus;
	version: string | null;
	errorMessage: string | null;
	actions: RPCActions;
}

interface InternalState {
	socket: WebSocket | null;
	client: JSONRPCClient | null;
	token: string | null;
	reconnectAttempts: number;
	reconnectTimeout: ReturnType<typeof setTimeout> | null;
}

const internal: InternalState = {
	socket: null,
	client: null,
	token: null,
	reconnectAttempts: 0,
	reconnectTimeout: null,
};

function getWSUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/ws`;
}

function createRPCClient(socket: WebSocket): JSONRPCClient {
	const client = new JSONRPCClient((request) => {
		if (socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("WebSocket is not connected"));
		}
		socket.send(JSON.stringify(request));
	});
	return client;
}

export const useWSStore = create<WSState>()((set, get) => {
	const getClient = (): JSONRPCClient | null => internal.client;

	const nodeActions = createNodeActions(getClient);

	const clearReconnectTimeout = () => {
		if (internal.reconnectTimeout) {
			clearTimeout(internal.reconnectTimeout);
			internal.reconnectTimeout = null;
		}
	};

	const scheduleReconnect = () => {
		if (internal.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			set({
				status: "error",
				errorMessage: "Connection failed after multiple attempts",
			});
			return;
		}

		internal.reconnectAttempts++;
		set({ status: "reconnecting" });

		internal.reconnectTimeout = setTimeout(() => {
			if (internal.token) {
				connectInternal(internal.token);
			}
		}, RECONNECT_INTERVAL_MS);
	};

	const connectInternal = (token: string) => {
		clearReconnectTimeout();

		if (internal.socket) {
			internal.socket.close();
		}

		set({ status: "connecting", errorMessage: null });
		internal.token = token;

		const socket = new WebSocket(getWSUrl());
		internal.socket = socket;

		socket.onopen = async () => {
			const client = createRPCClient(socket);
			internal.client = client;

			try {
				const result: AuthResult = await client
					.timeout(RPC_TIMEOUT_MS)
					.request("auth", { token });

				internal.reconnectAttempts = 0;
				set({
					status: "connected",
					version: result.version,
					errorMessage: null,
				});
			} catch (err) {
				internal.socket?.close();
				set({
					status: "auth_failed",
					errorMessage:
						err instanceof Error ? err.message : "Authentication failed",
				});
			}
		};

		socket.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				// Route responses to pending requests
				if ("id" in data && data.id !== null) {
					internal.client?.receive(data);
				}
			} catch {
				// Ignore parse errors
			}
		};

		socket.onclose = (event) => {
			internal.client = null;
			internal.socket = null;

			const currentStatus = get().status;

			// Don't reconnect if auth failed or manually disconnected
			if (currentStatus === "auth_failed" || currentStatus === "disconnected") {
				return;
			}

			// Handle abnormal close - try to reconnect
			if (!event.wasClean) {
				scheduleReconnect();
				return;
			}

			// Clean close from server side - set disconnected
			set({ status: "disconnected" });
		};

		socket.onerror = () => {
			// Error handling is done in onclose
		};
	};

	return {
		status: "disconnected",
		version: null,
		errorMessage: null,
		actions: {
			...nodeActions,
			connect: (token: string) => {
				internal.reconnectAttempts = 0;
				connectInternal(token);
			},
			disconnect: () => {
				clearReconnectTimeout();
				internal.token = null;
				internal.reconnectAttempts = 0;
				if (internal.socket) {
					internal.socket.close();
					internal.socket = null;
				}
				internal.client = null;
				set({ status: "disconnected", version: null, errorMessage: null });
			},
		},
	};
});
