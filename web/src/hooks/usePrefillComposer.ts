import { useIsExpanded } from "@pockode/shared";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import {
	inputActions,
	type PrefillReveal,
	useInputStore,
} from "../lib/inputStore";
import { buildNavigation } from "../lib/navigation";
import { createSession } from "../lib/sessionCreate";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../lib/sessionDetailStore";
import { useWorktreeStore } from "../lib/worktreeStore";
import { isWorktreeSwitchInFlight } from "../lib/wsStore";
import { mainAreaOverlay, overlayKeepsComposer } from "../types/overlay";
import { appendToDraft, insertIntoDraft } from "../utils/draftText";
import type { GitFailure } from "../utils/gitErrors";
import { useRouteState } from "./useRouteState";

export interface PrefillComposer {
	/**
	 * Puts `text` into the current session's composer — or a new session's, when
	 * there is no current one — and takes the user there, unless that composer
	 * is already on the page. Never sends. Prose only: a Pockode command
	 * appended to a draft would go out as plain text.
	 */
	prefill: (text: string) => Promise<void>;
	/**
	 * `prefill` for a quotation — lines of code, a diff — that goes with words
	 * the user is writing: where the composer is on the page, it goes in at
	 * the composer's caret instead of after the draft, and the caret ends up
	 * under it. Everything else is `prefill`'s, including a new session and
	 * the push to it.
	 */
	insert: (text: string) => Promise<void>;
	/** A session is being created for the text; the pressed entry shows it. */
	isPending: boolean;
	/** The create failed, in the shape the Git workspace's banner takes. */
	error: GitFailure | null;
	dismissError: () => void;
}

/**
 * How a surface outside the chat hands the agent a piece of work: it writes a
 * prepared message into a session's draft and pushes that session's chat
 * (docs/agent-handoff-ui.md §1). A page that keeps the composer under it — a
 * Git detail — is left where it is: the draft is right there, and the page is
 * what the message is about.
 *
 * Every such entry goes through here and none writes `inputStore` itself, so
 * "never sends, never over the user's words" has one implementation.
 *
 * The target is the route's `session` when this worktree holds its detail —
 * `useWorkspaceEngine`'s test, so an AI call and a handoff from one screen
 * name the same session — and a new session in the route's worktree otherwise.
 *
 * Call it from a surface that stays on screen through the press — the page or
 * the bar the entry sits in, not a menu row that closes on select: `isPending`
 * and `error` belong to this call of the hook, and a failure reported to one
 * that has unmounted is a failure nobody sees.
 */
export function usePrefillComposer(): PrefillComposer {
	const navigate = useNavigate();
	const router = useRouter();
	const { sessionId, worktree, overlay: routeOverlay } = useRouteState();
	// A Git list at `expanded` is in the sidebar, beside the chat's composer.
	const overlay = mainAreaOverlay(routeOverlay, useIsExpanded());
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<GitFailure | null>(null);

	// Read at the press, not captured at render: the target is whatever is held
	// when the user acts.
	const routeRef = useRef({ sessionId, worktree, overlay });
	routeRef.current = { sessionId, worktree, overlay };
	const pendingRef = useRef(false);

	const handOff = useCallback(
		async (text: string, atCaret: boolean) => {
			if (pendingRef.current) return;
			const { sessionId, worktree, overlay } = routeRef.current;
			const pressedAt = router.state.location.href;
			setError(null);
			let target = selectSessionDetail(sessionId)(
				useSessionDetailStore.getState(),
			)
				? sessionId
				: null;

			// Held until the push lands as well as through a create, so a second
			// press before the route moves does not push the chat twice and leave
			// Back pointing at it instead of at this screen.
			pendingRef.current = true;
			try {
				if (target === null) {
					// `session.create` answers in the worktree the connection is bound
					// to, which is not yet the route's while a switch is landing.
					if (
						isWorktreeSwitchInFlight() ||
						useWorktreeStore.getState().current !== worktree
					) {
						setError({
							summary: "Couldn't start a new chat",
							detail: "This worktree is still opening. Try again in a moment.",
						});
						return;
					}
					setIsPending(true);
					try {
						target = (await createSession()).id;
					} catch (e) {
						// Nothing is lost: the text is still the entry's.
						setError({
							summary: "Couldn't start a new chat",
							detail: e instanceof Error && e.message ? e.message : null,
						});
						return;
					} finally {
						setIsPending(false);
					}
				}

				const stays = target === sessionId && overlayKeepsComposer(overlay);
				// Before navigating, so the composer is never on screen empty for a
				// frame.
				const reveal = writeDraft(
					target,
					text,
					atCaret && stays ? inputActions.readCaret(target) : null,
				);
				// A user who moved on while the session was being created has gone
				// somewhere of their own, and is not pulled away from it; the text
				// waits in the new session's draft, with nothing to announce on a
				// later visit.
				if (router.state.location.href !== pressedAt) return;
				inputActions.requestReveal(target, reveal);
				if (stays) return;
				await navigate(
					buildNavigation({ type: "session", worktree, sessionId: target }),
				);
			} finally {
				pendingRef.current = false;
			}
		},
		[navigate, router],
	);

	const prefill = useCallback(
		(text: string) => handOff(text, false),
		[handOff],
	);
	const insert = useCallback((text: string) => handOff(text, true), [handOff]);
	const dismissError = useCallback(() => setError(null), []);

	return { prefill, insert, isPending, error, dismissError };
}

/** `caret` is the composer's, or null to append. */
function writeDraft(
	sessionId: string,
	text: string,
	caret: number | null,
): PrefillReveal {
	const before = useInputStore.getState().inputs[sessionId] ?? "";
	if (caret === null) {
		const after = appendToDraft(before, text);
		if (after !== before) inputActions.set(sessionId, after);
		return { landed: after === text.trim() ? "ready" : "added" };
	}
	const inserted = insertIntoDraft(
		before,
		text,
		Math.min(caret, before.length),
	);
	if (inserted.draft !== before) inputActions.set(sessionId, inserted.draft);
	return {
		landed: inserted.draft.trim() === text.trim() ? "ready" : "added",
		caret: inserted.caret,
	};
}
