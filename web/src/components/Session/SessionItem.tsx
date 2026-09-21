import { GitBranch } from "lucide-react";
import { memo } from "react";
import { isWorkActive, sessionActivity } from "../../lib/activity";
import {
	selectSessionTitle,
	UNLISTED_SESSION_NAME,
	useSessionStore,
} from "../../lib/sessionStore";
import { useWorkStore } from "../../lib/workStore";
import type { SessionListItem } from "../../types/message";
import DeleteButton from "../common/DeleteButton";
import SidebarListItem from "../common/SidebarListItem";

function formatDate(dateString: string): string {
	const date = new Date(dateString);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	if (isToday) {
		return date.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
		});
	}
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

interface Props {
	session: SessionListItem;
	isActive: boolean;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
}

const SessionItem = memo(function SessionItem({
	session,
	isActive,
	onSelect,
	onDelete,
}: Props) {
	const forkedFrom = session.forked_from?.session_id;
	// Resolved against the list rather than copied onto the fork, so a rename
	// shows through. A parent with no row is not necessarily gone — what may be
	// said about it is `UNLISTED_SESSION_NAME`'s call, not this row's.
	const parentTitle = useSessionStore((s) =>
		forkedFrom ? selectSessionTitle(forkedFrom)(s) : null,
	);

	// The row names its own work, so this looks the item up by id rather than
	// scanning the list for one that names this session: which sessions belong to
	// work is the server's answer now, and the list is only asked what the item
	// is waiting for (docs/code/subscription-system.md#which-sessions-belong-to-work).
	const workId = session.work_id;
	const work = useWorkStore((s) =>
		workId ? s.works.find((w) => w.id === workId) : undefined,
	);
	const activity = sessionActivity(session.turn, work);
	// Only a work the engine is still driving has anything to lose by this.
	const stoppedWorkTitle =
		work && isWorkActive(work.status) ? work.title : undefined;

	return (
		<SidebarListItem
			// A glyph, not a tree: the list is sorted by recency and scanned
			// top-down, and nesting would fight that sort while having to answer for
			// forks of forks and for parents that are gone. It answers the only
			// question the list is asked — why two rows look alike.
			title={
				forkedFrom ? (
					<>
						{session.title}
						{/* Said in words for a screen reader, next to the title rather
						    than as the row's aria-label, which would replace the whole
						    name and take the row's own state indicator down with it. */}
						<span className="sr-only">
							, forked from {parentTitle ?? UNLISTED_SESSION_NAME}
						</span>
					</>
				) : (
					session.title
				)
			}
			leftSlot={
				forkedFrom ? (
					<GitBranch
						className="size-3 shrink-0 text-th-text-muted"
						aria-hidden="true"
					/>
				) : undefined
			}
			subtitle={formatDate(session.updated_at)}
			isActive={isActive}
			unread={session.unread}
			activity={activity}
			unansweredQuestions={session.unanswered_questions}
			onSelect={() => onSelect(session.id)}
			actions={
				<DeleteButton
					itemName={session.title}
					itemType="session"
					onDelete={() => onDelete(session.id)}
					// A session delete stops the work bound to it — the place an
					// answer would have gone is the thing being removed. Saying so
					// is the difference between a destructive action and a silent
					// one (docs/lifecycle-ui.md §8).
					confirmMessage={
						stoppedWorkTitle
							? `Are you sure you want to delete "${session.title}"? The work "${stoppedWorkTitle}" will stop. This action cannot be undone.`
							: `Are you sure you want to delete "${session.title}"? This action cannot be undone.`
					}
				/>
			}
		/>
	);
});

export default SessionItem;
