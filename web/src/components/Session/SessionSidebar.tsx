import { useState } from "react";
import type { SessionMeta } from "../../types/message";
import { DiffSidebarContent } from "../Git";
import { Sidebar, SidebarTabs, type Tab } from "../Layout";
import SessionSidebarContent from "./SessionSidebarContent";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	sessions: SessionMeta[];
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
	onSelectDiffFile: (path: string, staged: boolean) => void;
	isLoading: boolean;
	activeFile: { path: string; staged: boolean } | null;
}

function SessionSidebar({
	isOpen,
	onClose,
	sessions,
	currentSessionId,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
	onSelectDiffFile,
	isLoading,
	activeFile,
}: Props) {
	const [activeTab, setActiveTab] = useState<Tab>("sessions");

	const handleSelectFile = (path: string, staged: boolean) => {
		onSelectDiffFile(path, staged);
		onClose();
	};

	return (
		<Sidebar isOpen={isOpen} onClose={onClose} title="Pockode">
			<SidebarTabs activeTab={activeTab} onTabChange={setActiveTab} />

			{activeTab === "sessions" && (
				<SessionSidebarContent
					sessions={sessions}
					currentSessionId={currentSessionId}
					onSelectSession={(id) => {
						onSelectSession(id);
						onClose();
					}}
					onCreateSession={onCreateSession}
					onDeleteSession={onDeleteSession}
					isLoading={isLoading}
				/>
			)}

			{activeTab === "diff" && (
				<DiffSidebarContent
					onSelectFile={handleSelectFile}
					activeFile={activeFile}
				/>
			)}
		</Sidebar>
	);
}

export default SessionSidebar;
