import { Square } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useChatMessages } from "../../hooks/useChatMessages";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import { unreadActions } from "../../lib/unreadStore";
import { useWSStore } from "../../lib/wsStore";
import type {
	AskUserQuestionRequest,
	PermissionRequest,
} from "../../types/message";
import type { OverlayState } from "../../types/overlay";
import { hasCoarsePointer } from "../../utils/breakpoints";
import { FileEditor, FileView } from "../Files";
import { CommitDiffView, CommitView, DiffView } from "../Git";
import MainContainer from "../Layout/MainContainer";
import { SettingsPage } from "../Settings";
import DefaultInputBar from "./InputBar";
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
}

function ChatPanel({
	sessionId,
	sessionTitle,
	onUpdateTitle,
	onOpenSidebar,
	onOpenSettings,
	overlay,
	onCloseOverlay,
}: Props) {
	const projectTitle = useWSStore((state) => state.projectTitle);
	const {
		InputBar: CustomInputBar,
		ModeSelector: CustomModeSelector,
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

	// Mark session as viewing when chat is visible (not showing overlay)
	useEffect(() => {
		if (!overlay) {
			unreadActions.setViewingSession(sessionId);
			unreadActions.markRead(sessionId);
		} else {
			unreadActions.setViewingSession(null);
		}
		return () => unreadActions.setViewingSession(null);
	}, [sessionId, overlay]);

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
					onHintClick={handleSend}
				/>
			);
		}

		switch (overlay.type) {
			case "diff":
				return (
					<DiffView
						path={overlay.path}
						staged={overlay.staged}
						onBack={onCloseOverlay ?? (() => {})}
					/>
				);
			case "file":
				if (overlay.edit) {
					return (
						<FileEditor
							path={overlay.path}
							onBack={onCloseOverlay ?? (() => {})}
						/>
					);
				}
				return (
					<FileView path={overlay.path} onBack={onCloseOverlay ?? (() => {})} />
				);
			case "commit":
				return (
					<CommitView
						hash={overlay.hash}
						onBack={onCloseOverlay ?? (() => {})}
					/>
				);
			case "commit-diff":
				return <CommitDiffView hash={overlay.hash} path={overlay.path} />;
			case "settings":
				return <SettingsPage onBack={onCloseOverlay ?? (() => {})} />;
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
			{!overlay &&
				(CustomModeSelector !== null ||
					(isStreaming && CustomStopButton !== null)) && (
					<div className="flex shrink-0 items-center justify-between border-t border-th-border bg-th-bg-secondary px-3 py-1.5">
						{CustomModeSelector === null ? (
							<div />
						) : CustomModeSelector ? (
							<CustomModeSelector
								mode={mode}
								onModeChange={setMode}
								disabled={isStreaming}
							/>
						) : (
							<ModeSelector
								mode={mode}
								onModeChange={setMode}
								disabled={isStreaming}
							/>
						)}
						{isStreaming &&
							(CustomStopButton === null ? null : CustomStopButton ? (
								<CustomStopButton onStop={handleInterrupt} />
							) : (
								<button
									type="button"
									onClick={handleInterrupt}
									aria-label="Stop"
									className="flex h-8 items-center gap-1.5 rounded bg-th-error px-2.5 text-th-text-inverse transition-all hover:opacity-90 active:scale-95"
								>
									<Square className="size-3.5 fill-current" />
									{!hasCoarsePointer() && (
										<span className="text-xs opacity-80">Esc</span>
									)}
								</button>
							))}
					</div>
				)}
			<InputBar
				sessionId={sessionId}
				onSend={handleSend}
				canSend={status === "connected" && !isLoadingHistory}
				isStreaming={isStreaming}
				onStop={handleInterrupt}
			/>
		</MainContainer>
	);
}

export default ChatPanel;
