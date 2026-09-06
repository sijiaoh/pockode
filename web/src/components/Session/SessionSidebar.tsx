import {
	FolderOpen,
	GitCompare,
	ListChecks,
	MessageSquare,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useSession } from "../../hooks/useSession";
import { useSidebarUIConfig } from "../../lib/registries/sidebarUIRegistry";
import { SidebarContainerContext } from "../../lib/sidebarContainerContext";
import {
	useHasUnfinishedUploads,
	useHasUploadActivity,
} from "../../lib/uploadStore";
import { FilesTab } from "../Files";
import { DiffTab } from "../Git";
import { Sidebar, TabbedSidebar, type TabConfig } from "../Layout";
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
	/**
	 * The URL already points at another worktree while the store, and therefore
	 * the session list, still holds the previous one's.
	 */
	isSwitchingWorktree: boolean;
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
	isSwitchingWorktree,
}: Props) {
	const { hasAnyUnread } = useSession();
	const { SidebarContent } = useSidebarUIConfig();
	// The upload queue lives inside the Files tab and is hidden from every other
	// one, so this is the only sign an upload is still running or has failed.
	const hasUploadActivity = useHasUploadActivity();
	// Narrower than the badge, and deliberately so — see `handleSelectFile`.
	const hasUnfinishedUploads = useHasUnfinishedUploads();

	const tabs: TabConfig[] = useMemo(
		() => [
			{
				id: "sessions",
				label: "Sessions",
				icon: MessageSquare,
				showBadge: hasAnyUnread,
			},
			{
				id: "files",
				label: "Files",
				icon: FolderOpen,
				showBadge: hasUploadActivity,
			},
			{ id: "git", label: "Git", icon: GitCompare },
			{ id: "project", label: "Project", icon: ListChecks },
		],
		[hasAnyUnread, hasUploadActivity],
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
			// Closing the drawer on a phone takes the upload queue — and the tab bar
			// that badges it — off screen with it, leaving a running upload with
			// nothing to report to. The file still opens behind the drawer.
			//
			// Only while something is still running: a failure has already reported
			// and stays on the queue until it is dismissed, so waiting on that would
			// hold the drawer open on every file tapped from then on, with no moment
			// at which it starts closing again. The badge stays lit for it, which is
			// how the row is found once the file has been read.
			if (!isDesktop && !hasUnfinishedUploads) onClose();
		},
		[onSelectFile, isDesktop, onClose, hasUnfinishedUploads],
	);

	const containerContext = useMemo(
		() => ({ isOpen, onClose, isDesktop }),
		[isOpen, onClose, isDesktop],
	);

	if (SidebarContent) {
		return (
			<SidebarContainerContext.Provider value={containerContext}>
				<Sidebar isOpen={isOpen} onClose={onClose} isDesktop={isDesktop}>
					<SidebarContent />
				</Sidebar>
			</SidebarContainerContext.Provider>
		);
	}

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
				isSwitchingWorktree={isSwitchingWorktree}
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
