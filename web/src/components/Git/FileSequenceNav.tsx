import { ChevronLeft, ChevronRight } from "lucide-react";
import { getActionIconButtonClass } from "../ui";

interface Props {
	onPrevious?: () => void;
	onNext?: () => void;
	/** Left out until the sequence is known. */
	count?: {
		/** Null for a file that is not in the sequence (any more). */
		position: number | null;
		total: number;
		/** Read out in place of the position when there is none. */
		absentLabel: string;
	};
}

/**
 * `‹ k / n ›`: the toolbar's navigation through a sequence of files — the
 * changes under review, the files of a commit. An end has its button disabled
 * rather than removed, so the other one does not move under the thumb.
 */
function FileSequenceNav({ onPrevious, onNext, count }: Props) {
	return (
		<>
			<button
				type="button"
				disabled={!onPrevious}
				onClick={onPrevious}
				className={getActionIconButtonClass(!!onPrevious)}
				aria-label="Previous file"
				title="Previous file"
			>
				<ChevronLeft className="h-4 w-4" aria-hidden="true" />
			</button>
			{count && (
				<span className="shrink-0 px-1 text-xs tabular-nums text-th-text-muted">
					<span aria-hidden="true">
						{count.position ?? "–"} / {count.total}
					</span>
					<span className="sr-only">
						{count.position
							? `File ${count.position} of ${count.total}`
							: count.absentLabel}
					</span>
				</span>
			)}
			<button
				type="button"
				disabled={!onNext}
				onClick={onNext}
				className={getActionIconButtonClass(!!onNext)}
				aria-label="Next file"
				title="Next file"
			>
				<ChevronRight className="h-4 w-4" aria-hidden="true" />
			</button>
		</>
	);
}

export default FileSequenceNav;
