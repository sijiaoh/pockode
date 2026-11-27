/**
 * One line naming a work item, with *Open* into its detail overlay: what a
 * Pockode work tool's body opens on, and the `Subtask` row of a work event
 * line about a child (docs/tool-call-ui.md#pockodes-own-work-calls).
 *
 * It reads nothing live: the title is the one recorded with the call or the
 * event, and whatever the work is doing now is on the page *Open* leads to.
 */
export function WorkRefLine({
	label,
	title,
	mono = false,
	openId,
	onOpen,
}: {
	/** The kind, muted: `Task`, `Story`, `Subtask`. */
	label: string;
	title: string;
	/** An id standing in for a title not known. */
	mono?: boolean;
	/** The work *Open* leads to; absent when there is none to offer. */
	openId?: string;
	onOpen?: (workId: string) => void;
}) {
	return (
		<div className="flex min-h-6 items-center gap-2">
			<span className="shrink-0 text-th-text-muted">{label}</span>
			<span
				className={`min-w-0 flex-1 break-words text-th-text-primary ${mono ? "break-all font-mono" : ""}`}
			>
				{title}
			</span>
			{openId && onOpen && (
				<button
					type="button"
					onClick={() => onOpen(openId)}
					// Starts with the visible word, so speech input can say it.
					aria-label={`Open ${label.toLowerCase()} ${title}`}
					className="touch-target flex h-6 shrink-0 items-center rounded px-1 text-th-accent hover:bg-th-overlay-hover"
				>
					Open
				</button>
			)}
		</div>
	);
}
