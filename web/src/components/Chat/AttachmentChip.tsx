import type { LucideIcon } from "lucide-react";

interface Props {
	icon: LucideIcon;
	iconClassName?: string;
	title: string;
	/** The line under the name: type, size, or why there is nothing to show. */
	detail: string;
	/**
	 * What the name stands for, when it is a shortening of something — the file
	 * an agent named by its absolute path. It is the only place that path is
	 * readable: a chat bubble has no room for one, and truncating it in the row
	 * would cut off the end, which is the half that identifies the file.
	 */
	tooltip?: string;
	/** Absent leaves the entry inert, which is right when there is nothing to do. */
	action?: { label: string; onClick: () => void };
}

/**
 * One non-image entry in a tool result's attachment strip: a PDF a read
 * delivered, an image that could not be shown.
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
	tooltip,
	action,
}: Props) {
	return (
		<div className="flex w-56 shrink-0 items-center gap-2 rounded-lg border border-th-border bg-th-bg-secondary p-2">
			<Icon className={`size-5 shrink-0 ${iconClassName}`} aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<div className="truncate text-th-text-primary" title={tooltip ?? title}>
					{title}
				</div>
				<div className="truncate text-th-text-muted">{detail}</div>
			</div>
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					className="min-h-[36px] shrink-0 rounded px-2 text-th-accent pointer-coarse:min-h-11 hover:bg-th-overlay-hover"
				>
					{action.label}
				</button>
			)}
		</div>
	);
}

export default AttachmentChip;
