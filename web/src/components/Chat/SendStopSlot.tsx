import { type ReactNode, useEffect, useState } from "react";

/**
 * How long a control that has just landed under the thumb refuses a press.
 * Sending empties the draft and opens the turn in one go, so the button under
 * the thumb that was Send is Stop a frame later — and a double tap, or a quick
 * second message, would interrupt a turn nobody meant to end. The attention
 * strip's Deny and Allow have the same problem: answering one request puts the
 * next in the same place. Neither interrupting nor approving can be undone.
 */
export const ARM_MS = 500;

interface SlotState {
	turnOpen: boolean;
	/** The host's verdict on sending (`InputBarProps.canSend`). */
	canSend: boolean;
	hasDraft: boolean;
	disabled: boolean;
}

/**
 * Whether the composer's one action slot holds Stop rather than Send. Never
 * both: a destructive 44px target beside Send under a thumb is the mistake this
 * slot exists to rule out (docs/lifecycle-ui.md §2.3).
 *
 * Stop wins while a turn is open and Send has nothing to do — no draft, or a
 * host that refuses sends, which during a turn means a permission card owns
 * the agent's next input, and Stop is one of the user's two ways out of it. A
 * draft written mid-turn is a steering message, so it keeps Send; interrupting
 * then is an emptied draft away, or Escape on a keyboard.
 */
export function slotShowsStop({
	turnOpen,
	canSend,
	hasDraft,
	disabled,
}: SlotState): boolean {
	if (disabled || !turnOpen) return false;
	return !canSend || !hasDraft;
}

/**
 * Wraps controls that can arrive under a press meant for something else — the
 * composer's Stop, the strip's Deny and Allow — and holds them unpressable for
 * `ARM_MS` after they arrive. Arrival is mounting: the slot swaps Send for Stop
 * by unmounting one and mounting the other, so every Send-to-Stop change
 * re-arms and Stop-to-Send waits for nothing; the strip keys it by request, so
 * each new request re-arms.
 *
 * `inert` as well as `pointer-events-none`: a pointer is the case this is for,
 * but a disarmed control should not take focus or a key either.
 */
export function Armed({
	children,
	className = "",
}: {
	children: ReactNode;
	/** Laid out as a flex row; this adds to it (a gap between two controls). */
	className?: string;
}) {
	const [armed, setArmed] = useState(false);

	useEffect(() => {
		const id = setTimeout(() => setArmed(true), ARM_MS);
		return () => clearTimeout(id);
	}, []);

	return (
		<div
			inert={!armed}
			data-armed={armed}
			style={{ animationDuration: `${ARM_MS}ms` }}
			className={`flex shrink-0 animate-stop-arm ${className} ${
				armed ? "" : "pointer-events-none"
			}`}
		>
			{children}
		</div>
	);
}
