import { useCallback, useEffect, useState } from "react";
import {
	type ConnectionStatus,
	useChatMessages,
} from "../../hooks/useChatMessages";
import type {
	AskUserQuestionRequest,
	PermissionRequest,
	WSServerMessage,
} from "../../types/message";
import MainContainer from "../Layout/MainContainer";
import AskUserQuestionDialog from "./AskUserQuestionDialog";
import ExitPlanModeDialog from "./ExitPlanModeDialog";
import InputBar from "./InputBar";
import MessageList from "./MessageList";
import PermissionDialog from "./PermissionDialog";

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
	// Dialog state kept here (tightly coupled to UI, not domain data)
	const [permissionRequest, setPermissionRequest] =
		useState<PermissionRequest | null>(null);
	const [questionRequest, setQuestionRequest] =
		useState<AskUserQuestionRequest | null>(null);

	const handleServerMessage = useCallback((serverMsg: WSServerMessage) => {
		if (serverMsg.type === "permission_request") {
			setPermissionRequest({
				requestId: serverMsg.request_id,
				toolName: serverMsg.tool_name,
				toolInput: serverMsg.tool_input,
				toolUseId: serverMsg.tool_use_id,
				permissionSuggestions: serverMsg.permission_suggestions,
			});
		} else if (serverMsg.type === "ask_user_question") {
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
	} = useChatMessages({
		sessionId,
		onServerMessage: handleServerMessage,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId change should reset dialogs
	useEffect(() => {
		setPermissionRequest(null);
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

	const handlePermissionResponse = useCallback(
		(choice: "deny" | "allow" | "always_allow") => {
			if (!permissionRequest) return;

			send({
				type: "permission_response",
				session_id: sessionId,
				request_id: permissionRequest.requestId,
				choice,
			});

			setPermissionRequest(null);
		},
		[send, permissionRequest, sessionId],
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
			<MessageList messages={messages} sessionId={sessionId} />
			<InputBar
				sessionId={sessionId}
				onSend={handleSend}
				disabled={status !== "connected" || isLoadingHistory}
				isStreaming={isStreaming}
				onInterrupt={handleInterrupt}
			/>

			{permissionRequest &&
				(permissionRequest.toolName === "ExitPlanMode" ? (
					<ExitPlanModeDialog
						request={permissionRequest}
						onApprove={() => handlePermissionResponse("allow")}
						onReject={() => handlePermissionResponse("deny")}
					/>
				) : (
					<PermissionDialog
						request={permissionRequest}
						onAllow={() => handlePermissionResponse("allow")}
						onAlwaysAllow={() => handlePermissionResponse("always_allow")}
						onDeny={() => handlePermissionResponse("deny")}
					/>
				))}

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
