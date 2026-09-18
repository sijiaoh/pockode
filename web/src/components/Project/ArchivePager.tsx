import { ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
	/** Zero-based index of the page on screen; the indicator shows it plus one. */
	page: number;
	hasNewer: boolean;
	hasOlder: boolean;
	onNewer: () => void;
	onOlder: () => void;
}

/**
 * The archive's pager: a fixed row above the bottom bar, not a row at the end
 * of the list.
 *
 * A pager at the end of a twenty-row list is two flicks away from the thumb
 * that wants it, and it is furthest away exactly when the page is full — which
 * is always, except on the last one (docs/list-paging-ui.md §4.2).
 *
 * "Newer" and "Older" rather than "Previous" and "Next", because the archive is
 * sorted by time and every row already prints its own relative `updated_at`;
 * and the indicator says `Page 2`, never `Page 2 of 7` — a cursor knows where
 * it is and cannot know how far there is to go without counting a list it has
 * not read. There is no jump-to-page control for the same reason.
 *
 * Each button is disabled at its end of the list rather than removed, so the
 * row does not reflow as the user walks it. Only at its end: a button disabled
 * for the length of a request would throw the keyboard focus off itself
 * mid-walk, and a second press while one page is in flight is already ignored
 * by the fetch itself.
 */
function ArchivePager({ page, hasNewer, hasOlder, onNewer, onOlder }: Props) {
	return (
		<nav
			aria-label="Archive pages"
			className="flex items-center gap-2 border-t border-th-border bg-th-bg-secondary px-2 py-1"
		>
			<PagerButton disabled={!hasNewer} onClick={onNewer}>
				<ChevronLeft className="size-4" />
				Newer
			</PagerButton>
			<span
				aria-live="polite"
				className="flex-1 text-center text-sm text-th-text-muted tabular-nums"
			>
				Page {page + 1}
			</span>
			<PagerButton disabled={!hasOlder} onClick={onOlder}>
				Older
				<ChevronRight className="size-4" />
			</PagerButton>
		</nav>
	);
}

function PagerButton({
	disabled,
	onClick,
	children,
}: {
	disabled: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="flex min-h-[44px] min-w-[88px] items-center justify-center gap-1 rounded-lg px-3 text-sm text-th-text-primary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent disabled:text-th-text-muted disabled:opacity-40 disabled:hover:bg-transparent"
		>
			{children}
		</button>
	);
}

export default ArchivePager;
