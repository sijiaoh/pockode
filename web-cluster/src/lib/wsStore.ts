import {
	type AuthCredential,
	authFailureReason,
	credentialParams,
	getWebSocketUrl,
} from "@pockode/shared";
import { JSONRPCClient, JSONRPCErrorException } from "json-rpc-2.0";
import { create } from "zustand";
import { authActions } from "./authStore";
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
	/** What takes the password's place for the rest of the session. */
	session_token: string;
}

interface RPCActions extends NodeActions {
	connect: (credential: AuthCredential) => void;
	disconnect: () => void;
	retryNow: () => void;
}

interface WSState {
	status: ConnectionStatus;
	version: string | null;
	errorMessage: string | null;
	/**
	 * Attempts since the last connection that succeeded.
	 *
	 * In the store rather than beside the socket in `internal` because the
	 * reconnect banner escalates on it, and only state a component can subscribe
	 * to can drive that.
	 */
	reconnectAttempts: number;
	/**
	 * Why the password screen is asking again, when the answer is something
	 * other than "you just loaded the page".
	 *
	 * Nothing is persisted, so an ordinary reload arriving at the password
	 * screen is the product working and gets no explanation at all. Being turned
	 * away mid-session is a real event, though, and without a word it would look
	 * exactly like an ordinary reload — the user would conclude their last login
	 * never took. Live UI state, hence the store rather than anything durable:
	 * it is true only until the next attempt.
	 */
	reauthReason: "session_expired" | null;
	actions: RPCActions;
}

interface InternalState {
	socket: WebSocket | null;
	client: JSONRPCClient | null;
	credential: AuthCredential | null;
	reconnectTimeout: ReturnType<typeof setTimeout> | null;
}

const internal: InternalState = {
	socket: null,
	client: null,
	credential: null,
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
		// Without a credential there is nothing to retry with; that needs the user.
		if (!internal.credential) {
			set({
				status: "error",
				errorMessage: "No credential to reconnect with",
			});
			return;
		}

		const attempts = get().reconnectAttempts;
		set({ status: "reconnecting", reconnectAttempts: attempts + 1 });
		const delay = reconnectDelay(attempts);

		internal.reconnectTimeout = setTimeout(() => {
			if (internal.credential) {
				connectInternal(internal.credential);
			}
		}, delay);
	};

	const connectInternal = (credential: AuthCredential) => {
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
		internal.credential = credential;

		const socket = new WebSocket(getWebSocketUrl());
		internal.socket = socket;

		socket.onopen = async () => {
			const client = createRPCClient(socket);
			internal.client = client;

			try {
				const result: AuthResult = await client
					.timeout(RPC_TIMEOUT_MS)
					.request("auth", credentialParams(credential));

				// The password — if that is what got us in — has done its job and is
				// replaced by the token the server issued, so a reconnect never needs
				// it again. A server too old to issue one leaves the credential as it
				// was.
				if (result.session_token) {
					internal.credential = {
						kind: "session_token",
						value: result.session_token,
					};
					authActions.rememberSession(result.session_token);
				}

				set({
					status: "connected",
					reconnectAttempts: 0,
					version: result.version,
					errorMessage: null,
					reauthReason: null,
				});
			} catch (err) {
				// Not a rejection: the request timed out or the socket died mid-auth.
				// Close (a no-op if it is already gone) and let onclose run the normal
				// reconnect path instead of showing a dead-end password screen.
				if (!isAuthRejection(err)) {
					console.warn("Auth did not complete, retrying:", err);
					socket.close();
					return;
				}

				// A session the cluster no longer knows is nobody's mistake: drop it
				// and go back to the password screen, stating the fact without
				// dressing it as an error the user caused.
				if (authFailureReason(err) === "session_expired") {
					authActions.forgetSession();
					internal.credential = null;
					// Status before close, as in disconnect(): onclose must see
					// "disconnected" and not schedule a reconnect on the way past.
					//
					// version goes too: it is what says "this tab has been connected",
					// and leaving it would keep the node list on screen with nothing
					// left to authenticate with. Say why, quietly — see reauthReason.
					set({
						status: "disconnected",
						errorMessage: null,
						version: null,
						reauthReason: "session_expired",
					});
					internal.socket?.close();
					return;
				}

				// Status before close, as in the branch above: onclose bails on
				// "auth_failed" and would otherwise schedule a reconnect that retries
				// the refused credential on its own.
				//
				// version goes too: a refusal stops retrying, so anything still
				// showing the node list would sit there with a "Connected" header
				// over a closed socket. A tab reaches this with a version only when
				// its credential is still a password (a server too old to issue a
				// token) and that password stopped being accepted — rare, but the
				// way out of it is the password screen.
				set({
					status: "auth_failed",
					version: null,
					errorMessage:
						err instanceof Error ? err.message : "Authentication failed",
				});
				internal.socket?.close();
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
		reconnectAttempts: 0,
		reauthReason: null,
		actions: {
			...nodeActions,
			connect: (credential: AuthCredential) => {
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
				// A fresh attempt answers whatever the last refusal said.
				set({ reconnectAttempts: 0, reauthReason: null });
				connectInternal(credential);
			},
			// Deliberately not connect(): that resets the attempt counter, and a
			// hand-pressed retry that also fails should resume the backoff where it
			// was rather than restart it from one second. connectInternal disarms
			// the pending timer itself.
			retryNow: () => {
				if (!internal.credential) return;
				connectInternal(internal.credential);
			},
			disconnect: () => {
				clearReconnectTimeout();
				internal.credential = null;
				// Auto-reconnect is already off: the credential is cleared and
				// onclose bails on "disconnected". Reset so a later connect() starts
				// at the short end of the backoff. Mirrors the web client.
				//
				// Set status BEFORE closing so onclose sees "disconnected" and skips
				// scheduleReconnect(); otherwise closing a connected socket would flip
				// through "reconnecting" and leave a stray no-op timer.
				set({
					status: "disconnected",
					version: null,
					errorMessage: null,
					reconnectAttempts: 0,
					reauthReason: null,
				});
				if (internal.socket) {
					internal.socket.close();
					internal.socket = null;
				}
				internal.client = null;
			},
		},
	};
});
