import { WrapText } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";

/**
 * The title bar of a block of content: what the block is on the left, what can
 * be done with it on the right.
 *
 * The actions live here rather than over the content because anything laid
 * over text covers some of it — a copy button in a code block's corner sat on
 * the end of its first line, and on a phone that line is most of the command.
 */
export function BlockHeader({
	label,
	actions,
}: {
	/** Text, or a control that is the label — a disclosure's toggle. */
	label: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<div className="flex min-h-6 items-center gap-2">
			<div className="flex min-w-0 flex-1 items-center text-th-text-muted">
				{label}
			</div>
			{/* Up to four buttons whose hit areas reach past their 24px boxes:
			    centres 36px apart under a mouse and 44px under a thumb keep the
			    areas from overlapping. */}
			{actions && (
				<div className="flex shrink-0 items-center gap-3 pointer-coarse:gap-5">
					{actions}
				</div>
			)}
		</div>
	);
}

/**
 * How large a header's buttons are drawn: `sm` on a block's line in the
 * transcript, `lg` in a toolbar of their own — the full screen viewer's, at the
 * rung of the sheet's close button.
 */
export type HeaderButtonSize = "sm" | "lg";

const BOX: Record<HeaderButtonSize, string> = { sm: "size-6", lg: "size-9" };
const ICON: Record<HeaderButtonSize, number> = { sm: 14, lg: 16 };

function boxClass(size: HeaderButtonSize): string {
	return `flex ${BOX[size]} shrink-0 items-center justify-center rounded hover:bg-th-overlay-hover hover:text-th-text-primary`;
}

/**
 * An icon button's look in a `BlockHeader`, for header actions to share —
 * `pressed` for a switch that is on.
 */
export function headerButtonClass(
	size: HeaderButtonSize = "sm",
	pressed = false,
): string {
	return `touch-target ${boxClass(size)} ${
		pressed ? "bg-th-bg-tertiary text-th-text-primary" : "text-th-text-muted"
	}`;
}

/** A copy button sized for `BlockHeader`'s line rather than for a corner. */
export function HeaderCopyButton({
	text,
	label,
	size = "sm",
}: {
	text: string | (() => string);
	/** Says which block: a body with a command and its output has two. */
	label: string;
	size?: HeaderButtonSize;
}) {
	return (
		<CopyButton
			text={text}
			label={label}
			iconSize={ICON[size]}
			// `touch-target` is the copy button's own.
			className={`${boxClass(size)} text-th-text-muted`}
		/>
	);
}

/** Wraps long lines instead of scrolling them sideways, pressed or not. */
export function WrapLinesToggle({
	pressed,
	onToggle,
	size = "sm",
}: {
	pressed: boolean;
	onToggle: () => void;
	size?: HeaderButtonSize;
}) {
	return (
		<button
			type="button"
			aria-label="Wrap long lines"
			aria-pressed={pressed}
			onClick={onToggle}
			className={headerButtonClass(size, pressed)}
		>
			<WrapText size={ICON[size]} aria-hidden="true" />
		</button>
	);
}
