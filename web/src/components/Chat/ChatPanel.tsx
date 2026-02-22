import { ClipboardList, Square } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { useChatMessages } from "../../hooks/useChatMessages";
import { useWorkStore } from "../../lib/workStore";
import { useWSStore } from "../../lib/wsStore";
import type {
	AskUserQuestionRequest,
	PermissionRequest,
} from "../../types/message";
import type { OverlayState } from "../../types/overlay";
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
import InputBar from "./InputBar";
import MessageList from "./MessageList";
import ModeSelector from "./ModeSelector";

interface Props {
	sessionId: string;
	sessionTitle: string;
	onUpdateTitle: (title: string) => void;
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	overlay?: OverlayState;
	onCloseOverlay?: () => void;
	onNavigateToSession?: (sessionId: string) => void;
	onOpenWorkDetail?: (workId: string) => void;
	onOpenWorkList?: () => void;
	onOpenAgentRoleList?: () => void;
	onOpenAgentRoleDetail?: (roleId: string) => void;
}

function ChatPanel({
	sessionId,
	sessionTitle,
	onUpdateTitle,
	onOpenSidebar,
	onOpenSettings,
	overlay,
	onCloseOverlay,
	onNavigateToSession,
	onOpenWorkDetail,
	onOpenWorkList,
	onOpenAgentRoleList,
	onOpenAgentRoleDetail,
}: Props) {
	const projectTitle = useWSStore((state) => state.projectTitle);
	const works = useWorkStore((s) => s.works);
	const linkedWork = useMemo(
		() => works.find((w) => w.session_id === sessionId),
		[works, sessionId],
	);

	const {
		messages,
		isLoadingHistory,
		isStreaming,
		isProcessRunning,
		mode,
		status,
		sendUserMessage,
		interrupt,
		permissionResponse,
		questionResponse,
		setMode,
		updatePermissionStatus,
		updateQuestionStatus,
	} = useChatMessages({
		sessionId,
	});

	const markSessionRead = useWSStore((s) => s.actions.markSessionRead);

	// Subscribe already marks read server-side, but we also need to mark read
	// when returning from an overlay (where new messages may have arrived).
	useEffect(() => {
		if (!overlay) {
			markSessionRead(sessionId).catch(() => {});
		}
	}, [sessionId, overlay, markSessionRead]);

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

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Skip if already handled (e.g., by CommandPalette)
			if (e.defaultPrevented) return;
			if (e.key === "Escape" && isStreaming) {
				handleInterrupt();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isStreaming, handleInterrupt]);

	const renderContent = () => {
		if (!overlay) {
			// Defer mounting until history loads so Virtuoso's initialTopMostItemIndex works
			if (isLoadingHistory) {
				return (
					<div className="flex min-h-0 flex-1 items-center justify-center">
						<div className="h-5 w-5 animate-spin rounded-full border-2 border-th-text-muted border-t-transparent" />
					</div>
				);
			}
			return (
				<MessageList
					key={sessionId}
					messages={messages}
					isProcessRunning={isProcessRunning}
					onPermissionRespond={handlePermissionRespond}
					onQuestionRespond={handleQuestionRespond}
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
			{renderContent()}
			{/* Session action bar - only shown when not in overlay */}
			{!overlay && (
				<div className="flex shrink-0 items-center justify-between border-t border-th-border bg-th-bg-secondary px-3 py-1.5">
					<ModeSelector
						mode={mode}
						onModeChange={setMode}
						disabled={isStreaming}
					/>
					{linkedWork && (
						<button
							type="button"
							onClick={() => onOpenWorkDetail?.(linkedWork.id)}
							className="flex min-w-0 items-center gap-1 rounded px-2 py-1 text-xs text-th-text-secondary transition-all hover:bg-th-bg-tertiary hover:text-th-text-primary active:scale-95"
						>
							<ClipboardList className="size-3.5 shrink-0" />
							<span className="max-w-[120px] truncate">{linkedWork.title}</span>
						</button>
					)}
					{isStreaming ? (
						<button
							type="button"
							onClick={handleInterrupt}
							aria-label="Stop"
							className="flex size-8 shrink-0 items-center justify-center rounded bg-th-error text-th-text-inverse transition-all hover:opacity-90 active:scale-95"
						>
							<Square className="size-3.5 fill-current" />
						</button>
					) : (
						<div className="size-8 shrink-0" />
					)}
				</div>
			)}
			{(!overlay ||
				![
					"work-list",
					"work-detail",
					"agent-role-list",
					"agent-role-detail",
				].includes(overlay.type)) && (
				<InputBar
					sessionId={sessionId}
					onSend={handleSend}
					canSend={status === "connected" && !isLoadingHistory}
				/>
			)}
		</MainContainer>
	);
}

export default ChatPanel;

const noop = () => {};
