import { memo } from "react";
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
	return (
		<SidebarListItem
			title={session.title}
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
