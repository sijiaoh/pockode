import { useId, useState } from "react";
import { useGitStatus } from "../../hooks/useGitStatus";
import { describeCommitAction } from "../../types/git";
import { BottomActionBar } from "../ui";
import GitCommitSheet from "./GitCommitSheet";

/**
 * The panel's fixed bottom row: one button, for as long as there is something to
 * commit or something on its way to being committed.
 *
 * It renders outside DiffTab's loading/error branch, so the action stays
 * reachable however far the user has scrolled into History.
 */
function CommitBar() {
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
					<button
						type="button"
						onClick={() => setIsOpen(true)}
						disabled={!action.enabled}
						aria-describedby={action.hint ? hintId : undefined}
						className="flex min-h-[44px] w-full items-center justify-center rounded-lg bg-th-accent text-sm font-medium text-th-accent-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{action.label}
					</button>
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
