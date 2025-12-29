import { useCallback, useEffect, useState } from "react";
import {
	type ConnectionStatus,
	useChatMessages,
} from "../../hooks/useChatMessages";
import type {
	AskUserQuestionRequest,
	WSServerMessage,
} from "../../types/message";
import MainContainer from "../Layout/MainContainer";
import AskUserQuestionDialog from "./AskUserQuestionDialog";
import InputBar from "./InputBar";
import MessageList from "./MessageList";

interface Props {
	sessionId: string;
	sessionTitle: string;
	onUpdateTitle: (title: string) => void;
	onLogout?: () => void;
	onOpenSidebar?: () => void;
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
}: Props) {
	// Dialog state for ask_user_question (permission_request now in message flow)
	const [questionRequest, setQuestionRequest] =
		useState<AskUserQuestionRequest | null>(null);

	const handleServerMessage = useCallback((serverMsg: WSServerMessage) => {
		if (serverMsg.type === "ask_user_question") {
			setQuestionRequest({
				requestId: serverMsg.request_id,
				questions: serverMsg.questions,
			});
		}
	}, []);

	const {
		messages,
		isLoadingHistory,
		isStreaming,
		status,
		send,
		sendUserMessage,
		updatePermissionStatus,
	} = useChatMessages({
		sessionId,
		onServerMessage: handleServerMessage,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId change should reset dialogs
	useEffect(() => {
		setQuestionRequest(null);
	}, [sessionId]);

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

	const handleQuestionResponse = useCallback(
		(answers: Record<string, string> | null) => {
			if (!questionRequest) return;

			send({
				type: "question_response",
				session_id: sessionId,
				request_id: questionRequest.requestId,
				answers,
			});

			setQuestionRequest(null);
		},
		[send, questionRequest, sessionId],
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

	const statusIndicator = (
		<span className={`text-sm ${statusColor}`}>{statusText}</span>
	);

	return (
		<MainContainer
			onOpenSidebar={onOpenSidebar}
			onLogout={onLogout}
			headerRight={statusIndicator}
		>
			<MessageList
				messages={messages}
				sessionId={sessionId}
				onPermissionRespond={handlePermissionRespond}
			/>
			<InputBar
				sessionId={sessionId}
				onSend={handleSend}
				canSend={status === "connected" && !isLoadingHistory}
				isStreaming={isStreaming}
				onInterrupt={handleInterrupt}
			/>

			{questionRequest && (
				<AskUserQuestionDialog
					request={questionRequest}
					onSubmit={handleQuestionResponse}
					onCancel={() => handleQuestionResponse(null)}
				/>
			)}
		</MainContainer>
	);
}

export default ChatPanel;
