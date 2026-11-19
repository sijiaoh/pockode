import { Loader2, Trash2 } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { isUnfollowable, linkPageCopy } from "../../lib/symlink";
import type { LinkResult } from "../../types/contents";
import { EntryIcon } from "./EntryIcon";

interface Props {
	link: LinkResult;
	onDelete: () => void;
	deleting: boolean;
}

const actionClass =
	"inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-th-bg-tertiary px-3 text-sm text-th-text-primary transition-colors hover:bg-th-bg-secondary pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:opacity-50";

/**
 * What the viewer shows for a link that cannot be followed: the link itself.
 * An answer, not an error — a broken link is an ordinary thing to find in a
 * checkout — so it is never drawn as a failure (docs/symlinks.md#viewer).
 */
function LinkPage({ link, onDelete, deleting }: Props) {
	const { state: copyState, copy } = useCopyToClipboard({
		resetAfterMs: 2000,
	});
	const { state } = link.link;
	// The server sends a link result only for these; an `ok` one would be a
	// file or a listing. Said generically rather than thrown, should that ever
	// change: a link page is never a reason for the pane to fail.
	const words = isUnfollowable(state)
		? linkPageCopy(state)
		: { title: "Symbolic link", explanation: "" };

	return (
		<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
			<EntryIcon
				type="link"
				link={link.link}
				className="h-8 w-8 text-th-text-muted"
			/>
			<h2 className="text-sm text-th-text-primary">{words.title}</h2>
			<div className="w-full max-w-sm rounded-lg border border-th-border bg-th-bg-secondary px-3 py-2 text-left">
				<div className="text-xs text-th-text-muted">Points to</div>
				{/* Selectable as it stands, for a browser with no clipboard API. */}
				<code className="block select-text break-all font-mono text-sm text-th-text-secondary">
					{link.link.target}
				</code>
			</div>
			{words.explanation && (
				<p className="max-w-sm text-sm text-th-text-muted">
					{words.explanation}
				</p>
			)}
			<div className="flex flex-wrap justify-center gap-2">
				<button
					type="button"
					onClick={() => void copy(link.link.target)}
					className={actionClass}
				>
					{copyState === "copied"
						? "Copied"
						: copyState === "failed"
							? "Couldn't copy"
							: "Copy target"}
				</button>
				<button
					type="button"
					onClick={onDelete}
					disabled={deleting}
					className={`${actionClass} text-th-error`}
				>
					{deleting ? (
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
					) : (
						<Trash2 className="h-4 w-4" aria-hidden="true" />
					)}
					Delete link
				</button>
			</div>
		</div>
	);
}

export default LinkPage;
