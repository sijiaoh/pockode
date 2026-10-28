import { useId, useState } from "react";
import { useGitStatus } from "../../hooks/useGitStatus";
import { describeCommitAction } from "../../types/git";
import { BottomActionBar } from "../ui";
import GitCommitSheet from "./GitCommitSheet";

interface Props {
	/**
	 * Throws away every unstaged change, after a confirmation the caller owns;
	 * null when nothing is unstaged — every file already checked.
	 */
	discardUnchecked: { onDiscard: () => void; busy: boolean } | null;
}

/**
 * The Changes list's fixed bottom row for as long as there is something to
 * commit or something on its way to being committed. Like the review's bar it
 * takes away on the left and keeps on the right, but for every file at once:
 * the checkboxes are the ballot, and what is left unchecked is discarded.
 *
 * It renders outside ChangesSection's loading/error branch, so the action stays
 * reachable however far the user has scrolled down the list.
 */
function CommitBar({ discardUnchecked }: Props) {
	const { data: status } = useGitStatus();
	const [isOpen, setIsOpen] = useState(false);
	const hintId = useId();
	const heldId = useId();
	// A press refused while busy: the reason stays up until the writes finish,
	// and does not come back by itself on the next write — busy flips on every
	// checkbox press, and a line that came and went with it would jolt the bar.
	const [refused, setRefused] = useState(false);
	const busy = discardUnchecked?.busy ?? false;
	if (refused && !busy) setRefused(false);

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
					{refused && (
						<span
							id={heldId}
							className="mb-1.5 block text-xs text-th-text-muted"
						>
							Wait for the changes in progress to finish.
						</span>
					)}
					{/* The review bar's gap, for the same reason: the button that takes
					    something away is not flush against the one pressed all day. */}
					<div className="flex gap-3">
						{discardUnchecked && (
							<button
								type="button"
								// The write queue drops a path it already holds, so a
								// discard now would skip those files and say nothing.
								// `aria-disabled` rather than `disabled`, as `MenuRow` does:
								// a press has to get through to be told why.
								onClick={
									busy ? () => setRefused(true) : discardUnchecked.onDiscard
								}
								aria-disabled={busy || undefined}
								aria-describedby={refused ? heldId : undefined}
								className={`flex min-h-[44px] max-w-[50%] shrink-0 items-center justify-center rounded-lg bg-th-bg-tertiary px-4 text-center text-sm leading-tight text-th-error transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent ${
									busy ? "cursor-not-allowed opacity-50" : "hover:opacity-90"
								}`}
							>
								{/* Wraps rather than truncates: at the sidebar's default width
								    the label is wider than its half of the bar, and two lines
								    still fit the button's height. Half, not the review's 40%,
								    which would make that three lines and a taller bar. */}
								Discard unchecked…
							</button>
						)}
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
