import { useEffect, useRef } from "react";
import { Spinner } from "../ui";

/**
 * How far ahead of the viewport the next page is asked for: one screen, so the
 * rows are there by the time the thumb gets to them.
 */
const ROOT_MARGIN = "100% 0px";

interface Props {
	/** Whether the list has rows the client has not fetched. */
	hasMore: boolean;
	isLoading: boolean;
	/** Why the last page failed, and null when none has. */
	error: string | null;
	/** Whether this may fetch on its own; false after a failure. */
	autoLoad: boolean;
	/** Whether the user has actually paged at least once. */
	hasPaged: boolean;
	/**
	 * Re-armed on every change of this value. It is the row count: a page that
	 * landed without filling the viewport has to lead to the next one.
	 */
	loadedCount: number;
	onLoadMore: () => void;
}

/**
 * The end of the session list: what says there is more, fetches it, and says
 * when there is not.
 *
 * It is one button in every state, not a spinner with a button beside it.
 * Infinite scroll with no manual control is the part of this pattern that is
 * routinely inaccessible, and it costs one element to avoid — it is also the
 * only way on in the two states where the observer will not fire again by
 * itself: after a failure, and after a page that did not fill a tall viewport
 * (docs/list-paging-ui.md §3.1).
 *
 * The row's height is fixed rather than grown by its contents, so the spinner
 * appearing does not resize the list under the reader.
 */
function SessionListSentinel({
	hasMore,
	isLoading,
	error,
	autoLoad,
	hasPaged,
	loadedCount,
	onLoadMore,
}: Props) {
	const ref = useRef<HTMLButtonElement | null>(null);
	const onLoadMoreRef = useRef(onLoadMore);
	onLoadMoreRef.current = onLoadMore;

	// biome-ignore lint/correctness/useExhaustiveDependencies: loadedCount is an intentional trigger — a landed page is what re-arms the observer
	useEffect(() => {
		const sentinel = ref.current;
		if (!sentinel || !hasMore || !autoLoad) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				// One page per arming. Left watching, this reports every later
				// crossing too, each asking for a page nothing has judged the need
				// for. A page that lands re-arms it through `loadedCount`.
				observer.disconnect();
				onLoadMoreRef.current();
			},
			{ rootMargin: ROOT_MARGIN },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, autoLoad, loadedCount]);

	if (!hasMore) {
		// Only to someone who went looking: on a list that fitted in one page,
		// saying where it ends states the obvious.
		if (!hasPaged) return null;
		return (
			<p className="py-2 text-center text-th-text-muted text-xs">
				No earlier conversations
			</p>
		);
	}

	return (
		<div className="flex flex-col items-center">
			{error && (
				<p role="alert" className="px-2 py-1 text-center text-th-error text-xs">
					{error}
				</p>
			)}
			<button
				type="button"
				ref={ref}
				onClick={onLoadMore}
				className="flex h-14 w-full items-center justify-center rounded-lg text-th-text-muted text-sm transition-colors hover:text-th-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			>
				{isLoading ? (
					<Spinner
						variant="current"
						className="text-th-text-muted"
						srText="Loading earlier conversations"
					/>
				) : error ? (
					"Retry"
				) : (
					"Load earlier conversations"
				)}
			</button>
		</div>
	);
}

export default SessionListSentinel;
