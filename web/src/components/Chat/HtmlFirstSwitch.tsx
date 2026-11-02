import { useCallback, useEffect, useRef, useState } from "react";
import { htmlFirstRefusedReason } from "../../lib/rpc/session";
import {
	getSessionStyleInfo,
	SESSION_STYLES,
	type SessionStyle,
	sessionStyleOf,
} from "../../lib/sessionStyle";
import { useWSStore } from "../../lib/wsStore";
import type { SessionDetail } from "../../types/message";
import ToggleGroup from "../ui/ToggleGroup";

type SwitchError = { kind: "started" } | { kind: "failed"; reason: string };

/** A write that has gone out, and what has come back of it so far. */
interface InFlight {
	sessionId: string;
	/**
	 * The detail on screen when the press was made. Any snapshot after it
	 * settles the write once the reply is in — not only one where the value
	 * moved: a switch from another device can take it there and back between
	 * two renders, and a hold waiting for a move it never sees would keep Send
	 * held for good.
	 */
	pressedOn: SessionDetail;
	replied: boolean;
}

export interface HtmlFirstSwitchControl {
	style: SessionStyle;
	/** A switch is in flight: the first message waits for it (§2.3). */
	pending: boolean;
	error: SwitchError | null;
	select: (style: SessionStyle) => void;
	/** Resolves once nothing is in flight — at once when nothing is. */
	whenSettled: () => Promise<void>;
}

/**
 * The write behind the empty state's Chat / HTML first switch, held by the chat
 * panel rather than the switch: every path that sends the first message has to
 * wait for it, and most of them are not under the switch
 * (docs/html-first-session-ui.md §2.3).
 *
 * `detail` is the session's detail as last reported; the lit segment is
 * always its `html_first`, never the value asked for. So a write is settled
 * only once its reply is in *and* a detail has arrived since the press, in
 * whichever order the two arrive: then the first message goes to the session
 * the screen shows.
 */
export function useHtmlFirstSwitch({
	sessionId,
	detail,
	offered,
}: {
	sessionId: string;
	/** Only ever offered once it has arrived, so null holds nothing. */
	detail: SessionDetail | null;
	/** Whether the switch is on screen; its refusal line goes when it does. */
	offered: boolean;
}): HtmlFirstSwitchControl {
	const setSessionHTMLFirst = useWSStore((s) => s.actions.setSessionHTMLFirst);
	const [inFlight, setInFlight] = useState<InFlight | null>(null);
	const [error, setError] = useState<{
		sessionId: string;
		error: SwitchError;
	} | null>(null);

	const stored = detail?.html_first ?? false;
	const current = inFlight?.sessionId === sessionId ? inFlight : null;
	const settledByPush =
		current?.replied === true && detail !== current.pressedOn;
	// A switch that is no longer offered holds nothing up: the session has
	// started, so there is nothing left for a send to wait on.
	const pending = offered && current !== null && !settledByPush;

	useEffect(() => {
		if (settledByPush) setInFlight(null);
	}, [settledByPush]);

	useEffect(() => {
		if (!offered) setError(null);
	}, [offered]);

	const waiters = useRef<(() => void)[]>([]);
	const pendingRef = useRef(pending);
	pendingRef.current = pending;
	useEffect(() => {
		if (pending) return;
		const resolved = waiters.current;
		waiters.current = [];
		for (const resolve of resolved) resolve();
	}, [pending]);

	const whenSettled = useCallback(
		(): Promise<void> =>
			pendingRef.current
				? new Promise((resolve) => waiters.current.push(resolve))
				: Promise.resolve(),
		[],
	);

	const select = useCallback(
		(style: SessionStyle) => {
			setError(null);
			const htmlFirst = style === "html_first";
			if (pendingRef.current || !detail || htmlFirst === stored) return;
			const sentTo = sessionId;
			setInFlight({ sessionId: sentTo, pressedOn: detail, replied: false });
			setSessionHTMLFirst(sentTo, htmlFirst).then(
				() =>
					setInFlight((f) =>
						f?.sessionId === sentTo ? { ...f, replied: true } : f,
					),
				(cause: unknown) => {
					setInFlight((f) => (f?.sessionId === sentTo ? null : f));
					const reason = htmlFirstRefusedReason(cause);
					// A gone session is the shell's to leave, and a work session is
					// never offered the switch: neither is news to put under it.
					if (reason === "not_found" || reason === "work_session") return;
					setError({
						sessionId: sentTo,
						error:
							reason === "session_started"
								? { kind: "started" }
								: {
										kind: "failed",
										reason:
											cause instanceof Error && cause.message
												? cause.message
												: "Unknown error",
									},
					});
				},
			);
		},
		[sessionId, detail, stored, setSessionHTMLFirst],
	);

	return {
		style: sessionStyleOf(stored),
		pending,
		error: error?.sessionId === sessionId ? error.error : null,
		select,
		whenSettled,
	};
}

function errorLine(error: SwitchError, style: SessionStyle): string {
	if (error.kind === "started") {
		return `This session has already started, so it stays a ${getSessionStyleInfo(style).label} session.`;
	}
	return `Couldn't switch: ${error.reason}`;
}

/**
 * The Chat / HTML first switch on a new session's empty state
 * (docs/html-first-session-ui.md §2).
 */
function HtmlFirstSwitch({ control }: { control: HtmlFirstSwitchControl }) {
	const { style, pending, error, select } = control;
	return (
		<div className="space-y-1.5">
			<ToggleGroup
				label="Session"
				items={SESSION_STYLES}
				selected={style}
				onSelect={select}
				getInfo={getSessionStyleInfo}
				hint={getSessionStyleInfo(style).hint}
				error={error && errorLine(error, style)}
				disabled={pending}
			/>
			<p className="text-xs text-th-text-muted">
				Can be changed until you send the first message.
			</p>
		</div>
	);
}

export default HtmlFirstSwitch;
