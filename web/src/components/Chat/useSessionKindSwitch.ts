import { useCallback, useEffect, useRef, useState } from "react";
import { isSessionStartedRefusal } from "../../lib/rpc";
import { getSessionKindInfo, type SessionKind } from "../../lib/sessionKind";
import { isInvalidParamsRejection, wsActions } from "../../lib/wsStore";

export interface SessionKindSwitch {
	/** `session.set_canvas` is in flight: the chooser and Send both wait. */
	pending: boolean;
	/** The last refused switch, for the chooser's own error line. */
	error: string | null;
	/**
	 * A segment of the chooser was pressed, and the chooser drawn next — in
	 * whichever view the kind now puts it — takes the focus back, and the
	 * composer leaves the caret alone (docs/new-session-ui.md §3.3).
	 */
	choosing: boolean;
	choose: (kind: SessionKind) => void;
}

/**
 * The write behind the empty state's kind chooser. The kind shown is never
 * this hook's: it is the session's stored `canvas`, which moves when the
 * server's push says so, so a refused switch has nothing to put back.
 *
 * `shown` is whether the chooser is on screen; its error and its claim on
 * focus go when it does.
 */
export function useSessionKindSwitch(
	sessionId: string,
	current: SessionKind,
	shown: boolean,
): SessionKindSwitch {
	// Keyed by the session, so a switch still answering for the session the
	// user just left neither holds Send nor speaks in this one.
	const [request, setRequest] = useState<{
		id: number;
		sessionId: string;
		kind: SessionKind;
		answered: boolean;
		/** The stored kind has moved since the press. */
		moved: boolean;
	} | null>(null);
	const nextId = useRef(0);
	const [error, setError] = useState<{ sessionId: string; text: string }>();
	const [choosingFor, setChoosingFor] = useState<string | null>(null);

	useEffect(() => {
		if (shown) return;
		setError(undefined);
		setChoosingFor(null);
		setRequest(null);
	}, [shown]);
	// The push that moves the stored kind travels apart from the reply, on
	// either side of it; the hold lasts until both are in, or Send would go
	// out under the kind the screen is leaving. Any move counts — another
	// device may have switched it back meanwhile, and waiting for the asked
	// kind would then hold Send for good.
	// biome-ignore lint/correctness/useExhaustiveDependencies: marks the stored kind moving, whatever it moves to
	useEffect(() => {
		setRequest((r) => {
			if (r === null) return r;
			return r.answered ? null : { ...r, moved: true };
		});
	}, [current]);

	const pending =
		request !== null &&
		request.sessionId === sessionId &&
		(!request.answered || current !== request.kind);
	const choose = useCallback(
		(kind: SessionKind) => {
			setChoosingFor(sessionId);
			// Cleared by any press, as the next press is what the line invites.
			setError(undefined);
			if (pending || kind === current) return;
			const id = ++nextId.current;
			setRequest({ id, sessionId, kind, answered: false, moved: false });
			wsActions.setSessionCanvas(sessionId, kind === "canvas").then(
				() => {
					setRequest((r) => {
						if (r?.id !== id) return r;
						return r.moved ? null : { ...r, answered: true };
					});
				},
				(err: unknown) => {
					setRequest((r) => (r?.id === id ? null : r));
					const text = refusalText(err, current);
					if (text !== null) setError({ sessionId, text });
				},
			);
		},
		[sessionId, current, pending],
	);

	return {
		pending,
		error: error?.sessionId === sessionId ? error.text : null,
		choosing: choosingFor === sessionId,
		choose,
	};
}

function refusalText(err: unknown, kept: SessionKind): string | null {
	// The first message got there first; the chooser goes as `started` arrives.
	if (isSessionStartedRefusal(err)) {
		return `This session has already started, so it stays a ${getSessionKindInfo(kept).label.toLowerCase()} session.`;
	}
	// The other refusals name the session: one that is gone, which the shell
	// already reports by leaving it, or a work session, which is never offered
	// the chooser.
	if (isInvalidParamsRejection(err)) return null;
	return `Couldn't switch: ${err instanceof Error && err.message ? err.message : String(err)}`;
}
