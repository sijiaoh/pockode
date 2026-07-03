import { getWebSocketUrl } from "@pockode/shared";
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

		// During an automatic reconnect keep the "reconnecting" status: flipping
		// to "connecting" would show the full-screen spinner and remount NodeList,
		// flashing its loading state even though nothing changed.
		if (get().status !== "reconnecting") {
			set({ status: "connecting", errorMessage: null });
		}
		internal.token = token;

		const socket = new WebSocket(getWebSocketUrl());
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

		socket.onclose = () => {
			internal.client = null;
			internal.socket = null;

			const currentStatus = get().status;

			// Don't reconnect if auth failed or manually disconnected
			if (currentStatus === "auth_failed" || currentStatus === "disconnected") {
				return;
			}

			// Treat every unexpected close as a reconnect so the last-known UI stays
			// mounted. "disconnected" would trigger App's auto-reconnect via
			// connect() (flashing the spinner) and is reserved for intentional
			// disconnect(), mirroring the web client.
			scheduleReconnect();
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
				// A socket is already active or being established; don't open a
				// second one. Without this guard a re-entrant connect (e.g. React
				// StrictMode double-invoking App's connect effect, which captures a
				// stale "disconnected" status) opens a duplicate socket. Closing the
				// first then makes its onclose schedule a phantom reconnect, flashing
				// the UI a few seconds later. Mirrors the web client. "error" is left
				// retryable on purpose (the error screen's Retry button calls this).
				const status = get().status;
				if (status === "connecting" || status === "connected") {
					return;
				}
				internal.reconnectAttempts = 0;
				connectInternal(token);
			},
			disconnect: () => {
				clearReconnectTimeout();
				internal.token = null;
				// Prevent onclose from auto-reconnecting, mirroring the web client.
				internal.reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
				// Set status BEFORE closing so onclose sees "disconnected" and skips
				// scheduleReconnect(); otherwise closing a connected socket would flip
				// through "reconnecting" and leave a stray no-op timer.
				set({ status: "disconnected", version: null, errorMessage: null });
				if (internal.socket) {
					internal.socket.close();
					internal.socket = null;
				}
				internal.client = null;
			},
		},
	};
});
