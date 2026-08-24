import { getWebSocketUrl } from "@pockode/shared";
import { JSONRPCClient, JSONRPCErrorException } from "json-rpc-2.0";
import { create } from "zustand";
import { createNodeActions, type NodeActions } from "./rpc";

const RPC_TIMEOUT_MS = 30000;

// A relay tunnel can be down for ~20s before the server even notices, and the
// server then reconnects with its own backoff. Giving up after a fixed handful
// of quick attempts would always land on the error screen before the tunnel is
// back, so retry indefinitely and back off instead. Mirrors the web client.
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
 * "auth_failed" is a dead end for reconnects, so reading a timeout as bad
 * credentials would strand the user whenever the tunnel is slow or down.
 */
function isAuthRejection(error: unknown): boolean {
	return error instanceof JSONRPCErrorException && error.code !== 0;
}

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
		// Without a token there is nothing to retry with; that needs the user.
		if (!internal.token) {
			set({
				status: "error",
				errorMessage: "No token to reconnect with",
			});
			return;
		}

		const delay = reconnectDelay(internal.reconnectAttempts);
		internal.reconnectAttempts++;
		set({ status: "reconnecting" });

		internal.reconnectTimeout = setTimeout(() => {
			if (internal.token) {
				connectInternal(internal.token);
			}
		}, delay);
	};

	const connectInternal = (token: string) => {
		clearReconnectTimeout();

		// A previous socket may still be opening — the unreachable screen's Retry
		// button is on screen throughout a reconnect, and against a blackholed
		// network a browser takes tens of seconds to give up on the attempt in
		// flight. Left attached, that socket is orphaned but still live: its
		// eventual close would null out the newer connection's state and schedule
		// a reconnect on top of it.
		if (internal.socket) {
			const stale = internal.socket;
			internal.socket = null;
			stale.onopen = null;
			stale.onclose = null;
			stale.onmessage = null;
			stale.onerror = null;
			stale.close();
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
				// Not a rejection: the request timed out or the socket died mid-auth.
				// Close (a no-op if it is already gone) and let onclose run the normal
				// reconnect path instead of showing a dead-end token screen.
				if (!isAuthRejection(err)) {
					console.warn("Auth did not complete, retrying:", err);
					socket.close();
					return;
				}

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
			// A newer socket may already have replaced this one. disconnect() drops
			// its reference before the close handshake finishes, and against a dead
			// cluster that handshake takes seconds, so a stale close can easily land
			// after the replacement is already up. Clearing the shared state here
			// would strip that live connection of its RPC client and schedule a
			// reconnect on top of it.
			if (internal.socket !== socket) {
				return;
			}

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
				// stale "disconnected" status) opens a second socket and orphans the
				// first, leaking a live connection and flashing the UI. Mirrors the
				// web client. "error" is left retryable on purpose (the error screen's
				// Retry button calls this).
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
				// Auto-reconnect is already off: token is cleared and onclose bails on
				// "disconnected". Reset so a later connect() starts at the short end of
				// the backoff. Mirrors the web client.
				internal.reconnectAttempts = 0;
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
