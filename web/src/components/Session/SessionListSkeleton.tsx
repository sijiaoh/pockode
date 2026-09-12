const ROW_DELAYS = ["", "[animation-delay:120ms]", "[animation-delay:240ms]"];

/**
 * Placeholder for the session list while it belongs to a worktree the user has
 * already left. Row height matches `SessionItem` so the list doesn't jump.
 *
 * Deliberately silent to assistive technology: the same switch already puts
 * `ChatSkeleton`'s live region on screen, and two regions announcing one
 * transition talk over each other.
 */
function SessionListSkeleton() {
	return (
		<div className="flex flex-col gap-1 p-2" aria-hidden="true">
			{ROW_DELAYS.map((delay) => (
				<div
					key={delay}
					className={`h-14 animate-pulse rounded-lg bg-th-text-muted/20 ${delay}`}
				/>
			))}
		</div>
	);
}

export default SessionListSkeleton;
