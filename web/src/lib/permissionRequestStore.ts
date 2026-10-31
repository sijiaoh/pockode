import { create } from "zustand";
import type {
	ExpiryReason,
	PermissionRequest,
	PermissionStatus,
} from "../types/message";

/** What became of a request, as far as this client heard. */
export interface PermissionOutcome {
	status: Exclude<PermissionStatus, "pending">;
	reason?: ExpiryReason;
}

interface PermissionRequestStoreState {
	/** Which session the records belong to, or null when nothing is held. */
	sessionId: string | null;
	/** Each request's `permission_request` record, by request id. */
	records: Record<string, PermissionRequest>;
	/**
	 * Answers and expiries, by request id: the live records of them, and the
	 * answers this client sent before the server confirmed them.
	 */
	outcomes: Record<string, PermissionOutcome>;
	/**
	 * Requests pending when the subscription opened whose record the reply
	 * did not carry: the append failed, and the broadcast went out before this
	 * client was listening, so it will never arrive. Any other request without
	 * a record is one whose record is on its way — the server settles the
	 * blocker before it writes and broadcasts the record.
	 */
	unreadable: Record<string, true>;
}

interface PermissionRequestStoreActions {
	/**
	 * Starts over from a subscribe reply's `permission_requests`: the records
	 * of every request pending then. What was held before is the previous
	 * subscription's, and anything still pending is in the reply. `pending`
	 * is the reply's own turn's permission requests, read with the records.
	 */
	reset: (
		sessionId: string,
		records: PermissionRequest[],
		pending?: string[],
	) => void;
	/** A live `permission_request` record. */
	add: (sessionId: string, record: PermissionRequest) => void;
	/**
	 * An answer or an expiry. An expiry never overwrites an answer: a request
	 * answered here is settled, whatever a late cancellation says.
	 */
	settle: (
		sessionId: string,
		requestId: string,
		outcome: PermissionOutcome,
	) => void;
	/** An answer the server refused: the request is back to unanswered. */
	unsettle: (sessionId: string, requestId: string) => void;
	forget: (sessionId: string) => void;
}

export type PermissionRequestStore = PermissionRequestStoreState &
	PermissionRequestStoreActions;

/**
 * The open session's permission requests as events told them — what each one
 * asks, and what became of it — kept apart from the transcript
 * (docs/canvas-ui.md §10.4). Which requests are pending is not here: that is
 * `TurnState.blockers`, and this only describes them.
 *
 * Not fed to the message reducer, because the subscribe reply's records may be
 * far older than the loaded page; and not read by chat view, which draws its
 * cards from the transcript. One session at a time, as `canvasStore` is.
 * Filled by `useChatMessages`, which holds the subscription.
 */
export const usePermissionRequestStore = create<PermissionRequestStore>(
	(set, get) => {
		// A record of a session other than the held one starts it over: the
		// held one's records say nothing about it.
		const forSession = (sessionId: string): PermissionRequestStoreState => {
			const held = get();
			return held.sessionId === sessionId
				? held
				: { sessionId, records: {}, outcomes: {}, unreadable: {} };
		};
		return {
			sessionId: null,
			records: {},
			outcomes: {},
			unreadable: {},
			reset: (sessionId, records, pending = []) => {
				const byId = Object.fromEntries(records.map((r) => [r.requestId, r]));
				set({
					sessionId,
					records: byId,
					outcomes: {},
					unreadable: Object.fromEntries(
						pending.filter((id) => !byId[id]).map((id) => [id, true]),
					),
				});
			},
			add: (sessionId, record) => {
				const held = forSession(sessionId);
				set({
					...held,
					records: { ...held.records, [record.requestId]: record },
				});
			},
			settle: (sessionId, requestId, outcome) => {
				const held = forSession(sessionId);
				const prev = held.outcomes[requestId];
				if (
					outcome.status === "expired" &&
					(prev?.status === "allowed" || prev?.status === "denied")
				) {
					return;
				}
				set({ ...held, outcomes: { ...held.outcomes, [requestId]: outcome } });
			},
			unsettle: (sessionId, requestId) => {
				const held = get();
				if (held.sessionId !== sessionId || !held.outcomes[requestId]) return;
				const { [requestId]: _, ...outcomes } = held.outcomes;
				set({ outcomes });
			},
			forget: (sessionId) => {
				if (get().sessionId !== sessionId) return;
				set({ sessionId: null, records: {}, outcomes: {}, unreadable: {} });
			},
		};
	},
);

export const permissionRequestActions = {
	reset: (
		sessionId: string,
		records: PermissionRequest[],
		pending?: string[],
	) => usePermissionRequestStore.getState().reset(sessionId, records, pending),
	add: (sessionId: string, record: PermissionRequest) =>
		usePermissionRequestStore.getState().add(sessionId, record),
	settle: (sessionId: string, requestId: string, outcome: PermissionOutcome) =>
		usePermissionRequestStore.getState().settle(sessionId, requestId, outcome),
	unsettle: (sessionId: string, requestId: string) =>
		usePermissionRequestStore.getState().unsettle(sessionId, requestId),
	forget: (sessionId: string) =>
		usePermissionRequestStore.getState().forget(sessionId),
};

/** A permission card as the transcript has it, where it is loaded. */
export interface TranscriptPermission {
	request: PermissionRequest;
	status: PermissionStatus;
	reason?: ExpiryReason;
}

/**
 * One request as the canvas's panel draws it: `request` is null for a blocker
 * whose record this client does not have — never will (`unreadable`), or not
 * yet.
 */
export interface ResolvedPermission {
	requestId: string;
	request: PermissionRequest | null;
	unreadable?: boolean;
	status: PermissionStatus;
	reason?: ExpiryReason;
}

/**
 * What is known of one request. The transcript's card first, where it is
 * loaded: it is what chat view shows, and the two must agree. Otherwise the
 * records the store heard; and with no word of an answer, still pending.
 */
export function resolvePermission(
	requestId: string,
	transcript: ReadonlyMap<string, TranscriptPermission>,
	held: Pick<
		PermissionRequestStoreState,
		"records" | "outcomes" | "unreadable"
	>,
): ResolvedPermission {
	const card = transcript.get(requestId);
	if (card) return { requestId, ...card };
	const outcome = held.outcomes[requestId];
	const request = held.records[requestId] ?? null;
	return {
		requestId,
		request,
		...(request === null && held.unreadable[requestId]
			? { unreadable: true }
			: {}),
		status: outcome?.status ?? "pending",
		...(outcome?.reason ? { reason: outcome.reason } : {}),
	};
}
