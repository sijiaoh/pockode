import { GitCompare, MessageSquare } from "lucide-react";
import { DiffTab } from "../Git";
import { TabbedSidebar, type TabConfig } from "../Layout";
import SessionsTab from "./SessionsTab";

const TABS: TabConfig[] = [
	{ id: "sessions", label: "Sessions", icon: MessageSquare },
	{ id: "diff", label: "Diff", icon: GitCompare },
];

interface Props {
	isOpen: boolean;
	onClose: () => void;
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
	onSelectDiffFile: (path: string, staged: boolean) => void;
	activeFile: { path: string; staged: boolean } | null;
	isDesktop: boolean;
}

function SessionSidebar({
	isOpen,
	onClose,
	currentSessionId,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
	onSelectDiffFile,
	activeFile,
	isDesktop,
}: Props) {
	const handleSelectSession = (id: string) => {
		onSelectSession(id);
		if (!isDesktop) onClose();
	};

	const handleSelectFile = (path: string, staged: boolean) => {
		onSelectDiffFile(path, staged);
		if (!isDesktop) onClose();
	};

	return (
		<TabbedSidebar
			isOpen={isOpen}
			onClose={onClose}
			title="Pockode"
			tabs={TABS}
			defaultTab="sessions"
			isDesktop={isDesktop}
		>
			<SessionsTab
				currentSessionId={currentSessionId}
				onSelectSession={handleSelectSession}
				onCreateSession={onCreateSession}
				onDeleteSession={onDeleteSession}
			/>
			<DiffTab onSelectFile={handleSelectFile} activeFile={activeFile} />
		</TabbedSidebar>
	);
}

export default SessionSidebar;
