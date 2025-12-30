import { useCallback, useEffect } from "react";
import {
	type ConnectionStatus,
	useChatMessages,
} from "../../hooks/useChatMessages";
import type { OverlayState } from "../../types/overlay";
import { DiffView } from "../Git";
import MainContainer from "../Layout/MainContainer";
import InputBar from "./InputBar";
import MessageList from "./MessageList";

interface Props {
	sessionId: string;
	sessionTitle: string;
	onUpdateTitle: (title: string) => void;
	onLogout?: () => void;
	onOpenSidebar?: () => void;
	overlay?: OverlayState;
	onCloseOverlay?: () => void;
}

const STATUS_CONFIG: Record<ConnectionStatus, { text: string; color: string }> =
	{
		connected: { text: "Connected", color: "text-th-success" },
		error: { text: "Connection Error", color: "text-th-error" },
		disconnected: { text: "Disconnected", color: "text-th-warning" },
		connecting: { text: "Connecting...", color: "text-th-warning" },
	};

function ChatPanel({
	sessionId,
	sessionTitle,
	onUpdateTitle,
	onLogout,
	onOpenSidebar,
	overlay,
	onCloseOverlay,
}: Props) {
	const {
		messages,
		isLoadingHistory,
		isStreaming,
		isProcessRunning,
		status,
		send,
		sendUserMessage,
		updatePermissionStatus,
		updateQuestionStatus,
	} = useChatMessages({
		sessionId,
	});

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
		(requestId: string, choice: "deny" | "allow" | "always_allow") => {
			send({
				type: "permission_response",
				session_id: sessionId,
				request_id: requestId,
				choice,
			});

			// Update message state to reflect the response
			const newStatus = choice === "deny" ? "denied" : "allowed";
			updatePermissionStatus(requestId, newStatus);
		},
		[send, sessionId, updatePermissionStatus],
	);

	const handleQuestionRespond = useCallback(
		(requestId: string, answers: Record<string, string> | null) => {
			send({
				type: "question_response",
				session_id: sessionId,
				request_id: requestId,
				answers,
			});

			// Update message state to reflect the response
			const newStatus = answers === null ? "cancelled" : "answered";
			updateQuestionStatus(requestId, newStatus, answers ?? undefined);
		},
		[send, sessionId, updateQuestionStatus],
	);

	const handleInterrupt = useCallback(() => {
		send({
			type: "interrupt",
			session_id: sessionId,
		});
	}, [send, sessionId]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && isStreaming) {
				handleInterrupt();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isStreaming, handleInterrupt]);

	const { text: statusText, color: statusColor } = STATUS_CONFIG[status];

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
		}
	};

	const statusIndicator = (
		<span className={`text-sm ${statusColor}`}>{statusText}</span>
	);

	return (
		<MainContainer
			onOpenSidebar={onOpenSidebar}
			onLogout={onLogout}
			headerRight={statusIndicator}
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
