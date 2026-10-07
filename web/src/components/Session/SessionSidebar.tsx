import { useQueryClient } from "@tanstack/react-query";
import {
	FolderOpen,
	GitCompare,
	ListChecks,
	MessageSquare,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { invalidateGitQueries } from "../../hooks/gitQueries";
import { useGitChangeCount } from "../../hooks/useGitChangeCount";
import { useGitWatch } from "../../hooks/useGitWatch";
import { useSidebarAttention } from "../../hooks/useSidebarAttention";
import { useSidebarUIConfig } from "../../lib/registries/sidebarUIRegistry";
import { SidebarContainerContext } from "../../lib/sidebarContainerContext";
import { useHasUnfinishedUploads } from "../../lib/uploadStore";
import { useIsGitRepo } from "../../lib/worktreeStore";
import { FilesTab } from "../Files";
import { DiffTab } from "../Git";
import { Sidebar, TabbedSidebar, type TabConfig } from "../Layout";
import { ProjectTab } from "../Project";
import { formatBadgeCount } from "../ui";
import { WorktreeSwitcher } from "../Worktree";
import SessionsTab from "./SessionsTab";

interface Props {
	isOpen: boolean;
	onClose: () => void;
	currentSessionId: string | null;
	/**
	 * Both take the worktree the row's session is read from, and null for this
	 * worktree's own — which is every row until the sidebar filter spans
	 * worktrees (see `SessionItem`).
	 */
	onSelectSession: (id: string, worktree: string | null) => void;
	onCreateSession: () => void;
	onDeleteSession: (id: string, worktree: string | null) => void;
	onSelectDiffFile: (path: string, staged: boolean) => void;
	/** Closes the content area when the diff it shows is discarded away. */
	onCloseDiffFile: () => void;
	activeDiffFile: { path: string; staged: boolean } | null;
	onSelectCommit: (hash: string) => void;
	activeCommitHash: string | null;
	onSelectFile: (path: string) => void;
	activeFilePath: string | null;
	/** Whether that file is open in the editor rather than the viewer. */
	activeFileEdit: boolean;
	/**
	 * Re-points the content area when the file it shows is renamed from the
	 * tree. Deliberately not routed through `handleSelectFile` below: a rename
	 * is not a tap on a row, and must not close the drawer.
	 */
	onRepointFile: (path: string) => void;
	/** Closes the content area when the file it shows is deleted from the tree. */
	onCloseFile: () => void;
	onOpenWorkList: () => void;
	onOpenAgentRoleList: () => void;
	isExpanded: boolean;
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
	onCloseDiffFile,
	activeDiffFile,
	onSelectCommit,
	activeCommitHash,
	onSelectFile,
	activeFilePath,
	activeFileEdit,
	onRepointFile,
	onCloseFile,
	onOpenWorkList,
	onOpenAgentRoleList,
	isExpanded,
	isSwitchingWorktree,
}: Props) {
	const { SidebarContent } = useSidebarUIConfig();
	// The same bits light the dot on the header button that brings the sidebar
	// back, so a badge out of sight behind a closed drawer or a collapsed column
	// is still seen from outside. `worksNeedAttention` also lights the dot inside
	// the Project tab, which is what makes the two agree (see `ProjectTab`).
	const { sessionsUnread, uploadActivity, worksNeedAttention } =
		useSidebarAttention();
	// Narrower than the badge, and deliberately so — see `handleSelectFile`.
	const hasUnfinishedUploads = useHasUnfinishedUploads();
	// Only a confirmed repository gets the Git tab: while the answer is pending
	// a project without one would see the tab appear and vanish again.
	const isGitRepo = useIsGitRepo() === true;

	// The watcher belongs to the sidebar, not to the Git tab: it feeds the tab's
	// count badge, which has to keep up while another tab is on top. Each term
	// below closes a case where nobody is left to read the number — including the
	// one easily dropped, a diff still open behind a drawer the tap closed.
	// `isOpen` is whether the sidebar is on screen in either tier, so a collapsed
	// column stops watching exactly as a closed drawer does.
	// See docs/git-ui.md, *Who subscribes to `git.changed`*.
	const queryClient = useQueryClient();
	const refreshGit = useCallback(
		() => invalidateGitQueries(queryClient),
		[queryClient],
	);
	useGitWatch({
		onChanged: refreshGit,
		enabled: isGitRepo && !SidebarContent && (isOpen || !!activeDiffFile),
	});

	const gitChangeCount = useGitChangeCount();
	// Left out below 1 change: the badge does not show a "0", and neither should
	// the label a screen reader speaks in its place.
	const gitCountBadge = useMemo(
		() =>
			gitChangeCount
				? {
						value: gitChangeCount,
						label: `${formatBadgeCount(gitChangeCount)} changed ${
							gitChangeCount === 1 ? "file" : "files"
						}`,
					}
				: undefined,
		[gitChangeCount],
	);

	const tabs: TabConfig[] = useMemo(
		() => [
			{
				id: "sessions",
				label: "Sessions",
				icon: MessageSquare,
				showBadge: sessionsUnread,
			},
			{
				id: "files",
				label: "Files",
				icon: FolderOpen,
				showBadge: uploadActivity,
			},
			...(isGitRepo
				? [
						{
							id: "git",
							label: "Git",
							icon: GitCompare,
							countBadge: gitCountBadge,
						},
					]
				: []),
			{
				id: "project",
				label: "Project",
				icon: ListChecks,
				showBadge: worksNeedAttention,
				// Not the other tabs' "there is news here": this one means a person
				// is being waited on, and it wears the same hue as the dot it stands
				// for inside the tab (docs/lifecycle-ui.md §4).
				badgeTone: "attention",
			},
		],
		[
			sessionsUnread,
			uploadActivity,
			isGitRepo,
			gitCountBadge,
			worksNeedAttention,
		],
	);

	const handleSelectSession = useCallback(
		(id: string, worktree: string | null) => {
			onSelectSession(id, worktree);
			if (!isExpanded) onClose();
		},
		[onSelectSession, isExpanded, onClose],
	);

	const handleSelectDiffFile = useCallback(
		(path: string, staged: boolean) => {
			onSelectDiffFile(path, staged);
			if (!isExpanded) onClose();
		},
		[onSelectDiffFile, isExpanded, onClose],
	);

	const handleSelectCommit = useCallback(
		(hash: string) => {
			onSelectCommit(hash);
			if (!isExpanded) onClose();
		},
		[onSelectCommit, isExpanded, onClose],
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
			if (!isExpanded && !hasUnfinishedUploads) onClose();
		},
		[onSelectFile, isExpanded, onClose, hasUnfinishedUploads],
	);

	const containerContext = useMemo(
		() => ({ isOpen, onClose, isExpanded }),
		[isOpen, onClose, isExpanded],
	);

	if (SidebarContent) {
		return (
			<SidebarContainerContext.Provider value={containerContext}>
				<Sidebar isOpen={isOpen} onClose={onClose} isExpanded={isExpanded}>
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
			isExpanded={isExpanded}
			renderHeader={({ onClose, isExpanded }) => (
				<WorktreeSwitcher onClose={onClose} isExpanded={isExpanded} />
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
				activeFileEdit={activeFileEdit}
				onRepointFile={onRepointFile}
				onCloseFile={onCloseFile}
			/>
			{isGitRepo && (
				<DiffTab
					onSelectFile={handleSelectDiffFile}
					onSelectCommit={handleSelectCommit}
					onCloseFile={onCloseDiffFile}
					activeFile={activeDiffFile}
					activeCommitHash={activeCommitHash}
				/>
			)}
			<ProjectTab
				onOpenWorkList={onOpenWorkList}
				onOpenAgentRoleList={onOpenAgentRoleList}
			/>
		</TabbedSidebar>
	);
}

export default SessionSidebar;
