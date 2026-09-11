import { Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useChatMessages } from "../../hooks/useChatMessages";
import { SKELETON_DELAY_MS, useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useForkSession } from "../../hooks/useForkSession";
import { useForkSupport } from "../../hooks/useForkSupport";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { forkBlockedReason } from "../../lib/agentType";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import { useSessionStore } from "../../lib/sessionStore";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type {
	AskUserQuestionRequest,
	HistorySeq,
	PermissionRequest,
} from "../../types/message";
import type { OverlayState } from "../../types/overlay";
import { resolveForkAnchor } from "../../utils/forkAnchor";
import { buildForkTitle } from "../../utils/forkTitle";
import { formatStepProgress, getStepProgress } from "../../utils/workSteps";
import { FileEditor, FileView } from "../Files";
import { CommitDiffView, CommitView, DiffView } from "../Git";
import MainContainer from "../Layout/MainContainer";
import {
	AgentRoleDetailOverlay,
	AgentRoleListOverlay,
	WorkDetailOverlay,
	WorkListOverlay,
} from "../Project";
import { SettingsPage } from "../Settings";
import { statusDotStyles, statusLabels } from "../ui/StatusBadge";
import AgentSelector from "./AgentSelector";
import ChatSkeleton from "./ChatSkeleton";
import ForkSessionSheet from "./ForkSessionSheet";
import DefaultInputBar from "./InputBar";
import MessageList from "./MessageList";
import MessageMenu from "./MessageMenu";
import ModeSelector from "./ModeSelector";

const noop = () => {};

const inputBarHiddenOverlays: NonNullable<OverlayState>["type"][] = [
	"work-list",
	"work-detail",
	"agent-role-list",
	"agent-role-detail",
];

function isInputBarHidden(overlay: OverlayState | undefined): boolean {
	return !!overlay && inputBarHiddenOverlays.includes(overlay.type);
}

function LinkedWorkButton({
	sessionId,
	onOpenWorkDetail,
}: {
	sessionId: string;
	onOpenWorkDetail?: (workId: string) => void;
}) {
	const linkedWork = useWorkStore((s) =>
		s.works.find((w) => w.session_id === sessionId),
	);
	const role = useAgentRoleStore((s) =>
		s.roles.find((r) => r.id === linkedWork?.agent_role_id),
	);

	if (!linkedWork) return null;

	const progress = getStepProgress(linkedWork, role);
	// The dot carries the status by color alone, so the accessible name has to
	// spell it out. Commas rather than the visible "·": screen readers pause on a
	// comma and stumble over the dot.
	const label = [
		statusLabels[linkedWork.status],
		linkedWork.title,
		progress && formatStepProgress(progress),
	]
		.filter(Boolean)
		.join(", ");

	return (
		<button
			type="button"
			aria-label={label}
			onClick={() => onOpenWorkDetail?.(linkedWork.id)}
			className="flex min-w-0 items-center gap-1 rounded px-2 py-1 text-xs text-th-text-secondary transition-all hover:bg-th-bg-tertiary hover:text-th-text-primary active:scale-95"
		>
			{/* Never a spinner, even for in_progress: here a spinner means "the agent
			    is producing this turn", and a work whose process sits idle mid-step is
			    a normal resting state. See docs/code/work-system.md. */}
			<span
				className={`size-2 shrink-0 rounded-full ${statusDotStyles[linkedWork.status]}`}
			/>
			<span className="max-w-[120px] truncate">{linkedWork.title}</span>
			{progress && (
				<span className="shrink-0 text-th-text-muted">
					· {formatStepProgress(progress)}
				</span>
			)}
		</button>
	);
}

interface Props {
	/**
	 * Destination session id, taken from the URL. It is known before the session
	 * itself is, which is why it can be trusted while `isSessionResolved` is
	 * false. Empty when the route names no session.
	 */
	sessionId: string;
	sessionTitle: string;
	/**
	 * Whether `sessionId` has been found in the session list of the worktree the
	 * connection is bound to. Until then nothing about the session is known but
	 * its id, so the panel shows the destination as an empty shell rather than
	 * anything belonging to the session the user came from.
	 */
	isSessionResolved: boolean;
	onUpdateTitle: (title: string) => void;
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	overlay?: OverlayState;
	onCloseOverlay?: () => void;
	onNavigateToSession?: (sessionId: string, worktree: string) => void;
	/** Opens another session of this worktree, which a fork's parent and child both are. */
	onSelectSession?: (sessionId: string) => void;
	onOpenWorkDetail?: (workId: string) => void;
	onOpenWorkList?: () => void;
	onOpenAgentRoleList?: () => void;
	onOpenAgentRoleDetail?: (roleId: string) => void;
}

function ChatPanel({
	sessionId,
	sessionTitle,
	isSessionResolved,
	onUpdateTitle,
	onOpenSidebar,
	onOpenSettings,
	overlay,
	onCloseOverlay,
	onNavigateToSession,
	onSelectSession,
	onOpenWorkDetail,
	onOpenWorkList,
	onOpenAgentRoleList,
	onOpenAgentRoleDetail,
}: Props) {
	const projectTitle = useWSStore((state) => state.projectTitle);
	const {
		InputBar: CustomInputBar,
		ModeSelector: CustomModeSelector,
		AgentSelector: CustomAgentSelector,
		StopButton: CustomStopButton,
		ChatTopContent,
	} = useChatUIConfig();
	const InputBar = CustomInputBar ?? DefaultInputBar;

	const {
		messages,
		isLoadingHistory,
		isStreaming,
		isProcessRunning,
		mode,
		agentType,
		isSessionActivated,
		status,
		sendUserMessage,
		interrupt,
		permissionResponse,
		questionResponse,
		setMode,
		setAgentType,
		updatePermissionStatus,
		updateQuestionStatus,
	} = useChatMessages({
		sessionId,
		enabled: isSessionResolved,
	});

	// One continuous wait, deliberately: resolving the session and loading its
	// history are two phases of the same gap. Timing them separately would let a
	// fast resolve restart the delay and produce a longer blank than no delay.
	const isChatPending = !isSessionResolved || isLoadingHistory;
	const showSkeleton = useDelayedFlag(isChatPending, SKELETON_DELAY_MS);

	const markSessionRead = useWSStore((s) => s.actions.markSessionRead);

	// Subscribe already marks read server-side, but we also need to mark read
	// when returning from an overlay (where new messages may have arrived).
	useEffect(() => {
		if (!overlay && isSessionResolved) {
			markSessionRead(sessionId).catch(() => {});
		}
	}, [sessionId, isSessionResolved, overlay, markSessionRead]);

	const handleSend = useCallback(
		(content: string) => {
			if (sessionTitle === "New Chat") {
				const title =
					content.length > 30
						? `${content.slice(0, 30).replace(/\n/g, " ")}...`
						: content.replace(/\n/g, " ");
				onUpdateTitle(title);
			}

			sendUserMessage(content);
		},
		[sessionTitle, onUpdateTitle, sendUserMessage],
	);

	const handlePermissionRespond = useCallback(
		(request: PermissionRequest, choice: "deny" | "allow" | "always_allow") => {
			permissionResponse({
				session_id: sessionId,
				request_id: request.requestId,
				tool_use_id: request.toolUseId,
				tool_input: request.toolInput,
				permission_suggestions: request.permissionSuggestions,
				choice,
			});

			// Update message state to reflect the response
			const newStatus = choice === "deny" ? "denied" : "allowed";
			updatePermissionStatus(request.requestId, newStatus);
		},
		[permissionResponse, sessionId, updatePermissionStatus],
	);

	const handleQuestionRespond = useCallback(
		(
			request: AskUserQuestionRequest,
			answers: Record<string, string> | null,
		) => {
			questionResponse({
				session_id: sessionId,
				request_id: request.requestId,
				tool_use_id: request.toolUseId,
				answers,
			});

			// Update message state to reflect the response
			const newStatus = answers === null ? "cancelled" : "answered";
			updateQuestionStatus(request.requestId, newStatus, answers ?? undefined);
		},
		[questionResponse, sessionId, updateQuestionStatus],
	);

	const handleInterrupt = useCallback(() => {
		interrupt();
	}, [interrupt]);

	// Which message a menu is open for, and which one a fork is being confirmed
	// for. Held here rather than inside a message: both sheets are portals and
	// the fork is a session-level request, so neither belongs to one bubble.
	const [menuMessageId, setMenuMessageId] = useState<string | null>(null);
	const [forkTarget, setForkTarget] = useState<{
		messageId: string;
		defaultTitle: string;
	} | null>(null);
	const { forkSession, isForking, forkError, clearForkError } =
		useForkSession();
	// The agent's own declaration of whether it can follow a fork of a
	// conversation, which is what decides whether the menu offers forking at all.
	const forkSupport = useForkSupport(agentType);

	const forkedFromSessionId = useSessionStore(
		(s) => s.sessions.find((x) => x.id === sessionId)?.forked_from?.session_id,
	);

	// Stable: it reaches the memoized MessageItem of every bubble.
	const handleOpenMessageMenu = useCallback((messageId: string) => {
		setMenuMessageId(messageId);
	}, []);

	const handleStartFork = useCallback(
		(messageId: string) => {
			// Read rather than subscribed: the pre-filled name is a snapshot taken
			// when the sheet opens, and the panel has no other use for the list.
			const titles = useSessionStore
				.getState()
				.sessions.map((session) => session.title);
			// Swaps the menu for the confirm sheet in one commit.
			setMenuMessageId(null);
			clearForkError();
			setForkTarget({
				messageId,
				defaultTitle: buildForkTitle(sessionTitle, titles),
			});
		},
		[sessionTitle, clearForkError],
	);

	const handleCloseFork = useCallback(() => {
		setForkTarget(null);
		clearForkError();
	}, [clearForkError]);

	const handleFork = useCallback(
		async (anchorSeq: HistorySeq, title: string) => {
			try {
				const forked = await forkSession(sessionId, anchorSeq, title);
				setForkTarget(null);
				onSelectSession?.(forked.id);
			} catch {
				// Reported through forkError in the sheet, which stays open: landing
				// the user in a session that may not exist is worse than the error.
			}
		},
		[forkSession, sessionId, onSelectSession],
	);

	const menuMessage = menuMessageId
		? messages.find((m) => m.id === menuMessageId)
		: undefined;
	const forkAnchor = forkTarget
		? resolveForkAnchor(messages, forkTarget.messageId)
		: null;
	const isSheetOpen = Boolean(menuMessage || forkAnchor);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Skip if already handled (e.g., by CommandPalette)
			if (e.defaultPrevented) return;
			if (isInputBarHidden(overlay)) return;
			// A sheet takes Escape for dismissing itself; interrupting the agent as
			// well would make one key do two unrelated things.
			if (isSheetOpen) return;
			if (e.key === "Escape" && isStreaming) {
				handleInterrupt();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isStreaming, handleInterrupt, overlay, isSheetOpen]);

	const renderContent = () => {
		if (!overlay) {
			// Defer mounting until history loads so initial scroll-to-bottom works.
			// An unresolved session waits here too, so a switch shows the destination
			// empty rather than the previous session's messages.
			if (isChatPending) {
				return <ChatSkeleton showRows={showSkeleton} />;
			}
			return (
				<MessageList
					key={sessionId}
					messages={messages}
					isProcessRunning={isProcessRunning}
					isCodex={agentType === "codex"}
					onPermissionRespond={handlePermissionRespond}
					onQuestionRespond={handleQuestionRespond}
					onHintClick={handleSend}
					onOpenWorkDetail={onOpenWorkDetail}
					forkedFromSessionId={forkedFromSessionId}
					onOpenSession={onSelectSession}
					// Forking without a way to open the result would leave the user in
					// the parent with no sign anything happened, so the whole entry
					// point waits for a host that can navigate.
					onOpenMessageMenu={onSelectSession && handleOpenMessageMenu}
				/>
			);
		}

		switch (overlay.type) {
			case "diff":
				return (
					<DiffView
						path={overlay.path}
						staged={overlay.staged}
						onBack={onCloseOverlay ?? noop}
					/>
				);
			case "file":
				if (overlay.edit) {
					return (
						<FileEditor path={overlay.path} onBack={onCloseOverlay ?? noop} />
					);
				}
				return <FileView path={overlay.path} onBack={onCloseOverlay ?? noop} />;
			case "commit":
				return (
					<CommitView hash={overlay.hash} onBack={onCloseOverlay ?? noop} />
				);
			case "commit-diff":
				return <CommitDiffView hash={overlay.hash} path={overlay.path} />;
			case "settings":
				return <SettingsPage onBack={onCloseOverlay ?? noop} />;
			case "work-list":
				return (
					<WorkListOverlay
						onBack={onCloseOverlay ?? noop}
						onOpenWorkDetail={onOpenWorkDetail ?? noop}
						onNavigateToSession={onNavigateToSession ?? noop}
					/>
				);
			case "work-detail":
				return (
					<WorkDetailOverlay
						workId={overlay.workId}
						onBack={onOpenWorkList ?? onCloseOverlay ?? noop}
						onNavigateToSession={onNavigateToSession ?? noop}
						onOpenWorkDetail={onOpenWorkDetail ?? noop}
					/>
				);
			case "agent-role-list":
				return (
					<AgentRoleListOverlay
						onBack={onCloseOverlay ?? noop}
						onOpenAgentRoleDetail={onOpenAgentRoleDetail ?? noop}
					/>
				);
			case "agent-role-detail":
				return (
					<AgentRoleDetailOverlay
						roleId={overlay.roleId}
						onBack={onOpenAgentRoleList ?? onCloseOverlay ?? noop}
					/>
				);
		}
	};

	return (
		<MainContainer
			title={projectTitle}
			onOpenSidebar={onOpenSidebar}
			onOpenSettings={onOpenSettings}
		>
			{!overlay && ChatTopContent && <ChatTopContent sessionId={sessionId} />}
			{renderContent()}
			{/* Session action bar */}
			{!overlay && (
				<div className="flex shrink-0 items-center justify-between border-t border-th-border bg-th-bg-secondary px-3 py-1.5">
					<div className="flex items-center gap-1.5">
						{CustomAgentSelector === null ? null : CustomAgentSelector ? (
							<CustomAgentSelector
								agentType={agentType}
								onAgentTypeChange={setAgentType}
								disabled={
									!isSessionResolved || isStreaming || isSessionActivated
								}
							/>
						) : (
							<AgentSelector
								agentType={agentType}
								onAgentTypeChange={setAgentType}
								disabled={
									!isSessionResolved || isStreaming || isSessionActivated
								}
							/>
						)}
						{CustomModeSelector === null ? null : CustomModeSelector ? (
							<CustomModeSelector
								mode={mode}
								agentType={agentType}
								onModeChange={setMode}
								disabled={!isSessionResolved || isStreaming}
							/>
						) : (
							<ModeSelector
								mode={mode}
								agentType={agentType}
								onModeChange={setMode}
								disabled={!isSessionResolved || isStreaming}
							/>
						)}
					</div>
					<LinkedWorkButton
						sessionId={sessionId}
						onOpenWorkDetail={onOpenWorkDetail}
					/>
					{isStreaming ? (
						CustomStopButton === null ? null : CustomStopButton ? (
							<CustomStopButton onStop={handleInterrupt} />
						) : (
							<button
								type="button"
								onClick={handleInterrupt}
								aria-label="Stop"
								className="flex size-9 shrink-0 items-center justify-center rounded bg-th-error pointer-coarse:size-11 text-th-text-inverse transition-all hover:opacity-90 active:scale-95"
							>
								<Square className="size-3.5 fill-current" />
							</button>
						)
					) : (
						<div className="size-8 shrink-0" />
					)}
				</div>
			)}
			{menuMessage && (
				<MessageMenu
					message={menuMessage}
					forkBlockedReason={forkBlockedReason(agentType, forkSupport)}
					onFork={() => handleStartFork(menuMessage.id)}
					onClose={() => setMenuMessageId(null)}
				/>
			)}
			{/* Gone if the anchor left the transcript — a session deleted, a
			    worktree switched away from. There is nothing left to confirm. */}
			{forkTarget && forkAnchor && (
				<ForkSessionSheet
					anchor={forkAnchor.message}
					droppedCount={forkAnchor.droppedCount}
					agentType={agentType}
					defaultTitle={forkTarget.defaultTitle}
					isForking={isForking}
					error={forkError}
					onFork={(title) => handleFork(forkAnchor.anchorSeq, title)}
					onClose={handleCloseFork}
				/>
			)}
			{!isInputBarHidden(overlay) && (
				<InputBar
					sessionId={sessionId}
					onSend={handleSend}
					canSend={status === "connected" && !isChatPending}
					disabled={!isSessionResolved}
					isStreaming={isStreaming}
					onStop={handleInterrupt}
				/>
			)}
		</MainContainer>
	);
}

export default ChatPanel;
