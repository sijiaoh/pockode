import { createContext, useContext, useState } from "react";

/**
 * A request to bring one tool row into sight. A fresh object per press, so the
 * same call asked for twice is two requests.
 */
export interface ToolReveal {
	toolUseId: string;
	/**
	 * Open the target's own row too, not only what hides it: a subagent row and
	 * its Process, when what the reader came for is the agent's work
	 * (docs/turn-progress-ui.md#43-the-agents-line).
	 */
	openTarget?: boolean;
}

export type GoToCall = (
	toolUseId: string,
	options?: { openTarget?: boolean },
) => void;

interface ToolJump {
	/** The request the transcript is carrying out, until it has landed. */
	reveal: ToolReveal | null;
	/** Opens what hides the row, then moves the view onto it. Stable. */
	goToCall: GoToCall;
}

/**
 * The transcript's jump to a tool row (docs/tool-call-ui.md#from-a-file-to-the-calls-that-changed-it).
 * Beside the view context rather than in it: `TranscriptView` is the shape the
 * clamp in `ui` takes, and a request changing would redraw every block that
 * reads the view.
 *
 * What hides a row is local state — a group's open set, a subagent row and its
 * Process — and a body never opened is not mounted, so the request is carried
 * down and each holder on the path opens itself (`useRevealRequest`); the
 * transcript moves once that commit has landed.
 */
export const ToolJumpContext = createContext<ToolJump | null>(null);

/** Null outside a transcript, where there is nothing to go to. */
export function useGoToCall(): GoToCall | null {
	return useContext(ToolJumpContext)?.goToCall ?? null;
}

/**
 * Calls `onReveal` once per request, during render, so the state it sets —
 * and whatever that mounts, which reads the same request as it does — is in
 * the commit the jump measures. `onReveal` decides whether the row is behind
 * what the caller holds; what it opens stays open, as a tap of the user's
 * would.
 */
export function useRevealRequest(onReveal: (reveal: ToolReveal) => void) {
	const reveal = useContext(ToolJumpContext)?.reveal ?? null;
	const [seen, setSeen] = useState<ToolReveal | null>(null);
	if (reveal && reveal !== seen) {
		setSeen(reveal);
		onReveal(reveal);
	}
}
