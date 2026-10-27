import { useId, useState } from "react";
import { useGitStatus } from "../../hooks/useGitStatus";
import { describeCommitAction } from "../../types/git";
import { BottomActionBar } from "../ui";
import GitCommitSheet from "./GitCommitSheet";

interface Props {
	/** Opens the review at the first file in list order. */
	onReview: () => void;
}

/**
 * The Changes list's fixed bottom row — `Review` and the commit button — for
 * as long as there is something to commit or something on its way to being
 * committed.
 *
 * It renders outside ChangesSection's loading/error branch, so the action stays
 * reachable however far the user has scrolled down the list.
 */
function CommitBar({ onReview }: Props) {
	const { data: status } = useGitStatus();
	const [isOpen, setIsOpen] = useState(false);
	const hintId = useId();

	const action = describeCommitAction(status);

	return (
		<>
			{/* The bar comes and goes with what is committable; the sheet does not.
			    Unmounting it along with the bar would throw away a half-written
			    message the moment a background refresh found the tree clean. */}
			{action && (
				<BottomActionBar>
					{/* Above the button, on the same rule the sheets follow: the bar
					    already sits at the bottom edge, so a line under the button is the
					    first thing an on-screen keyboard covers. */}
					{action.hint && (
						<span
							id={hintId}
							className={
								action.hint.alreadyOnScreen
									? "sr-only"
									: "mb-1.5 block text-xs text-th-text-muted"
							}
						>
							{action.hint.text}
						</span>
					)}
					<div className="flex gap-2">
						<button
							type="button"
							onClick={onReview}
							className="flex min-h-[44px] max-w-[33%] shrink-0 items-center justify-center rounded-lg bg-th-bg-tertiary px-4 text-sm text-th-text-primary transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
						>
							Review
						</button>
						<button
							type="button"
							onClick={() => setIsOpen(true)}
							disabled={!action.enabled}
							aria-describedby={action.hint ? hintId : undefined}
							className="flex min-h-[44px] min-w-0 flex-1 items-center justify-center rounded-lg bg-th-accent text-sm font-medium text-th-accent-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{action.label}
						</button>
					</div>
				</BottomActionBar>
			)}

			{isOpen && (
				<GitCommitSheet
					amendInitially={false}
					onClose={() => setIsOpen(false)}
				/>
			)}
		</>
	);
}

export default CommitBar;
