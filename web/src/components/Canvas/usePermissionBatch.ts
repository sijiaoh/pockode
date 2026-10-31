import { useIsPageCovered } from "@pockode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	type ResolvedPermission,
	resolvePermission,
	type TranscriptPermission,
	usePermissionRequestStore,
} from "../../lib/permissionRequestStore";
import type { MessageStatus, SessionTurn } from "../../types/message";
import { permissionExpiryText } from "../Chat/PermissionRequestItem";

/** How long a refused send's sentence stands in for the text (§10.3). */
export const REFUSAL_SENTENCE_MS = 4000;

// The key of a permission blocker that names no request.
const UNNAMED = "unnamed:";

const EMPTY = { records: {}, outcomes: {}, unreadable: {} };

interface Options {
	sessionId: string;
	turn: SessionTurn;
	/** Until the session detail is loaded the count is unknown, not 0. */
	turnKnown: boolean;
	transcript: ReadonlyMap<string, TranscriptPermission>;
	isCodex: boolean;
	/**
	 * The last reply's status. `interrupted`: a Stop expired what was left;
	 * still open: how the turn ends is not known yet.
	 */
	replyStatus?: MessageStatus;
	/** Canvas view is on the screen. */
	shown: boolean;
}

/**
 * When the canvas's permission panel is up, and what stands in for it
 * (docs/canvas-ui.md §10.2): it opens by itself once per batch — a batch runs
 * from the first pending request to none — and a collapse holds for the rest
 * of the batch. State of this visit alone, held by `CanvasView`, which is kept
 * mounted under chat view and under a page over the session.
 */
export function usePermissionBatch({
	sessionId,
	turn,
	turnKnown,
	transcript,
	isCodex,
	replyStatus,
	shown,
}: Options) {
	const held = usePermissionRequestStore(
		useShallow((s) =>
			s.sessionId === sessionId
				? {
						records: s.records,
						outcomes: s.outcomes,
						unreadable: s.unreadable,
					}
				: EMPTY,
		),
	);
	const resolve = (requestId: string): ResolvedPermission =>
		resolvePermission(requestId, transcript, held);

	// A permission blocker without a request id names no record; it is still
	// listed, as one whose details are not there.
	const ids = (turn.blockers ?? []).flatMap((b) =>
		b.kind === "permission" ? [b.request_id ?? `${UNNAMED}${b.raised_at}`] : [],
	);
	const permissions = ids.map((id) =>
		id.startsWith(UNNAMED) ? { ...resolve(id), unreadable: true } : resolve(id),
	);

	const [batch, setBatch] = useState<{
		ids: string[];
		collapsed: boolean;
	} | null>(null);
	// The batch just over, for what became of its requests; dismissable.
	// `userCaused` is latched: once the batch is known to have ended by a Stop
	// or a denial on Claude, a reply opened by the next send must not make
	// its expiries look like the agent's doing.
	const [ended, setEnded] = useState<{
		ids: string[];
		dismissed: boolean;
		userCaused: boolean;
		/**
		 * The line has been shown: the agent's doing, settled. A Stop of a
		 * later turn does not take it back.
		 */
		said: boolean;
	} | null>(null);
	// Adjusted while rendering, so the panel comes up in the commit the
	// request arrives in.
	if (turnKnown) {
		if (ids.length > 0) {
			if (!batch) {
				setBatch({ ids, collapsed: false });
				setEnded(null);
			} else if (ids.some((id) => !batch.ids.includes(id))) {
				setBatch({
					...batch,
					ids: [...batch.ids, ...ids.filter((id) => !batch.ids.includes(id))],
				});
			}
		} else if (batch) {
			setBatch(null);
			setEnded({
				ids: batch.ids,
				dismissed: false,
				userCaused: false,
				said: false,
			});
		}
	}

	// Another layer up — a sheet, the drawer — holds the panel back: opened
	// under it, it would be a layer nobody sees, and Back would close it
	// first. Read only while the panel is not up, before its own registration
	// counts.
	const covered = useIsPageCovered();
	const wantOpen = batch !== null && !batch.collapsed && ids.length > 0;
	const [up, setUp] = useState(false);
	// Up and taken off the screen with the canvas — chat view, a page over
	// the session — the panel stays mounted, hidden, so it is found again as
	// it was left: its scroll, the sections opened in its cards.
	const [parked, setParked] = useState(false);
	if (up && !(wantOpen && shown)) {
		setUp(false);
		if (wantOpen) setParked(true);
	} else if (!up && wantOpen && shown && !covered) {
		setUp(true);
		setParked(false);
	} else if (parked && !wantOpen) {
		setParked(false);
	}

	const collapse = useCallback(() => {
		setBatch((b) => b && { ...b, collapsed: true });
	}, []);
	const show = useCallback(() => {
		setBatch((b) => b && { ...b, collapsed: false });
	}, []);

	// Refused sends: how many, and whether the sentence is standing in.
	const [attempt, setAttempt] = useState(0);
	const [refused, setRefused] = useState(false);
	const refusedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(refusedTimer.current), []);
	const sendRefused = useCallback(() => {
		setAttempt((n) => n + 1);
		setRefused(true);
		clearTimeout(refusedTimer.current);
		refusedTimer.current = setTimeout(
			() => setRefused(false),
			REFUSAL_SENTENCE_MS,
		);
	}, []);

	// The expiries the user did not cause: not after a Stop, nor after a
	// denial on Claude, which expires the rest by ending the turn.
	let expiryText: string | null = null;
	if (!batch && ended && !ended.userCaused) {
		const outcome = ended.ids.map(resolve);
		const deniedOnClaude =
			!isCodex && outcome.some((p) => p.status === "denied");
		if (!ended.said && (replyStatus === "interrupted" || deniedOnClaude)) {
			setEnded({ ...ended, userCaused: true });
		} else if (!ended.dismissed) {
			const expired = outcome.filter((p) => p.status === "expired");
			// A withdrawal that gives no reason may be a Stop's, and the Stop
			// shows only later: Codex withdraws its approvals before the turn
			// ends, and the turn's end is announced before the reply's
			// `interrupted` record. So it waits for the reply to have ended.
			const replyOpen =
				turn.open || replyStatus === "sending" || replyStatus === "streaming";
			const maybeStopped = replyOpen && expired.some((p) => !p.reason);
			if (expired.length > 0 && !maybeStopped) {
				expiryText = permissionExpiryText(expired.map((p) => p.reason));
				if (!ended.said) setEnded({ ...ended, said: true });
			}
		}
	}
	const dismissExpiry = useCallback(() => {
		setEnded((e) => e && { ...e, dismissed: true });
	}, []);

	const pending = permissions.filter((p) => p.status === "pending");
	return {
		permissions,
		/** The panel is on the screen. */
		up,
		/** The panel is mounted: up, or parked off the screen. */
		drawn: up || parked,
		/** The banner stands in: collapsed, or waiting behind another layer. */
		bannerUp: batch !== null && ids.length > 0 && shown && !up,
		/** Unanswered, for the banner; all of them while answers are in flight. */
		bannerCount: pending.length || permissions.length,
		/** The oldest pending request that has a record. */
		oldest: pending.find((p) => p.request)?.request ?? null,
		collapse,
		show,
		attempt,
		refused,
		sendRefused,
		expiryText,
		dismissExpiry,
	};
}
