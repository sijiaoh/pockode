import { Minus, Plus, TriangleAlert } from "lucide-react";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";

interface Props {
	/** Stage on an Unstaged row, unstage on a Staged one. */
	action: "stage" | "unstage";
	/** `Stage <path>` / `Unstage <path>`. */
	label: string;
	/** A write for these files is queued or running. */
	busy: boolean;
	onPress: () => void;
}

/**
 * Moves a file — or a folder of them — to the other group. An action, not a
 * state: a bare glyph with no box around it, since a box is what read as a
 * selection checkbox (docs/git-changes-ui.md, The stage buttons).
 *
 * While busy it stays focusable and only ignores presses: `disabled` would
 * drop the focus of a keyboard user who just pressed Space. The row is never
 * moved ahead of the status saying so.
 *
 * `data-stage-button` is how the group finds the button to hand focus to once
 * the pressed one's row has moved away.
 */
function StageButton({ action, label, busy, onPress }: Props) {
	const Icon = action === "stage" ? Plus : Minus;
	return (
		<button
			type="button"
			data-stage-button
			aria-label={label}
			aria-disabled={busy || undefined}
			aria-busy={busy || undefined}
			onClick={busy ? undefined : onPress}
			className={iconButtonClass({ busy })}
		>
			{busy ? (
				<Spinner variant="current" size="h-3.5 w-3.5" srText={null} />
			) : (
				<Icon className="size-4" aria-hidden="true" />
			)}
		</button>
	);
}

export default StageButton;

/**
 * The stage button's column without a button: a conflicted file's glyph, or
 * nothing for a folder of conflicts. As wide as the button, so the column
 * stays aligned.
 */
export function StageGutter({ conflict = false }: { conflict?: boolean }) {
	return (
		<span className="flex min-w-[36px] shrink-0 items-center justify-center self-stretch pointer-coarse:min-w-11">
			{conflict && (
				<TriangleAlert className="size-4 text-th-warning" aria-hidden="true" />
			)}
		</span>
	);
}
