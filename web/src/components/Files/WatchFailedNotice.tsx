import type { CSSProperties } from "react";

interface Props {
	error: Error;
	onRetry: () => void;
	/** Lines it up under a tree row; see FileTreeNode. */
	style?: CSSProperties;
}

/**
 * Said where a view of the files has stopped following them, so a listing or
 * a file left as it was reads as stale rather than as current.
 */
export default function WatchFailedNotice({ error, onRetry, style }: Props) {
	return (
		<output
			className="flex flex-wrap items-center gap-x-2 py-1 pr-2 text-xs text-th-text-muted"
			style={style}
		>
			<span className="min-w-0 break-words">Not updating: {error.message}</span>
			<button
				type="button"
				onClick={onRetry}
				className="inline-flex min-h-9 items-center rounded px-2 text-th-accent hover:underline pointer-coarse:min-h-11 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			>
				Retry
			</button>
		</output>
	);
}
