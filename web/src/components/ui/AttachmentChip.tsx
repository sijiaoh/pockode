import type { LucideIcon } from "lucide-react";

interface Props {
	icon: LucideIcon;
	iconClassName?: string;
	title: string;
	/** The line under the name: type, size, or why there is nothing to show. */
	detail: string;
	/**
	 * Wraps the detail instead of cutting its end, for one whose end is what
	 * matters: a host, whose owner is its last part.
	 */
	wrapDetail?: boolean;
	/**
	 * What the name stands for, when it is a shortening of something — the file
	 * an agent named by its absolute path. It is the only place that path is
	 * readable: a chat bubble has no room for one, and truncating it in the row
	 * would cut off the end, which is the half that identifies the file.
	 */
	tooltip?: string;
	/**
	 * Absent leaves the entry inert, which is right when there is nothing to do.
	 * `ariaLabel` names what the action does to which entry, where several in
	 * one message would otherwise read alike — Load, which also names the host.
	 */
	action?: { label: string; ariaLabel?: string; onClick: () => void };
}

/**
 * One non-image entry in a tool result's attachment strip — a PDF a read
 * delivered, an image that could not be shown — and a Markdown image that could
 * not be, or that waits for the reader to load it (docs/markdown-images-ui.md).
 *
 * Not `FileStateCard`, which is a centred full-width empty state written for a
 * screen with nothing else on it. A chat message is not that screen — this sits
 * inside a bubble, next to the tool call that produced it, at the weight of a
 * line rather than a page.
 */
function AttachmentChip({
	icon: Icon,
	iconClassName = "text-th-text-muted",
	title,
	detail,
	wrapDetail = false,
	tooltip,
	action,
}: Props) {
	return (
		// Spans throughout: a Markdown image's stands in a paragraph, which may
		// not hold a <div>.
		//
		// Its own type sizes rather than the surrounding text's: inside a user
		// bubble that text is the message, and an entry at the message's size
		// competes with it — and outgrows the composer's entry for the same file.
		<span className="flex w-56 shrink-0 items-center gap-2 rounded-lg border border-th-border bg-th-bg-secondary p-2">
			<Icon className={`size-5 shrink-0 ${iconClassName}`} aria-hidden="true" />
			<span className="min-w-0 flex-1 text-sm">
				<span
					className="block truncate text-th-text-primary"
					title={tooltip ?? title}
				>
					{title}
				</span>
				<span
					className={`block text-xs text-th-text-muted ${wrapDetail ? "[overflow-wrap:anywhere]" : "truncate"}`}
				>
					{detail}
				</span>
			</span>
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					aria-label={action.ariaLabel}
					className="min-h-[36px] shrink-0 rounded px-2 text-sm text-th-accent pointer-coarse:min-h-11 hover:bg-th-overlay-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					{action.label}
				</button>
			)}
		</span>
	);
}

export default AttachmentChip;
