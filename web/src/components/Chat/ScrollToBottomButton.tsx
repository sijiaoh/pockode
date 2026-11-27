import { ArrowDown } from "lucide-react";

interface Props {
	onClick: () => void;
	hasUnseen: boolean;
	/** What has arrived, for the button's name: "new messages", "new steps". */
	unseen: string;
}

/**
 * The scroll button of a transcript's track (`useTranscriptScroll`), drawn as
 * the track's last child.
 *
 * Sticky inside the column rather than absolute over the pane, so it centres
 * on the column by construction — the pane also holds the scrollbar, which the
 * column is centred without. Zero height, so it adds nothing to the content
 * the resize observer measures.
 *
 * Centred rather than in the corner: the right-hand column is where a row
 * keeps the facts it is read for — counts, elapsed, copy, Open — and there the
 * button covered the only number on the line, while in the middle it covers
 * prose that reads around it.
 */
function ScrollToBottomButton({ onClick, hasUnseen, unseen }: Props) {
	return (
		// `z-3`: over an open row's bar (`row-bar`, z-index 2, or 3 while
		// focused — this comes later, so it still wins), which passes under the
		// button whenever an open row's first line is at the bottom of the view.
		<div className="pointer-events-none sticky bottom-3 z-3 h-0">
			<div className="absolute inset-x-0 bottom-0 flex justify-center">
				<button
					type="button"
					onClick={onClick}
					className="touch-target pointer-events-auto flex h-8 w-11 items-center justify-center rounded-full border border-th-border bg-th-bg-primary text-th-text-secondary shadow-lg transition-colors hover:bg-th-bg-secondary hover:text-th-text-primary"
					aria-label={
						hasUnseen ? `Scroll to bottom, ${unseen}` : "Scroll to bottom"
					}
				>
					<ArrowDown className="size-4" aria-hidden="true" />
					{hasUnseen && (
						<span
							data-testid="unseen-dot"
							className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-th-accent ring-2 ring-th-bg-primary"
							aria-hidden="true"
						/>
					)}
				</button>
			</div>
		</div>
	);
}
export default ScrollToBottomButton;
