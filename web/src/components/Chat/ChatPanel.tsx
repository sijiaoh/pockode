import { AlertTriangle, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatMessages } from "../../hooks/useChatMessages";
import { SKELETON_DELAY_MS, useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useForkSession } from "../../hooks/useForkSession";
import { useForkSupport } from "../../hooks/useForkSupport";
import { inputActions } from "../../lib/inputStore";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../../lib/sessionDetailStore";
import { useSessionStore } from "../../lib/sessionStore";
import { useWSStore } from "../../lib/wsStore";
import type {
	AskUserQuestionRequest,
	HistorySeq,
	PermissionRequest,
} from "../../types/message";
import type { OverlayState } from "../../types/overlay";
import { resolveForkAnchor } from "../../utils/forkAnchor";
import { buildForkTitle } from "../../utils/forkTitle";
import { FileEditor, FileView } from "../Files";
import { CommitDiffView, CommitFileView, CommitView, DiffView } from "../Git";
import MainContainer from "../Layout/MainContainer";
import {
	AgentRoleDetailOverlay,
	AgentRoleListOverlay,
	WorkDetailOverlay,
	WorkListOverlay,
} from "../Project";
import { SettingsPage } from "../Settings";
import BlockerStrip from "./BlockerStrip";
import ChatSkeleton from "./ChatSkeleton";
import EngineSelector from "./EngineSelector";
import ForkSessionSheet from "./ForkSessionSheet";
import DefaultInputBar from "./InputBar";
import type { PromptError } from "./MessageItem";
import MessageList, { type MessageListHandle } from "./MessageList";
import ModeSelector from "./ModeSelector";
import SessionInfoButton from "./SessionInfoButton";

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

/**
 * Changing the engine or the mode is a deliberate action whose only other
 * feedback is the control snapping back to where it was. One bar for all three
 * settings — the server's reason is what tells "that model isn't this agent's"
 * apart from a dropped connection.
 */
function SettingErrorBar({
	message,
	onDismiss,
}: {
	message: string;
	onDismiss: () => void;
}) {
	return (
		<div
			role="alert"
			className="flex shrink-0 items-start gap-2 border-t border-th-border bg-th-bg-secondary px-3 py-1.5 text-xs text-th-error"
		>
			<AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
			<span className="min-w-0 flex-1">{message}</span>
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss error"
				className="touch-target -my-1 flex size-5 shrink-0 items-center justify-center rounded text-th-text-muted transition-colors hover:text-th-text-primary active:scale-95"
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

interface Props {
	/**
	 * Destination session id, taken from the URL. It is known before the session
	 * itself is, which is why it can be trusted while `isSessionResolved` is
	 * false. Empty when the route names no session.
	 */
	sessionId: string;
	/**
	 * The session's name as its list row carries it, and empty for a session the
	 * list has no row for — one the task-session filter hides. The panel falls
	 * back to the detail for those.
	 */
	sessionTitle: string;
	/**
	 * Whether `sessionId` is known to exist in the worktree the connection is
	 * bound to. Until then nothing about the session is known but its id, so the
	 * panel shows the destination as an empty shell rather than anything
	 * belonging to the session the user came from.
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
	/**
	 * Opens a work-directory file in the Files viewer. Must be stable: it reaches
	 * the memoized `MessageItem`.
	 */
	onOpenFile?: (path: string) => void;
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
	onOpenFile,
	onOpenWorkList,
	onOpenAgentRoleList,
	onOpenAgentRoleDetail,
}: Props) {
	const projectTitle = useWSStore((state) => state.projectTitle);
	const {
		InputBar: CustomInputBar,
		ModeSelector: CustomModeSelector,
		EngineSelector: CustomEngineSelector,
		StopButton: CustomStopButton,
		ChatTopContent,
	} = useChatUIConfig();
	const InputBar = CustomInputBar ?? DefaultInputBar;
	const Engine = CustomEngineSelector ?? EngineSelector;

	// Read, not held: `AppShell` owns the session's detail subscription, because
	// whether the session exists is what that subscription answers and the shell
	// will not mount this panel until it does. Everything below —
	// `useChatMessages`' settings included — reads the same store entry, so the
	// settings and where the conversation was forked from stay one snapshot.
	const sessionDetail = useSessionDetailStore(selectSessionDetail(sessionId));

	// The row is the fast source — it is on screen before the detail lands — but
	// there is no row for a session the task-session filter hides, which is every
	// session a work item drives. The detail speaks for the session itself and
	// covers those.
	const resolvedTitle = sessionTitle || sessionDetail?.title || "";

	const {
		messages,
		isLoadingHistory,
		hasMoreHistory,
		isLoadingMoreHistory,
		historyError,
		loadedHistoryPages,
		loadMoreHistory,
		turnOpen,
		turn,
		mode,
		agentType,
		model,
		effort,
		isSessionActivated,
		isSessionDetailLoaded,
		status,
		settingError,
		clearSettingError,
		sendUserMessage,
		interrupt,
		permissionResponse,
		questionResponse,
		setMode,
		setAgentType,
		setModel,
		setEffort,
		updatePermissionStatus,
		updateQuestionStatus,
		resetPrompt,
	} = useChatMessages({
		sessionId,
		enabled: isSessionResolved,
	});

	// The three settings controls all read the session's own metadata, which
	// arrives a round trip after the session resolves. Until it does there is no
	// value to show and nothing to change: a control offering the placeholder
	// would report a mode the session is not in, and refuse the very switch that
	// says so, because the value it is being asked for looks like the current one.
	const hasSessionSettings = isSessionResolved && isSessionDetailLoaded;

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
			if (resolvedTitle === "New Chat") {
				const title =
					content.length > 30
						? `${content.slice(0, 30).replace(/\n/g, " ")}...`
						: content.replace(/\n/g, " ");
				onUpdateTitle(title);
			}

			sendUserMessage(content);
		},
		[resolvedTitle, onUpdateTitle, sendUserMessage],
	);

	// An answer only reaches the process that raised the prompt, so a card whose
	// process has gone is refused by the server with its own reason. The optimistic
	// outcome is undone and the reason is shown on the card, which is where the
	// user was looking (docs/lifecycle-ui.md §8).
	const [promptError, setPromptError] = useState<PromptError | null>(null);

	// Read only when an answer is refused, never during render. The handlers
	// below reach a memoized `MessageItem`, so taking `turn` as a dependency
	// would re-render the whole transcript every time the session's phase moved.
	const turnRef = useRef(turn);
	turnRef.current = turn;

	const reportPromptFailure = useCallback(
		(requestId: string, error: unknown) => {
			// Which unanswered state the card goes back to is the session's to say,
			// not the failure's: a refusal is equally what a dead process and a
			// dropped socket look like from here, and only one of them means the
			// prompt can never be answered. The turn is the authority — it lists
			// exactly the prompts still waiting on someone.
			const stillWaiting = (turnRef.current.blockers ?? []).some(
				(blocker) => blocker.request_id === requestId,
			);
			resetPrompt(requestId, stillWaiting ? "pending" : "expired");
			setPromptError({
				requestId,
				message:
					error instanceof Error && error.message
						? error.message
						: "The answer could not be delivered.",
			});
		},
		[resetPrompt],
	);

	const handlePermissionRespond = useCallback(
		(request: PermissionRequest, choice: "deny" | "allow" | "always_allow") => {
			setPromptError(null);
			permissionResponse({
				session_id: sessionId,
				request_id: request.requestId,
				tool_use_id: request.toolUseId,
				tool_input: request.toolInput,
				permission_suggestions: request.permissionSuggestions,
				choice,
			}).catch((error) => reportPromptFailure(request.requestId, error));

			// Update message state to reflect the response
			const newStatus = choice === "deny" ? "denied" : "allowed";
			updatePermissionStatus(request.requestId, newStatus);
		},
		[
			permissionResponse,
			sessionId,
			updatePermissionStatus,
			reportPromptFailure,
		],
	);

	const handleQuestionRespond = useCallback(
		(
			request: AskUserQuestionRequest,
			answers: Record<string, string> | null,
		) => {
			setPromptError(null);
			questionResponse({
				session_id: sessionId,
				request_id: request.requestId,
				tool_use_id: request.toolUseId,
				answers,
			}).catch((error) => reportPromptFailure(request.requestId, error));

			// Update message state to reflect the response
			const newStatus = answers === null ? "cancelled" : "answered";
			updateQuestionStatus(request.requestId, newStatus, answers ?? undefined);
		},
		[questionResponse, sessionId, updateQuestionStatus, reportPromptFailure],
	);

	// Sending clears the card's error: the message it produces is the answer now.
	const handleSendAsMessage = useCallback(
		(content: string) => {
			setPromptError(null);
			sendUserMessage(content);
		},
		[sendUserMessage],
	);

	const handleInterrupt = useCallback(() => {
		interrupt();
	}, [interrupt]);

	// Which message a fork is being confirmed for. Held here rather than inside a
	// message: the sheet is a portal and the fork is a session-level request, so
	// it belongs to no one bubble.
	const [forkTarget, setForkTarget] = useState<{
		messageId: string;
		defaultTitle: string;
	} | null>(null);
	const { forkSession, isForking, forkError, clearForkError } =
		useForkSession();
	// The agent's own declaration of whether it can follow a fork of a
	// conversation. An agent that cannot gets no menu anywhere, and no slot
	// reserved for one: an entry to an action that never once applied is
	// decoration, not a refusal worth explaining — and here it would be
	// decoration charged to every bubble's width.
	const forkSupport = useForkSupport(agentType);

	// From the session's own detail, not from its row in the list: where a
	// conversation came from is a fact about this session. The list is still read
	// just below, for the *other* sessions' titles.
	const forkedFromSessionId = sessionDetail?.forked_from?.session_id;

	const handleStartFork = useCallback(
		(messageId: string) => {
			// Read rather than subscribed: the pre-filled name is a snapshot taken
			// when the sheet opens, and the panel has no other use for the list.
			const titles = useSessionStore
				.getState()
				.sessions.map((session) => session.title);
			clearForkError();
			setForkTarget({
				messageId,
				defaultTitle: buildForkTitle(resolvedTitle, titles),
			});
		},
		[resolvedTitle, clearForkError],
	);

	const handleCloseFork = useCallback(() => {
		setForkTarget(null);
		clearForkError();
	}, [clearForkError]);

	const handleFork = useCallback(
		async (anchorSeq: HistorySeq, title: string, droppedText?: string) => {
			try {
				const forked = await forkSession(sessionId, anchorSeq, title);
				setForkTarget(null);
				// A fork anchored on the user's own prompt returns to before they
				// sent it, so the prompt comes back as a draft of the new session
				// instead of staying only in the one they forked away from. A
				// draft and nothing more — unsent text has a store, and history is
				// not it. Set before navigating so the box is never briefly empty;
				// the caret needs no help, since setting a textarea's value leaves
				// it after the text.
				if (droppedText) inputActions.set(forked.id, droppedText);
				onSelectSession?.(forked.id);
			} catch {
				// Reported through forkError in the sheet, which stays open: landing
				// the user in a session that may not exist is worse than the error.
			}
		},
		[forkSession, sessionId, onSelectSession],
	);

	// The jump lives with the scroll container; the strip below the list asks for
	// it rather than reimplementing it.
	const messageListRef = useRef<MessageListHandle>(null);
	const handleJumpToRequest = useCallback((requestId: string) => {
		messageListRef.current?.jumpToRequest(requestId);
	}, []);

	const forkAnchor = forkTarget
		? resolveForkAnchor(messages, forkTarget.messageId, hasMoreHistory)
		: null;
	const isSheetOpen = Boolean(forkAnchor);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Skip if already handled (e.g., by CommandPalette)
			if (e.defaultPrevented) return;
			if (isInputBarHidden(overlay)) return;
			// A sheet takes Escape for dismissing itself; interrupting the agent as
			// well would make one key do two unrelated things.
			if (isSheetOpen) return;
			if (e.key === "Escape" && turnOpen) {
				handleInterrupt();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [turnOpen, handleInterrupt, overlay, isSheetOpen]);

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
					ref={messageListRef}
					sessionId={sessionId}
					messages={messages}
					hasMoreHistory={hasMoreHistory}
					isLoadingMoreHistory={isLoadingMoreHistory}
					historyError={historyError}
					loadedHistoryPages={loadedHistoryPages}
					onLoadMoreHistory={loadMoreHistory}
					isCodex={agentType === "codex"}
					onPermissionRespond={handlePermissionRespond}
					onQuestionRespond={handleQuestionRespond}
					onHintClick={handleSend}
					onSendAsMessage={handleSendAsMessage}
					promptError={promptError ?? undefined}
					onOpenWorkDetail={onOpenWorkDetail}
					onOpenFile={onOpenFile}
					forkedFromSessionId={forkedFromSessionId}
					onOpenSession={onSelectSession}
					// Forking without a way to open the result would leave the user in
					// the parent with no sign anything happened, so the menu waits for
					// a host that can navigate. Today that withholds the whole slot,
					// fork being the only row in the menu; a second action needing no
					// navigation would move this gate onto fork's own row instead
					// (docs/session-fork-ui.md, "Which rows reserve a slot").
					onForkMessage={
						onSelectSession && forkSupport !== "none"
							? handleStartFork
							: undefined
					}
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
			case "commit-file":
				return <CommitFileView hash={overlay.hash} path={overlay.path} />;
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
			{/* Why the agent is quiet, stated where the transcript ends
			    (docs/lifecycle-ui.md §2.2). */}
			{!overlay && !isChatPending && (
				<BlockerStrip turn={turn} onJumpToRequest={handleJumpToRequest} />
			)}
			{/* Session action bar */}
			{!overlay && settingError && (
				<SettingErrorBar message={settingError} onDismiss={clearSettingError} />
			)}
			{!overlay && (
				<div className="flex shrink-0 items-center justify-between border-t border-th-border bg-th-bg-secondary px-3 py-1.5">
					{/* gap-2, not tighter: three neighbouring hit areas now sit in this
					    row, and 8px between them is the coarse-pointer floor. */}
					<div className="flex min-w-0 items-center gap-2">
						{CustomEngineSelector === null ? null : (
							<Engine
								agentType={agentType}
								model={model}
								effort={effort}
								onAgentTypeChange={setAgentType}
								onModelChange={setModel}
								onEffortChange={setEffort}
								hasSessionSettings={hasSessionSettings}
								isSessionActivated={isSessionActivated}
								disabled={!hasSessionSettings || turnOpen}
							/>
						)}
						{CustomModeSelector === null ? null : CustomModeSelector ? (
							<CustomModeSelector
								mode={mode}
								agentType={agentType}
								onModeChange={setMode}
								hasSessionSettings={hasSessionSettings}
								disabled={!hasSessionSettings || turnOpen}
							/>
						) : (
							<ModeSelector
								mode={mode}
								agentType={agentType}
								onModeChange={setMode}
								hasSessionSettings={hasSessionSettings}
								disabled={!hasSessionSettings || turnOpen}
							/>
						)}
						{/* Gated on the route naming a session at all, not on its data:
						    the button is permanent for the session it belongs to — it
						    waits through a switch, showing "Loading…" — but there is no
						    session to describe when the route names none. */}
						{sessionId !== "" && (
							<SessionInfoButton
								sessionId={sessionId}
								usage={sessionDetail?.usage}
								isForked={sessionDetail?.forked_from !== undefined}
								onOpenWorkDetail={onOpenWorkDetail}
							/>
						)}
					</div>
					{/* Stop exists for every open turn, blocked ones included: the
					    process is alive, and Stop is one of the user's two exits from
					    a blocked turn — the card being the other. */}
					{turnOpen ? (
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
					onFork={(title) =>
						handleFork(forkAnchor.anchorSeq, title, forkAnchor.droppedText)
					}
					onClose={handleCloseFork}
				/>
			)}
			{!isInputBarHidden(overlay) && (
				<InputBar
					sessionId={sessionId}
					onSend={handleSend}
					canSend={status === "connected" && !isChatPending}
					disabled={!isSessionResolved}
					turnOpen={turnOpen}
					onStop={handleInterrupt}
				/>
			)}
		</MainContainer>
	);
}

export default ChatPanel;
