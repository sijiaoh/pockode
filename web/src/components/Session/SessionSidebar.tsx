import {
	FolderOpen,
	GitCompare,
	ListChecks,
	MessageSquare,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useSessionStore } from "../../lib/sessionStore";
import { FilesTab } from "../Files";
import { DiffTab } from "../Git";
import { TabbedSidebar, type TabConfig } from "../Layout";
import { ProjectTab } from "../Project";
import { WorktreeSwitcher } from "../Worktree";
import SessionsTab from "./SessionsTab";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	currentSessionId: string | null;
	onSelectSession: (id: string) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string) => void;
	onSelectDiffFile: (path: string, staged: boolean) => void;
	activeDiffFile: { path: string; staged: boolean } | null;
	onSelectCommit: (hash: string) => void;
	activeCommitHash: string | null;
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
	onOpenWorkList: () => void;
	onOpenAgentRoleList: () => void;
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
	activeDiffFile,
	onSelectCommit,
	activeCommitHash,
	onSelectFile,
	activeFilePath,
	onOpenWorkList,
	onOpenAgentRoleList,
	isDesktop,
}: Props) {
	const hasAnyUnread = useSessionStore((s) =>
		s.sessions.some((sess) => sess.unread),
	);

	const tabs: TabConfig[] = useMemo(
		() => [
			{
				id: "sessions",
				label: "Sessions",
				icon: MessageSquare,
				showBadge: hasAnyUnread,
			},
			{ id: "files", label: "Files", icon: FolderOpen },
			{ id: "git", label: "Git", icon: GitCompare },
			{ id: "project", label: "Project", icon: ListChecks },
		],
		[hasAnyUnread],
	);

	const handleSelectSession = useCallback(
		(id: string) => {
			onSelectSession(id);
			if (!isDesktop) onClose();
		},
		[onSelectSession, isDesktop, onClose],
	);

	const handleSelectDiffFile = useCallback(
		(path: string, staged: boolean) => {
			onSelectDiffFile(path, staged);
			if (!isDesktop) onClose();
		},
		[onSelectDiffFile, isDesktop, onClose],
	);

	const handleSelectCommit = useCallback(
		(hash: string) => {
			onSelectCommit(hash);
			if (!isDesktop) onClose();
		},
		[onSelectCommit, isDesktop, onClose],
	);

	const handleSelectFile = useCallback(
		(path: string) => {
			onSelectFile(path);
			if (!isDesktop) onClose();
		},
		[onSelectFile, isDesktop, onClose],
	);

	return (
		<TabbedSidebar
			isOpen={isOpen}
			onClose={onClose}
			tabs={tabs}
			defaultTab="sessions"
			isDesktop={isDesktop}
			renderHeader={({ onClose, isDesktop }) => (
				<WorktreeSwitcher onClose={onClose} isDesktop={isDesktop} />
			)}
		>
			<SessionsTab
				currentSessionId={currentSessionId}
				onSelectSession={handleSelectSession}
				onCreateSession={onCreateSession}
				onDeleteSession={onDeleteSession}
			/>
			<FilesTab
				onSelectFile={handleSelectFile}
				activeFilePath={activeFilePath}
			/>
			<DiffTab
				onSelectFile={handleSelectDiffFile}
				onSelectCommit={handleSelectCommit}
				activeFile={activeDiffFile}
				activeCommitHash={activeCommitHash}
			/>
			<ProjectTab
				onOpenWorkList={onOpenWorkList}
				onOpenAgentRoleList={onOpenAgentRoleList}
			/>
		</TabbedSidebar>
	);
}

export default SessionSidebar;
