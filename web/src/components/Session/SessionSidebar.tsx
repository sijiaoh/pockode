import { useQueryClient } from "@tanstack/react-query";
import {
	FolderOpen,
	GitCompare,
	ListChecks,
	MessageSquare,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { invalidateGitQueries } from "../../hooks/gitQueries";
import {
	describeChangeCount,
	useGitChangeCount,
} from "../../hooks/useGitChangeCount";
import { useGitWatch } from "../../hooks/useGitWatch";
import { useSidebarAttention } from "../../hooks/useSidebarAttention";
import { useSidebarUIConfig } from "../../lib/registries/sidebarUIRegistry";
import { SidebarContainerContext } from "../../lib/sidebarContainerContext";
import { useHasUnfinishedUploads } from "../../lib/uploadStore";
import { useIsGitRepo } from "../../lib/worktreeStore";
import type { GitLayer, GitSegment } from "../../types/overlay";
import { FilesTab } from "../Files";
import { GitTab } from "../Git";
import type { GitNavigation } from "../Git/GitTab";
import { Sidebar, TabbedSidebar, type TabConfig } from "../Layout";
import { ProjectTab } from "../Project";
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
	/** The Git layer the route names, and null when it names none. */
	gitLayer: GitLayer | null;
	gitNavigation: GitNavigation;
	/** See `GitTab`'s `onListShownChange`. Must be stable. */
	onGitListShownChange?: (shown: boolean) => void;
	/**
	 * Whether the chat's strip may show its review row, which reads the same
	 * count as the tab's badge. Reported by the chat, which owns the gate.
	 */
	reviewRowCanShow?: boolean;
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
	onOpenScheduleList: () => void;
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
	gitLayer,
	gitNavigation,
	onGitListShownChange,
	reviewRowCanShow = false,
	onSelectFile,
	activeFilePath,
	activeFileEdit,
	onRepointFile,
	onCloseFile,
	onOpenWorkList,
	onOpenScheduleList,
	onOpenAgentRoleList,
	isExpanded,
	isSwitchingWorktree,
}: Props) {
	const { SidebarContent } = useSidebarUIConfig();
	// The same bits light the dot on the header button that brings the sidebar
	// back, so a badge out of sight behind a closed drawer or a collapsed column
	// is still seen from outside. `projectNeedsAttention` is the OR of the two
	// dots inside the Project tab, which is what makes them agree (see
	// `ProjectTab`).
	const { sessionsUnread, uploadActivity, projectNeedsAttention } =
		useSidebarAttention();
	// Narrower than the badge, and deliberately so — see `handleSelectFile`.
	const hasUnfinishedUploads = useHasUnfinishedUploads();
	// Only a confirmed repository gets the Git tab: while the answer is pending
	// a project without one would see the tab appear and vanish again.
	const isGitRepo = useIsGitRepo() === true;

	// The watcher belongs to the sidebar, not to the Git tab: it feeds the tab's
	// count badge, which has to keep up while another tab is on top. Each term
	// below closes a case where nobody is left to read the number. `isOpen` is
	// whether the sidebar is on screen in either tier, so a collapsed column
	// stops watching exactly as a closed drawer does — and an extension's
	// sidebar has no badge to feed. The Git workspace is read whatever sidebar
	// is beside it, open or not, so it is watched on its own term: without it
	// its lists would freeze under the reader. The chat's review row reads the
	// count too, on a phone with the drawer closed, and is on its own term for
	// the same reason; it is only true while no turn is open, so a turn ending
	// resubscribes and refetches at the moment the row may appear.
	// See docs/git-ui.md, *Who subscribes to `git.changed`*.
	const queryClient = useQueryClient();
	const refreshGit = useCallback(
		() => invalidateGitQueries(queryClient),
		[queryClient],
	);
	useGitWatch({
		onChanged: refreshGit,
		enabled:
			isGitRepo &&
			((!SidebarContent && isOpen) || gitLayer !== null || reviewRowCanShow),
	});

	const gitChangeCount = useGitChangeCount();
	// Left out below 1 change: the badge does not show a "0", and neither should
	// the label a screen reader speaks in its place.
	const gitCountBadge = useMemo(
		() =>
			gitChangeCount
				? {
						value: gitChangeCount,
						label: describeChangeCount(gitChangeCount),
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
				showBadge: projectNeedsAttention,
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
			projectNeedsAttention,
		],
	);

	// At `expanded` a Git route is this tab beside the main area — the chat
	// for a list URL, a detail for a layer — so arriving at one turns to the
	// tab, whatever made the arrival (the chat's review row, a link, Back):
	// without it a list URL shows nothing of Git, and a detail's lit row is off
	// screen. Arriving is coming to Git at all, or opening a detail from a list
	// URL, which is the chat. Moving between details, or leaving one for the
	// chat, is not: the user may have turned elsewhere since, and is not pulled
	// back. Waits for the repository to be confirmed, since a link opened on
	// load arrives before the tab does.
	const gitPlace =
		isGitRepo && isExpanded && gitLayer
			? gitLayer.type === "git"
				? "list"
				: "detail"
			: null;
	const [gitArrival, setGitArrival] = useState({
		place: gitPlace,
		count: gitPlace ? 1 : 0,
	});
	if (gitPlace !== gitArrival.place) {
		const arrives =
			gitPlace !== null && (gitArrival.place === null || gitPlace === "detail");
		setGitArrival({
			place: gitPlace,
			count: gitArrival.count + (arrives ? 1 : 0),
		});
	}
	const gitReveal =
		gitArrival.count > 0 ? { tab: "git", request: gitArrival.count } : null;

	const handleSelectSession = useCallback(
		(id: string, worktree: string | null) => {
			onSelectSession(id, worktree);
			if (!isExpanded) onClose();
		},
		[onSelectSession, isExpanded, onClose],
	);

	// Below `expanded` the tab's doors lead to a page under the drawer, which
	// closes for it; at `expanded` the list stays where it is beside what a
	// row opens.
	const tabGitNavigation = useMemo(
		() =>
			isExpanded
				? gitNavigation
				: {
						...gitNavigation,
						onSelectSegment: (segment: GitSegment) => {
							gitNavigation.onSelectSegment(segment);
							onClose();
						},
					},
		[gitNavigation, isExpanded, onClose],
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
			reveal={gitReveal}
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
				<GitTab
					isExpanded={isExpanded}
					isOpen={isOpen}
					layer={gitLayer}
					navigation={tabGitNavigation}
					onListShownChange={onGitListShownChange}
				/>
			)}
			<ProjectTab
				onOpenWorkList={onOpenWorkList}
				onOpenScheduleList={onOpenScheduleList}
				onOpenAgentRoleList={onOpenAgentRoleList}
			/>
		</TabbedSidebar>
	);
}

export default SessionSidebar;
