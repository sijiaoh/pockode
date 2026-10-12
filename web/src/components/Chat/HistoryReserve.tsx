import type { Ref } from "react";

interface Props {
	ref?: Ref<HTMLDivElement>;
	/** Why the last page failed; the reserve then offers a retry. */
	error: string | null;
	onRetry: () => void;
}

/**
 * The space above the oldest loaded row while older history remains: what a
 * page lands into without moving the reader (`useTranscriptScroll`).
 *
 * It takes whatever height the track leaves it — anything from nothing to more
 * than a screen, changing under the reader's flick — so nothing inside it is
 * laid out in normal flow: the skeleton is a mask on a layer placed over it, and
 * the failure band is placed against its bottom edge, right above the oldest
 * row. Failing, retrying and loading therefore move nothing, and no amount of
 * shrinking clips the band: it rises past the top of the track instead, where
 * nobody can reach mid-flick anyway, and comes back when the track is put right
 * at rest.
 *
 * Loading is not announced: pages are fetched without the reader asking and
 * mostly land out of sight, so a live region would speak on every one. A
 * failure is, since it is the one thing that stops more history arriving.
 */
function HistoryReserve({ ref, error, onRetry }: Props) {
	return (
		<div
			ref={ref}
			data-testid="history-reserve"
			className="relative min-h-0 flex-1"
		>
			{/* Pulsing says more is on its way, which stops being true when a page
			    fails; held still and dimmed then. */}
			<div
				aria-hidden="true"
				className={`history-reserve-skeleton absolute inset-0 bg-th-text-muted/20 ${error ? "opacity-50" : "animate-pulse motion-reduce:animate-none"}`}
			/>
			{error && (
				<div className="absolute inset-x-0 bottom-0 bg-th-bg-primary py-2">
					<div
						role="alert"
						className="flex flex-wrap items-center justify-center gap-2 text-th-error text-xs"
					>
						<span>{error}</span>
						<button
							type="button"
							onClick={onRetry}
							className="touch-target rounded px-1 underline transition-colors hover:text-th-text-primary"
						>
							Retry
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

export default HistoryReserve;
