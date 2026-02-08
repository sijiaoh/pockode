import { memo } from "react";
import { useHasUnread } from "../../lib/unreadStore";
import type { SessionListItem } from "../../types/message";
import DeleteButton from "../common/DeleteButton";
import SidebarListItem from "../common/SidebarListItem";

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
	const hasUnread = useHasUnread(session.id);

	return (
		<SidebarListItem
			title={session.title}
			subtitle={new Date(session.created_at).toLocaleDateString()}
			isActive={isActive}
			hasChanges={hasUnread}
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
