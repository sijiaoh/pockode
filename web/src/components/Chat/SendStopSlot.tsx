import { type ReactNode, useEffect, useState } from "react";

/**
 * How long a Stop that has just taken the slot refuses a press. Sending empties
 * the draft and opens the turn in one go, so the button under the thumb that
 * was Send is Stop a frame later — and a double tap, or a quick second message,
 * would interrupt a turn nobody meant to end. Interrupting cannot be undone.
 */
export const STOP_ARM_MS = 500;

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
 * Wraps whatever Stop is drawn in the slot and holds it unpressable for
 * `STOP_ARM_MS` after it arrives. Arrival is mounting: the slot swaps Send for
 * Stop by unmounting one and mounting the other, so every Send-to-Stop change
 * re-arms and Stop-to-Send waits for nothing.
 *
 * `inert` as well as `pointer-events-none`: a pointer is the case this is for,
 * but a disarmed control should not take focus or a key either.
 */
export function ArmedStop({ children }: { children: ReactNode }) {
	const [armed, setArmed] = useState(false);

	useEffect(() => {
		const id = setTimeout(() => setArmed(true), STOP_ARM_MS);
		return () => clearTimeout(id);
	}, []);

	return (
		<div
			inert={!armed}
			data-armed={armed}
			style={{ animationDuration: `${STOP_ARM_MS}ms` }}
			className={`flex shrink-0 animate-stop-arm ${
				armed ? "" : "pointer-events-none"
			}`}
		>
			{children}
		</div>
	);
}
