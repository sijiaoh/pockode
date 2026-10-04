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
			{actions && (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			)}
		</div>
	);
}

/** A copy button sized for `BlockHeader`'s line rather than for a corner. */
export function HeaderCopyButton({
	text,
	label,
}: {
	text: string | (() => string);
	/** Says which block: a body with a command and its output has two. */
	label: string;
}) {
	return (
		<CopyButton
			text={text}
			label={label}
			className="flex size-6 items-center justify-center rounded text-th-text-muted hover:bg-th-overlay-hover hover:text-th-text-primary"
		/>
	);
}
