import { useCallback, useEffect } from "react";
import { useChatMessages } from "../../hooks/useChatMessages";
import { unreadActions } from "../../lib/unreadStore";
import { useWSStore } from "../../lib/wsStore";
import type {
	AskUserQuestionRequest,
	PermissionRequest,
} from "../../types/message";
import type { OverlayState } from "../../types/overlay";
import { FileView } from "../Files";
import { DiffView } from "../Git";
import MainContainer from "../Layout/MainContainer";
import { SettingsPage } from "../Settings";
import InputBar from "./InputBar";
import MessageList from "./MessageList";

interface Props {
	sessionId: string;
	sessionTitle: string;
	onUpdateTitle: (title: string) => void;
	onLogout?: () => void;
	onOpenSidebar?: () => void;
	onOpenSettings?: () => void;
	overlay?: OverlayState;
	onCloseOverlay?: () => void;
}

function ChatPanel({
	sessionId,
	sessionTitle,
	onUpdateTitle,
	onLogout,
	onOpenSidebar,
	onOpenSettings,
	overlay,
	onCloseOverlay,
}: Props) {
	const projectTitle = useWSStore((state) => state.projectTitle);

	const {
		messages,
		isLoadingHistory,
		isStreaming,
		isProcessRunning,
		status,
		sendUserMessage,
		interrupt,
		permissionResponse,
		questionResponse,
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
			return (
				<MessageList
					messages={messages}
					sessionId={sessionId}
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
						onBack={onCloseOverlay ?? (() => {})}
					/>
				);
			case "file":
				return (
					<FileView path={overlay.path} onBack={onCloseOverlay ?? (() => {})} />
				);
			case "settings":
				return (
					<SettingsPage
						onBack={onCloseOverlay ?? (() => {})}
						onLogout={onLogout ?? (() => {})}
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
			<InputBar
				sessionId={sessionId}
				onSend={handleSend}
				canSend={status === "connected" && !isLoadingHistory}
				isStreaming={isStreaming}
				onInterrupt={handleInterrupt}
			/>
		</MainContainer>
	);
}

export default ChatPanel;
