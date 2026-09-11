import { GitBranch } from "lucide-react";
import { memo } from "react";
import { useSessionStore } from "../../lib/sessionStore";
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
	// shows through and a parent that is gone reads as gone.
	const parentTitle = useSessionStore((s) =>
		forkedFrom ? s.sessions.find((x) => x.id === forkedFrom)?.title : undefined,
	);

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
						    name and take "AI responding" down with it. */}
						<span className="sr-only">
							, forked from {parentTitle ?? "a deleted session"}
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
			hasChanges={session.unread}
			needsInput={session.needs_input}
			isRunning={session.state === "running"}
			onSelect={() => onSelect(session.id)}
			actions={
				<DeleteButton
					itemName={session.title}
					itemType="session"
					onDelete={() => onDelete(session.id)}
					confirmMessage={`Are you sure you want to delete "${session.title}"? This action cannot be undone.`}
				/>
			}
		/>
	);
});

export default SessionItem;
