import { AlertTriangle, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatMessages } from "../../hooks/useChatMessages";
import { SKELETON_DELAY_MS, useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useForkSession } from "../../hooks/useForkSession";
import { useForkSupport } from "../../hooks/useForkSupport";
import { useViewedSession } from "../../hooks/useViewedSession";
import { takeAnswerIntent } from "../../lib/answerIntent";
import { inputActions } from "../../lib/inputStore";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../../lib/sessionDetailStore";
import { useSessionStore } from "../../lib/sessionStore";
import { type SessionView, SessionViewProvider } from "../../lib/sessionView";
import { useWSStore } from "../../lib/wsStore";
import type {
	HistorySeq,
	PermissionRequest,
	QuestionAnswerRecord,
} from "../../types/message";
import type { OverlayState, WorkSegment } from "../../types/overlay";
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
import AnswerSheet from "./AnswerSheet";
import AttentionStrip from "./AttentionStrip";
import ChatSkeleton from "./ChatSkeleton";
import EngineSelector from "./EngineSelector";
import ForkSessionSheet from "./ForkSessionSheet";
import DefaultInputBar from "./InputBar";
import type { PromptError } from "./MessageItem";
import MessageList, { type MessageListHandle } from "./MessageList";
import ModeSelector from "./ModeSelector";
import ReadOnlyBar from "./ReadOnlyBar";
import SessionInfoButton from "./SessionInfoButton";
import SessionOriginBar from "./SessionOriginBar";

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
	workSegment?: WorkSegment;
	onSelectWorkSegment?: (segment: WorkSegment) => void;
	onOpenAgentRoleList?: () => void;
	onOpenAgentRoleDetail?: (roleId: string) => void;
	/**
	 * Set when the session's data is being read out of another worktree, which
	 * is the whole of what makes this screen read-only: the data comes from
	 * `session_view.*`, which cannot say anything to a session. `isSessionResolved`
	 * says nothing here — the bound worktree has never heard of this session.
	 */
	view?: SessionView | null;
	/** Opens the viewed session in its own worktree; see `ReadOnlyBar`. */
	onOpenSessionThere?: () => void;
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
	workSegment = "current",
	onSelectWorkSegment,
	onOpenAgentRoleList,
	onOpenAgentRoleDetail,
	view = null,
	onOpenSessionThere,
}: Props) {
	const isReadOnly = view !== null;
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
	const liveDetail = useSessionDetailStore(selectSessionDetail(sessionId));
	// A viewed session has no row, no subscription and no entry in the detail
	// store, which holds the bound worktree's open session. Its metadata is read
	// once instead, and everything below reads whichever of the two applies.
	const viewedSession = useViewedSession(
		view?.worktree ?? "",
		sessionId,
		isReadOnly,
	);
	const sessionDetail = viewedSession ? viewedSession.detail : liveDetail;

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
		isSendPending,
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
		setMode,
		setAgentType,
		setModel,
		setEffort,
		updatePermissionStatus,
		resetPrompt,
	} = useChatMessages({
		sessionId,
		// A viewed session resolves through its own read rather than through the
		// bound worktree's session list, which will never have a row for it.
		enabled: isReadOnly || isSessionResolved,
		viewedSession,
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
	const isChatPending = (!isReadOnly && !isSessionResolved) || isLoadingHistory;
	const showSkeleton = useDelayedFlag(isChatPending, SKELETON_DELAY_MS);

	// The one thing that still refuses a send. An open turn is not it — both CLIs
	// steer the running turn with whatever arrives — but a permission or question
	// request owns the agent's next line of input: a message sent over it expires
	// the card without the CLI ever reading either, which used to hang the turn
	// for good, so the server refuses it too (docs/lifecycle-ui.md §2.3). The
	// user's exits are the card itself and Stop, and both are on screen.
	//
	// A background wait is deliberately not here: nobody has to answer it, the CLI
	// is between turns and reads what arrives.
	const promptOwnsInput =
		turn.phase === "blocked" &&
		(turn.blockers ?? []).some((b) => b.kind === "permission");

	const markSessionRead = useWSStore((s) => s.actions.markSessionRead);

	// Subscribe already marks read server-side, but we also need to mark read
	// when returning from an overlay (where new messages may have arrived).
	useEffect(() => {
		// Not for a viewed session: unread belongs to the worktree that owns the
		// session, and the connection is not bound to it.
		if (!overlay && !isReadOnly && isSessionResolved) {
			markSessionRead(sessionId).catch(() => {});
		}
	}, [sessionId, isSessionResolved, isReadOnly, overlay, markSessionRead]);

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

	// Whether the answer sheet is open, and which question it opens on. Held
	// here because the sheet is a portal answering for the whole session, not for
	// any one bubble, and because three separate openers reach it
	// (docs/answering-ui.md §4).
	//
	// `null` is closed. `{}` is open with no anchor, which is what the strip
	// asks for: the sheet then opens on the oldest question.
	const [answerAnchor, setAnswerAnchor] = useState<{
		requestId?: string;
	} | null>(null);

	const handleOpenAnswerSheet = useCallback(() => setAnswerAnchor({}), []);
	const handleAnswerQuestion = useCallback(
		(requestId: string) => setAnswerAnchor({ requestId }),
		[],
	);
	const handleCloseAnswerSheet = useCallback(() => setAnswerAnchor(null), []);

	// The sheet belongs to one session's questions, so a switch closes it. During
	// render rather than in an effect, for the reason `useChatMessages` resets
	// there: an effect runs after the frame carrying the new session id has been
	// committed, and that frame would show the previous session's questions under
	// the new session's chat. The drafts are keyed by session and are untouched.
	const [sheetSessionId, setSheetSessionId] = useState(sessionId);
	if (sheetSessionId !== sessionId) {
		setSheetSessionId(sessionId);
		setAnswerAnchor(null);
	}

	// The one-shot intent set by whatever navigated here. Consumed once the
	// session's history is in, so the sheet does not open over a skeleton and
	// then have to find its anchor in a transcript that is not there yet. It is
	// not a URL: a route that opened the sheet would re-open it on every reload
	// and every share of the link (docs/answering-ui.md §4).
	useEffect(() => {
		if (isChatPending || isReadOnly) return;
		const intent = takeAnswerIntent(sessionId);
		if (intent) setAnswerAnchor({ requestId: intent.requestId });
	}, [sessionId, isChatPending, isReadOnly]);

	const unanswered = turn.unanswered ?? [];

	const handleSendAnswers = useCallback(
		async (content: string, answering: QuestionAnswerRecord[]) => {
			await sendUserMessage(content, answering);
		},
		[sendUserMessage],
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
	const isSheetOpen = Boolean(forkAnchor) || answerAnchor !== null;

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
			// A read the server refused, said out loud rather than left as an empty
			// transcript: the reader would otherwise conclude the conversation was
			// empty, which is the one thing a failure must not be allowed to say.
			if (
				view &&
				viewedSession &&
				(viewedSession.isMissing || viewedSession.error)
			) {
				return (
					<div
						role="alert"
						className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-th-text-muted"
					>
						{viewedSession.isMissing
							? `This session is not in "${view.label}" any more.`
							: viewedSession.error}
					</div>
				);
			}
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
					// The openers a transcript carries for answering back, all
					// withheld on a viewed session for the one reason: there is no
					// process there to hear any of them. Each card already draws
					// itself without a control when it is given none — a pending
					// card that offers nothing is the truth here, not the dead end
					// it would be in a live session. The question card is the one
					// that needs this: its status comes from the records, not from
					// the turn, so "Answer this" otherwise survives into a screen
					// whose answer sheet is not rendered at all. The other two are
					// the same statement made where it cannot drift.
					onPermissionRespond={isReadOnly ? undefined : handlePermissionRespond}
					onAnswerQuestion={isReadOnly ? undefined : handleAnswerQuestion}
					onHintClick={isReadOnly ? undefined : handleSend}
					isReadOnly={isReadOnly}
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
						!isReadOnly && onSelectSession && forkSupport !== "none"
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
						segment={workSegment}
						onSelectSegment={onSelectWorkSegment ?? noop}
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
		<SessionViewProvider value={view}>
			<MainContainer
				title={projectTitle}
				onOpenSidebar={onOpenSidebar}
				onOpenSettings={onOpenSettings}
			>
				{!overlay && ChatTopContent && <ChatTopContent sessionId={sessionId} />}
				{!overlay && view && <SessionOriginBar view={view} />}
				{renderContent()}
				{/* What needs the user, stated where the transcript ends
				    (docs/lifecycle-ui.md §2.2). */}
				{!overlay && !isChatPending && !isReadOnly && (
					<AttentionStrip
						turn={turn}
						onJumpToRequest={handleJumpToRequest}
						onAnswer={handleOpenAnswerSheet}
						sendPending={isSendPending}
					/>
				)}
				{/* Session action bar */}
				{!overlay && settingError && (
					<SettingErrorBar
						message={settingError}
						onDismiss={clearSettingError}
					/>
				)}
				{!overlay && (
					<div className="flex shrink-0 items-center justify-between border-t border-th-border bg-th-bg-secondary px-3 py-1.5">
						{/* gap-2, not tighter: three neighbouring hit areas now sit in this
						    row, and 8px between them is the coarse-pointer floor. */}
						<div className="flex min-w-0 items-center gap-2">
							{/* Removed rather than disabled on a viewed session: disabled
							    reads as "not just now", and what is missing is the
							    execution environment itself. */}
							{isReadOnly || CustomEngineSelector === null ? null : (
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
							{isReadOnly ||
							CustomModeSelector === null ? null : CustomModeSelector ? (
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
									detail={sessionDetail}
									onOpenWorkDetail={onOpenWorkDetail}
								/>
							)}
						</div>
						{/* Stop exists for every open turn, blocked ones included: the
						    process is alive, and Stop is one of the user's two exits from
						    a blocked turn — the card being the other. */}
						{turnOpen && !isReadOnly ? (
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
				{/* Mounted under the panel, so a session switch takes it with it. Not
				    rendered behind an overlay: the overlay has replaced the transcript
				    the sheet belongs to. */}
				{!overlay && !isReadOnly && answerAnchor && (
					<AnswerSheet
						sessionId={sessionId}
						unanswered={unanswered}
						anchorRequestId={answerAnchor.requestId}
						onSend={handleSendAnswers}
						onClose={handleCloseAnswerSheet}
					/>
				)}
				{!isInputBarHidden(overlay) &&
					(view ? (
						<ReadOnlyBar view={view} onOpenThere={onOpenSessionThere} />
					) : (
						<InputBar
							sessionId={sessionId}
							onSend={handleSend}
							canSend={
								status === "connected" && !isChatPending && !promptOwnsInput
							}
							disabled={!isSessionResolved}
							turnOpen={turnOpen}
							onStop={handleInterrupt}
						/>
					))}
			</MainContainer>
		</SessionViewProvider>
	);
}

export default ChatPanel;
