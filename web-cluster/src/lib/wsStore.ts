import {
	type AuthCredential,
	authFailureReason,
	authRetryAfterMs,
	type CloudLinkChangedNotification,
	type CloudLinkStatus,
	credentialParams,
	getWebSocketUrl,
	restartRefusedReason,
} from "@pockode/shared";
import {
	JSONRPCClient,
	JSONRPCErrorCode,
	JSONRPCErrorException,
} from "json-rpc-2.0";
import { create } from "zustand";
import { authActions } from "./authStore";
import {
	type CloudLinkActions,
	createCloudLinkActions,
	createNodeActions,
	createServerActions,
	type NodeActions,
	type ServerActions,
} from "./rpc";
import { APP_VERSION } from "./version";

const RPC_TIMEOUT_MS = 30000;

const CONNECTION_LOST_MESSAGE = "Connection lost";

/** Whether a request's socket went away before its answer came down it. */
export function isConnectionLost(error: unknown): boolean {
	return (
		error instanceof JSONRPCErrorException &&
		error.code === 0 &&
		error.message === CONNECTION_LOST_MESSAGE
	);
}

/**
 * Whether the server answered that the request named something wrong, as
 * opposed to failing to answer it. Mirrors the web client.
 */
export function isInvalidParamsRejection(error: unknown): boolean {
	return (
		error instanceof JSONRPCErrorException &&
		error.code === JSONRPCErrorCode.InvalidParams
	);
}

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
	/** What the client stores in place of the password. */
	session_token: string;
}

interface RPCActions
	extends NodeActions,
		CloudLinkActions,
		Pick<
			ServerActions,
			"serverVersion" | "serverUpdateCheck" | "serverUpdate"
		> {
	connect: (credential: AuthCredential) => void;
	disconnect: () => void;
	retryNow: () => void;
	/**
	 * Ask the cluster to restart (`server.restart`). Resolves once a restart is
	 * under way and `restartRequestedAt` is set — accepted here, already under
	 * way from elsewhere, or with this connection gone before its reply could
	 * arrive (the reconnect's version says how it went). Rejects with the
	 * cluster's refusal, which changed nothing. Mirrors the web client.
	 */
	restartServer: () => Promise<void>;
	/**
	 * Follow the machine's cloud link: the reply is the status now, and
	 * `callback` gets every `cloud_link.changed` after it, each the whole
	 * status. The subscription dies with the connection; subscribe again
	 * after a reconnect.
	 */
	cloudLinkSubscribe: (
		callback: (params: CloudLinkChangedNotification) => void,
	) => Promise<{ id: string; status: CloudLinkStatus }>;
	cloudLinkUnsubscribe: (id: string) => Promise<void>;
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
	 * When the cluster will take a password again (epoch milliseconds), after a
	 * `rate_limited` refusal; null otherwise. It refuses every password until
	 * then, the right one included.
	 */
	authRetryAt: number | null;
	/**
	 * When the cluster accepted a restart this page asked for (epoch ms), until
	 * the next successful `auth` — the restarted process, or the same one if it
	 * never went down. This page's memory only: gone on a reload, which a new
	 * version causes anyway (docs/restart-ui.md, "While it restarts").
	 */
	restartRequestedAt: number | null;
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

/** By subscription id; a subscription lives as long as its connection. */
const cloudLinkCallbacks = new Map<
	string,
	(params: CloudLinkChangedNotification) => void
>();

/**
 * A subscription id. The server shares one id space among all its clients
 * and refuses one in use, so it is random rather than a per-page counter;
 * `crypto.randomUUID` is missing outside a secure context, which a cluster
 * reached over plain HTTP on a LAN is.
 */
function subscriptionId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function handleNotification(method: string, params: unknown): void {
	if (method === "cloud_link.changed") {
		const changed = params as CloudLinkChangedNotification;
		cloudLinkCallbacks.get(changed.id)?.(changed);
	}
}

/**
 * Stop holding the current socket and close it.
 *
 * Its onclose will ignore it for the same reason it ignores any superseded
 * socket, and their answers could only have come down it, so nothing else is
 * going to settle its pending requests: only auth carries a timeout, and the
 * node RPCs would hang for good. Mirrors the web client, down to the error.
 */
function releaseSocket(): void {
	const socket = internal.socket;
	internal.socket = null;
	socket?.close();
	internal.client?.rejectAllPendingRequests(CONNECTION_LOST_MESSAGE);
	internal.client = null;
	cloudLinkCallbacks.clear();
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
	const serverActions = createServerActions(getClient);
	const cloudLinkActions = createCloudLinkActions(getClient);

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
			stale.onopen = null;
			stale.onclose = null;
			stale.onmessage = null;
			stale.onerror = null;
			releaseSocket();
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

				// This page was built for another cluster: a restart into a newly
				// installed version, from here or from anywhere else. A development
				// build is "dev" on both sides, so it never reloads itself.
				if (result.version !== APP_VERSION) {
					console.info(
						`Version mismatch: client=${APP_VERSION}, server=${result.version}. Reloading...`,
					);
					window.location.reload();
					return;
				}

				set({
					status: "connected",
					reconnectAttempts: 0,
					version: result.version,
					errorMessage: null,
					restartRequestedAt: null,
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

				// A stored session the cluster no longer knows is nobody's mistake:
				// drop it and fall back to the password screen without an error.
				const reason = authFailureReason(err);
				if (reason === "session_expired") {
					authActions.forgetSession();
					internal.credential = null;
					// Status before close, as in disconnect(): onclose must see
					// "disconnected" and not schedule a reconnect on the way past.
					set({ status: "disconnected", errorMessage: null });
					internal.socket?.close();
					return;
				}

				// Too many wrong passwords lately: not this password's fault, and
				// not worth retrying on our own before the wait is over. Back to the
				// password screen, which holds off submitting until then.
				if (reason === "rate_limited") {
					const retryAfterMs = authRetryAfterMs(err) ?? 0;
					authActions.logout();
					internal.credential = null;
					set({
						status: "disconnected",
						errorMessage: null,
						authRetryAt: Date.now() + retryAfterMs,
					});
					internal.socket?.close();
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
				} else if ("method" in data) {
					handleNotification(data.method, data.params);
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

			internal.socket = null;
			// Their answers can only have come down this socket, and the node RPCs
			// carry no timeout, so without this they would hang for good.
			internal.client?.rejectAllPendingRequests(CONNECTION_LOST_MESSAGE);
			internal.client = null;
			cloudLinkCallbacks.clear();

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
		authRetryAt: null,
		restartRequestedAt: null,
		actions: {
			...nodeActions,
			...cloudLinkActions,
			serverVersion: serverActions.serverVersion,
			serverUpdateCheck: serverActions.serverUpdateCheck,
			serverUpdate: serverActions.serverUpdate,
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
				set({ reconnectAttempts: 0 });
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
					restartRequestedAt: null,
				});
				releaseSocket();
			},
			cloudLinkSubscribe: async (callback) => {
				const client = getClient();
				if (!client) throw new Error("Not connected");
				const id = subscriptionId();
				// Registered before the request: a change can be notified before
				// the reply arrives.
				cloudLinkCallbacks.set(id, callback);
				try {
					const result: { status: CloudLinkStatus } = await client.request(
						"cloud_link.subscribe",
						{ id },
					);
					return { id, status: result.status };
				} catch (err) {
					cloudLinkCallbacks.delete(id);
					throw err;
				}
			},
			cloudLinkUnsubscribe: async (id) => {
				cloudLinkCallbacks.delete(id);
				try {
					await getClient()?.request("cloud_link.unsubscribe", { id });
				} catch {
					// The connection may be gone, and the subscription with it.
				}
			},
			restartServer: async () => {
				try {
					await serverActions.serverRestart();
				} catch (error) {
					// Either way the process is going down, and the reconnect says
					// what came back. A reply lost with the connection — through the
					// relay it may not have been delivered — is not a failure to
					// show. A drop that took the request with it before the cluster
					// saw it reads the same and comes back to an unchanged process:
					// accepted, as it cannot be told from a same-version restart.
					if (
						restartRefusedReason(error) !== "already_restarting" &&
						!isConnectionLost(error)
					) {
						throw error;
					}
					// Logged out mid-request: there is no page left to wait on it.
					if (get().status === "disconnected") return;
				}
				// A second press while the first is still going down is refused as
				// already restarting; the clock runs from the first acceptance.
				set((state) => ({
					restartRequestedAt: state.restartRequestedAt ?? Date.now(),
				}));
			},
		},
	};
});
