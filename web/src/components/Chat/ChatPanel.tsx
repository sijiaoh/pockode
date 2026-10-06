import {
	CoveredSurface,
	useHasCoarsePointer,
	useIsPageCovered,
} from "@pockode/shared";
import { AlertTriangle, X } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useChatMessages } from "../../hooks/useChatMessages";
import { readDraft } from "../../hooks/useComposerDraft";
import { SKELETON_DELAY_MS, useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useForkSession } from "../../hooks/useForkSession";
import { useForkSupport } from "../../hooks/useForkSupport";
import { useShortViewport } from "../../hooks/useShortViewport";
import { useViewedSession } from "../../hooks/useViewedSession";
import { sessionActivity } from "../../lib/activity";
import { takeAnswerIntent } from "../../lib/answerIntent";
import type { ChatAttachment } from "../../lib/chatAttachments";
import {
	attachmentActions,
	inputActions,
	useInputStore,
} from "../../lib/inputStore";
import { collectPartsDeep } from "../../lib/partTree";
import { questionDraftActions } from "../../lib/questionDraftStore";
import {
	type SendOutcome,
	useChatUIConfig,
} from "../../lib/registries/chatUIRegistry";
import {
	selectSessionDetail,
	useSessionDetailStore,
} from "../../lib/sessionDetailStore";
import { NEW_SESSION_TITLE, useSessionStore } from "../../lib/sessionStore";
import { type SessionView, SessionViewProvider } from "../../lib/sessionView";
import { useWorkStore } from "../../lib/workStore";
import { useIsGitRepo } from "../../lib/worktreeStore";
import { useWSStore } from "../../lib/wsStore";
import type {
	HistorySeq,
	PermissionRequest,
	QuestionAnswerRecord,
	UserMessage,
} from "../../types/message";
import {
	isGitOverlay,
	type OverlayState,
	type WorkSegment,
} from "../../types/overlay";
import type { AgentType } from "../../types/settings";
import { restoreIntoDraft } from "../../utils/discardedMessage";
import { type ForkAnchor, resolveForkAnchor } from "../../utils/forkAnchor";
import { buildForkTitle } from "../../utils/forkTitle";
import { parsePockodeCommand } from "../../utils/pockodeCommand";
import {
	type SendAgainTarget,
	sendAgainMessage,
	sendAgainTarget,
	sendAgainText,
} from "../../utils/sendAgain";
import CliLoginSheet from "../CliLogin/CliLoginSheet";
import { FileEditor, FileView } from "../Files";
import { CommitDiffView, CommitFileView, CommitView, DiffView } from "../Git";
import MainContainer from "../Layout/MainContainer";
import PageHeader, {
	PageHeaderTarget,
	usePageHeaderHost,
} from "../Layout/PageHeader";
import {
	AgentRoleDetailOverlay,
	AgentRoleListOverlay,
	WorkDetailOverlay,
	WorkListOverlay,
} from "../Project";
import { SettingsPage } from "../Settings";
import AnswerPanel from "./AnswerPanel";
import AttentionStrip, { type PermissionEntry } from "./AttentionStrip";
import ChatSkeleton from "./ChatSkeleton";
import ForkSessionSheet from "./ForkSessionSheet";
import DefaultInputBar from "./InputBar";
import type { PromptError } from "./MessageItem";
import MessageList, { type MessageListHandle } from "./MessageList";
import ReadOnlyBar from "./ReadOnlyBar";
import SessionHeader from "./SessionHeader";
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
 * A refusal of something the user just did from the composer, in the server's
 * words.
 *
 * Changing the engine or the mode is a deliberate action whose only other
 * feedback is the control snapping back to where it was. One bar for all three
 * settings — the server's reason is what tells "that model isn't this agent's"
 * apart from a dropped connection. A refused Pockode command lands here too: its
 * echo is taken back out, so this bar is the only place the reason can be.
 */
function ComposerErrorBar({
	message,
	onDismiss,
}: {
	message: string;
	onDismiss: () => void;
}) {
	return (
		<div
			role="alert"
			className="shrink-0 border-t border-th-border bg-th-bg-secondary py-1.5 text-xs text-th-error"
		>
			{/* Bounded like the transcript column, so the dismiss sits under the
			    column's right edge rather than at the window's. */}
			<div className="mx-auto flex max-w-3xl items-start gap-2 px-3 sm:px-4">
				<AlertTriangle
					className="mt-0.5 size-3.5 shrink-0"
					aria-hidden="true"
				/>
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
	const isGitRepo = useIsGitRepo();
	const { InputBar: CustomInputBar, ChatTopContent } = useChatUIConfig();
	const InputBar = CustomInputBar ?? DefaultInputBar;

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
	// A viewed session whose read failed has no row and will get no detail, so
	// waiting for its name would pulse forever.
	const viewReadFailed =
		viewedSession !== null &&
		(viewedSession.isMissing || viewedSession.error !== null);
	const headerTitle =
		resolvedTitle || (viewReadFailed ? "Unavailable session" : "");

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
		tail,
		openedThoughtIds,
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

	// The strip says the session is watching by the rule its row is drawn by, so
	// the row's Eye and the strip's line come and go together
	// (docs/lifecycle-ui.md §1.2).
	const sessionWorkId = sessionDetail?.work_id;
	const sessionWork = useWorkStore((s) =>
		sessionWorkId ? s.works.find((w) => w.id === sessionWorkId) : undefined,
	);
	const watchedStories =
		sessionActivity(turn, sessionWork, sessionDetail?.watching) === "watching"
			? sessionDetail?.watched_stories
			: undefined;

	// The cards behind those blockers, for the strip to answer from. Looked up
	// at every depth: a subagent's request is filed under its Task call.
	const blockingPermissions = useMemo(() => {
		const ids = (turn.blockers ?? []).flatMap((b) =>
			b.kind === "permission" && b.request_id ? [b.request_id] : [],
		);
		if (ids.length === 0) return [];
		const cards = new Map<string, PermissionEntry>();
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const part of collectPartsDeep(
				message.parts,
				(p) => p.type === "permission_request",
			)) {
				if (part.type === "permission_request") {
					cards.set(part.request.requestId, part);
				}
			}
		}
		return ids.flatMap((id) => {
			const card = cards.get(id);
			return card ? [{ request: card.request, status: card.status }] : [];
		});
	}, [turn.blockers, messages]);

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

	// Keyed by the session it was sent to, so a refusal arriving after the user
	// has moved on is not reported into somebody else's conversation.
	const [commandError, setCommandError] = useState<{
		sessionId: string;
		message: string;
	} | null>(null);

	const handleSend = useCallback(
		(content: string, attachments?: ChatAttachment[]): Promise<SendOutcome> => {
			// A message that is only files is named after them.
			const titleSource =
				content || (attachments ?? []).map((a) => a.name).join(", ");
			const rename =
				resolvedTitle === NEW_SESSION_TITLE
					? () =>
							onUpdateTitle(
								titleSource.length > 30
									? `${titleSource.slice(0, 30).replace(/\n/g, " ")}...`
									: titleSource.replace(/\n/g, " "),
							)
					: undefined;
			// A message the server may refuse names the session only once it is
			// accepted, or a typo would stay behind as the title — a command, or
			// files the agent cannot receive. Still the session it was sent to: this
			// `onUpdateTitle` is the one from that render.
			const mayBeRefused =
				parsePockodeCommand(content) !== null || !!attachments?.length;
			if (!mayBeRefused) rename?.();

			setCommandError(null);
			const sentTo = sessionId;
			// Only a refused command or message with files rejects here (see
			// `sendUserMessage`): its echo is gone, so what was typed goes back into
			// the input — unless the user has already started something new there.
			return sendUserMessage(content, undefined, attachments).then(
				(sent): SendOutcome => {
					if (sent && mayBeRefused) rename?.();
					return "sent";
				},
				(error: unknown): SendOutcome => {
					if (content && !useInputStore.getState().inputs[sentTo]) {
						inputActions.set(sentTo, content);
					}
					setCommandError({
						sessionId: sentTo,
						message:
							error instanceof Error && error.message
								? error.message
								: "Unknown error",
					});
					return "refused";
				},
			);
		},
		[resolvedTitle, onUpdateTitle, sendUserMessage, sessionId],
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
		async (
			anchorSeq: HistorySeq,
			title: string,
			dropped: Pick<ForkAnchor, "droppedText" | "droppedAttachments">,
		) => {
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
				if (dropped.droppedText) {
					inputActions.set(forked.id, dropped.droppedText);
				}
				if (dropped.droppedAttachments) {
					attachmentActions.adopt(forked.id, dropped.droppedAttachments);
				}
				onSelectSession?.(forked.id);
			} catch {
				// Reported through forkError in the sheet, which stays open: landing
				// the user in a session that may not exist is worse than the error.
			}
		},
		[forkSession, sessionId, onSelectSession],
	);

	// The CLI being signed in from a failed turn's notice, and that turn. Held
	// here for the fork sheet's reason: the sign-in belongs to the session, not
	// to the bubble it was opened from.
	const [signInTarget, setSignInTarget] = useState<
		(SendAgainTarget & { agent: AgentType; sessionId: string }) | null
	>(null);
	const [inputFocusRequest, setInputFocusRequest] = useState(0);
	// Read rather than subscribed, and inside the handler so it stays stable for
	// the memoized bubbles: the turn's place in history is taken at the press.
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const handleSignIn = useCallback(
		(agent: AgentType, messageId: string) => {
			setSignInTarget({
				agent,
				sessionId,
				...sendAgainTarget(messagesRef.current, messageId),
			});
		},
		[sessionId],
	);
	const handleCloseSignIn = useCallback(() => setSignInTarget(null), []);
	const hasDraft = useInputStore(
		(state) => !!state.inputs[sessionId] || !!state.attachments[sessionId],
	);
	// Read against the transcript as it is now, not as it was when the sheet
	// opened: a turn that has since been followed by another is not the latest,
	// and one that was still retrying may have failed since. Only in the session
	// it was opened from: the panel outlives a session switch (a swipe back while
	// the sheet is up), and a history seq means nothing in another session.
	const resendMessage =
		signInTarget && signInTarget.sessionId === sessionId
			? sendAgainMessage(messages, signInTarget)
			: undefined;
	const resendText =
		signInTarget && signInTarget.sessionId === sessionId
			? sendAgainText(messages, signInTarget)
			: undefined;
	const handleSendAgain = useCallback(() => {
		if (resendText === undefined) return;
		inputActions.set(sessionId, resendText);
		// The files too, or the message would go again without them.
		if (resendMessage?.attachments) {
			attachmentActions.adopt(sessionId, resendMessage.attachments);
		}
		setSignInTarget(null);
		// In the same commit as the sheet closing, whose cleanup hands focus
		// back to the notice's button first; the bar's effect runs after it.
		setInputFocusRequest((n) => n + 1);
	}, [resendText, resendMessage, sessionId]);

	// Messages a Stop threw away, back into the composer: added after whatever
	// is there and never over it, only the parts it is missing, and never sent
	// (docs/discarded-messages-ui.md). The draft is read at the press, so the
	// memoized bubbles keep one handler.
	const handleRestoreMessages = useCallback(
		(restored: UserMessage[]) => {
			const { text, attachments } = restoreIntoDraft(
				readDraft(sessionId),
				restored,
			);
			if (text !== undefined) inputActions.set(sessionId, text);
			if (attachments.length > 0) {
				attachmentActions.adopt(sessionId, attachments);
			}
			setInputFocusRequest((n) => n + 1);
		},
		[sessionId],
	);

	// Whether the answer panel is open. Held rather than derived from
	// `unanswered.length`, which is the obvious shortcut and a lossy one: the
	// panel has to stay up saying "Nothing left to answer." when the last
	// question is answered from somewhere else, because the user may be halfway
	// through typing into it (docs/answering-ui.md §3). A derived flag would
	// take it, and their words, away in that very frame.
	//
	// It lives here because the panel answers for the whole session rather than
	// for any one bubble, and because three separate openers reach it
	// (docs/answering-ui.md §4).
	const [answerPanelOpen, setAnswerPanelOpen] = useState(false);
	// Which question the panel opens on, and — by being there at all — that the
	// panel has to read itself out, which is what decides whether it takes
	// focus. Set by the three openers a user can press, and by the focus rescue
	// below, which names no question. `null` is "nobody named anything": the
	// panel opens on the oldest question and leaves the caret where it is.
	const [answerAnchor, setAnswerAnchor] = useState<{
		requestId?: string;
	} | null>(null);
	// The questions this stretch of looking at the chat has already put on
	// screen. Closing the panel lasts exactly one such stretch: every way out of
	// it — switching sessions, reloading the page, opening an overlay over the
	// transcript — empties this set, so whatever is still unanswered on the way
	// back reads as unseen and the panel comes up again, even if the user closed
	// it by hand. An unanswered question is where the work has stopped, and a
	// close says "not now"; going away and coming back is what ends that "now"
	// (docs/answering-ui.md §4).
	//
	// Within one stretch it is the whole of the difference between a question
	// the user has already dismissed the panel over and one that has just
	// arrived: only the second opens it again.
	const seenQuestionIdsRef = useRef<Set<string>>(new Set());
	// Whether the caret is in the composer, which on a short touch screen is
	// what makes the panel step aside (see `answerPanelYielded` below).
	const [composerFocused, setComposerFocused] = useState(false);

	// Clearing `composerFocused` is what ends a yield, and it is done here rather
	// than left to the composer's blur: the card is `inert` while it has yielded,
	// focus cannot be moved into it until that is gone, and whether the blur or
	// the press arrives first is the browser's to decide.
	const openAnswerPanel = useCallback((requestId?: string) => {
		setAnswerPanelOpen(true);
		setAnswerAnchor({ requestId });
		setComposerFocused(false);
	}, []);
	const handleOpenAnswerPanel = useCallback(
		() => openAnswerPanel(),
		[openAnswerPanel],
	);
	const handleAnswerQuestion = useCallback(
		(requestId: string) => openAnswerPanel(requestId),
		[openAnswerPanel],
	);
	const handleCloseAnswerPanel = useCallback(() => {
		setAnswerPanelOpen(false);
		setAnswerAnchor(null);
	}, []);
	// The panel belongs to one session's questions, so a switch closes it — and
	// the destination opens its own below, for its own questions. During
	// render rather than in an effect, for the reason `useChatMessages` resets
	// there: an effect runs after the frame carrying the new session id has been
	// committed, and that frame would show the previous session's questions under
	// the new session's chat. The drafts are keyed by session and are untouched.
	//
	// `panelReset` keeps the auto-open below out of this render: the state it
	// would read is the one being thrown away here, and the re-render this
	// setState causes arrives before anything is painted.
	const [panelSessionId, setPanelSessionId] = useState(sessionId);
	let panelReset = false;
	if (panelSessionId !== sessionId) {
		setPanelSessionId(sessionId);
		setAnswerPanelOpen(false);
		setAnswerAnchor(null);
		seenQuestionIdsRef.current = new Set();
		panelReset = true;
	}

	// An overlay replaces the transcript, and takes the panel with it. The
	// anchor does not survive that: it stands for a tap on `Answer` that has
	// been served, and the panel coming back when the overlay closes is the
	// app's doing rather than the user's — so it must neither scroll to that
	// question again nor take the caret out of the composer
	// (docs/answering-ui.md §4). That it comes back is not in question: a
	// closed panel does not survive the trip either (see the seen set below).
	const overlayOpen = Boolean(overlay);
	const [panelOverlayOpen, setPanelOverlayOpen] = useState(overlayOpen);
	if (panelOverlayOpen !== overlayOpen) {
		setPanelOverlayOpen(overlayOpen);
		if (overlayOpen) {
			setAnswerAnchor(null);
			// An overlay is the user looking at something else, so the stretch a
			// close belonged to ends here: closing the overlay is re-entering the
			// chat, and re-entering re-opens. The rule gets no exception for
			// overlays — that is where a rule this short starts to rot.
			seenQuestionIdsRef.current = new Set();
		}
		panelReset = true;
	}

	// The one-shot intent set by whatever navigated here. Consumed once the
	// session's history is in, so the panel does not open over a skeleton and
	// then have to find its anchor in a transcript that is not there yet. It is
	// not a URL: a route that opened the panel would re-open it on every reload
	// and every share of the link (docs/answering-ui.md §4).
	//
	// `overlayOpen` is in the list because the work detail is itself an overlay
	// over this panel: pressing `Answer` on a question of the session already on
	// screen navigates out of the overlay and changes nothing else, so without
	// it the intent would never be read and that entry point would do nothing at
	// all. Re-running costs nothing — the intent is one-shot and names the
	// session it belongs to.
	useEffect(() => {
		if (isChatPending || isReadOnly || overlayOpen) return;
		const intent = takeAnswerIntent(sessionId);
		if (intent) openAnswerPanel(intent.requestId);
	}, [sessionId, isChatPending, isReadOnly, overlayOpen, openAnswerPanel]);

	const unanswered = turn.unanswered ?? [];

	// The seen set below holds only what is still waiting. A question that
	// leaves the list leaves the set too, so one coming back — its answer
	// thrown away unread by a Stop (docs/answering-ui.md §4) — is one this
	// stretch has not shown: the close was about it waiting, and the answer
	// since given has been taken back. Not before the first snapshot, whose
	// placeholder turn carries no list at all.
	if (isSessionDetailLoaded) {
		for (const id of seenQuestionIdsRef.current) {
			if (!unanswered.some((q) => q.request_id === id)) {
				seenQuestionIdsRef.current.delete(id);
			}
		}
	}

	// The panel shows itself. Nothing has to be pressed to read a question, and
	// the one way it stays down is the user having closed it during this same
	// stretch of looking at this chat.
	//
	// The gate: a question waiting, the chat itself on screen (a read-only
	// session has no panel, a pending one has a skeleton), and no permission
	// request in the way. That last one is here because the server refuses an
	// answer while a permission request is outstanding, so a panel opened over
	// it could only be typed into and then turned away — the strip's first row
	// is what has to be dealt with instead. (A panel *already* open is left
	// alone when one arrives: docs/answering-ui.md §7. That is why this only
	// ever sets the flag, never clears it.)
	//
	// During render, not in an effect: an effect would paint one frame of
	// uncovered transcript first, and the panel appearing a beat after the chat
	// reads as something the app did rather than as the state it was in.
	//
	// Only the open branch adds to the set, and it says one thing: what is on
	// screen has been seen. Opening leaves it alone and lets the very next
	// render — the one this setState causes, before anything is painted — do
	// the writing, so a render that runs twice (StrictMode does that) cannot
	// mark a question seen without it having been shown.
	//
	// `setAnswerPanelOpen` alone, never `openAnswerPanel`: that one also sets
	// the anchor, and an anchor is what tells the panel to take focus. Nobody
	// named a question here, and the user may be typing in the composer.
	if (!panelReset && !overlayOpen) {
		if (answerPanelOpen) {
			// Otherwise closing the panel on a question that arrived while it was
			// open would bring it straight back up.
			for (const q of unanswered) seenQuestionIdsRef.current.add(q.request_id);
		} else if (
			!isReadOnly &&
			!isChatPending &&
			!promptOwnsInput &&
			unanswered.some((q) => !seenQuestionIdsRef.current.has(q.request_id))
		) {
			setAnswerPanelOpen(true);
		}
	}

	// Drafts read back from storage are only put on screen once this session's
	// unanswered list has arrived and is seen to still carry their question;
	// anything else is dropped, storage included. Here rather than in the panel
	// because the panel is only mounted while it is open, and a draft left by a
	// question that has since been answered has to be cleared out whether or not
	// the user opens it (docs/answering-ui.md §5).
	//
	// `isSessionDetailLoaded` is the whole of the check and not a nicety: until
	// that first snapshot `turn` is a placeholder carrying no list at all, and
	// reading its absent list as an empty one would discard every draft the page
	// was reloaded to keep.
	//
	// A layout effect, so a panel that is already open is repainted with the
	// draft in it rather than showing one frame of empty fields first.
	useLayoutEffect(() => {
		if (isReadOnly || !isSessionDetailLoaded) return;
		questionDraftActions.restore(
			sessionId,
			(turn.unanswered ?? []).map((q) => q.request_id),
		);
	}, [sessionId, isReadOnly, isSessionDetailLoaded, turn.unanswered]);

	// One expression for whether the panel is up, read by its own rendering, by
	// the `inert` over the transcript it covers and by the Escape guard below,
	// so those three cannot disagree — an `inert` outliving the panel would take
	// the whole conversation out of reach with nothing on top of it.
	const answerPanelShown = !isReadOnly && answerPanelOpen;

	// The converse of the fold below (docs/answering-ui.md §3, "Room on a short
	// viewport"): on a short touch screen the card and the chrome under it never
	// share the screen, and the caret says which one has it. In the card, the
	// chrome folds; in the composer, the card steps aside — off the screen but
	// still open, so the strip offers its `Answer` row exactly as after a close,
	// and the card comes back as it was the moment the caret leaves.
	//
	// The primary pointer is part of it because the composer focuses itself on
	// mount under a fine one: in a short desktop window the chrome coming back
	// would hand the composer the caret and the card would vanish on the press
	// that left it. A fine pointer has no soft keyboard to make room for anyway.
	const isShortViewport = useShortViewport();
	const isPrimaryPointerCoarse = useHasCoarsePointer();
	const answerPanelYielded =
		answerPanelShown &&
		composerFocused &&
		isShortViewport &&
		isPrimaryPointerCoarse;
	// The one flag for "the card is on the screen", read by the strip's row and
	// by the transcript's `inert`, so the row and the card swap in one frame.
	const answerPanelOnScreen = answerPanelShown && !answerPanelYielded;
	// A yield is the card going off the screen, and the anchor does not survive
	// it any more than it survives an overlay: coming back is the app's doing,
	// so the card must neither scroll nor take the caret. Clearing it also
	// re-arms the panel's focus edge, which the rescue below and a press on
	// `Answer` both need.
	const [anchorYielded, setAnchorYielded] = useState(answerPanelYielded);
	if (anchorYielded !== answerPanelYielded) {
		setAnchorYielded(answerPanelYielded);
		if (answerPanelYielded) setAnswerAnchor(null);
	}

	// Where the panel is actually drawn. It is positioned over the transcript,
	// so it exists only where the transcript does: not over an overlay, and not
	// over the skeleton that stands in until the history is in. Both used to
	// come for free — an overlay replaced this whole branch, and the skeleton
	// returned before the wrapper the panel hangs from. The list staying mounted
	// through an overlay (below) is what turns them into something that has to
	// be said out loud.
	const answerPanelDrawn = answerPanelShown && !overlayOpen && !isChatPending;

	// Everything drawn over the transcript, in one expression, because the
	// transcript's `inert` has to name all of them: a conversation left reachable
	// under an overlay would put every card and menu button in the Tab order
	// ahead of the thing on top of it. A card that has yielded covers nothing.
	const transcriptInert =
		(answerPanelDrawn && answerPanelOnScreen) || overlayOpen;

	// Covered, which is a shorter list than the one above, and the difference is
	// the whole of it: the answer panel is a layer of this conversation — it
	// dims the transcript and puts it out of reach, but leaves it on the screen
	// and leaves the user in the chat. An overlay is somewhere else, so the
	// transcript goes off the screen entirely and stays mounted only to give the
	// reader their place back.
	//
	// One name for both of the things that follow from that: the class that
	// takes the transcript off the screen, and the `CoveredSurface` that takes
	// the sheets it raised off with it. A sheet portalled to the body is out of
	// reach of `invisible` and `inert` alike, so without the second one a fork
	// menu opened here would go on floating over the overlay, lit and clickable.
	// Sheets under a *dimmed* transcript are not touched: nobody has gone
	// anywhere, and the forty `…` glyphs stay exactly where they are.
	const transcriptCovered = overlayOpen;

	// Room for the card on a screen that has none (docs/answering-ui.md §3,
	// "Room on a short viewport"). Three facts, and each one of them is what
	// stops a different way of getting this wrong:
	//
	// - the panel is up, so there is something to make room for;
	// - the user is working inside it, so the soft keyboard — if there is one —
	//   belongs to a field in the card. Without this, a question arriving while
	//   somebody is halfway through a sentence in the composer would fold the
	//   composer, their half-sentence and the keyboard away under them;
	// - the viewport is short, so the room is actually needed. On a desktop
	//   nothing is competing for it, and folding a composer nobody is crowding
	//   would be a change for its own sake.
	//
	// The decision lives here rather than in either folded component because
	// this is the only place that knows all three, and the two of them know
	// nothing of each other. The card is handed the same flag rather than asking
	// the screen itself: the room it takes — its whole rectangle, its header
	// folded into the footer — exists only while the chrome is folded, and one
	// flag is what keeps the two from ever disagreeing.
	const [answerPanelFocused, setAnswerPanelFocused] = useState(false);
	// A closed panel has no focus to report, and its last word on the way out is
	// not always delivered — a card unmounted under the caret fires no blur. So
	// the flag is cleared from the fact that owns it, and a panel that opens
	// again starts from "not in it yet".
	useEffect(() => {
		if (!answerPanelShown) setAnswerPanelFocused(false);
	}, [answerPanelShown]);
	const chromeCollapsed =
		answerPanelShown && answerPanelFocused && isShortViewport;
	// The same reasoning as the card's flag above, for the composer: it is
	// unmounted by the fold and by an overlay, and a bar removed under the caret
	// fires no blur — left standing, the flag would make the card yield to a
	// composer that is not there.
	const composerMounted =
		!view && !isInputBarHidden(overlay) && !chromeCollapsed;
	useEffect(() => {
		if (!composerMounted) setComposerFocused(false);
	}, [composerMounted]);

	// Catching the focus the panel's arrival drops. The transcript goes `inert`
	// in the same commit the panel comes on screen in — mounting, or returning
	// from a yield — and a control focused inside it —
	// a message's menu button the user had just tabbed to — is blurred onto
	// `<body>`, from where Tab restarts at the top of the page rather than
	// entering the panel that is the reason it moved.
	//
	// Where focus *was* is the whole of the question, and by the time any effect
	// runs the answer has been thrown away, so it is remembered as it happens. A
	// document listener rather than `onFocusCapture` on the wrapper: React's
	// blur event for that same `inert` is dispatched before layout effects run,
	// so a flag cleared on blur would already be false by the time this asks.
	const transcriptRef = useRef<HTMLDivElement>(null);
	const lastFocusedRef = useRef<Element | null>(null);
	useEffect(() => {
		const remember = (e: FocusEvent) => {
			if (e.target instanceof Element) lastFocusedRef.current = e.target;
		};
		document.addEventListener("focusin", remember);
		return () => document.removeEventListener("focusin", remember);
	}, []);
	// Nothing else is taken: focus held in the composer, the strip or the header
	// is still the user's, and those three stay lit beside the panel rather than
	// behind it.
	//
	// The rescue is recorded as an anchor, which is the app's existing word for
	// "this panel has to read itself out", rather than as a second flag beside
	// it. That is not only shorter: the anchor is already cleared by everything
	// that ends the reason for it — an overlay opening, a session switch, the
	// panel closing — so a rescue cannot survive a trip through a file view and
	// make the panel announce itself on the way back, which is the one thing an
	// automatic re-show must not do. An anchor with no request id names no
	// question, so nothing scrolls.
	//
	// A layout effect and the re-render it causes, so the rescue lands in the
	// same paint the panel appears in.
	useLayoutEffect(() => {
		if (!answerPanelOnScreen) return;
		const last = lastFocusedRef.current;
		if (!last || !transcriptRef.current?.contains(last)) return;
		// Never over an anchor already there: that one names a question, and this
		// one does not.
		setAnswerAnchor((prev) => prev ?? {});
	}, [answerPanelOnScreen]);

	const handleSendAnswers = useCallback(
		async (answering: QuestionAnswerRecord[]) => {
			await sendUserMessage("", answering);
		},
		[sendUserMessage],
	);

	// The jump lives with the scroll container; the strip below the list asks for
	// it rather than reimplementing it.
	const messageListRef = useRef<MessageListHandle>(null);
	// Closing the panel is part of the jump, not a side effect of it. The only
	// caller is the strip's permission row, and a permission request can arrive
	// while the panel is up — which is exactly when the card being jumped to is
	// behind the backdrop and `inert`. Scrolling something the user cannot see
	// or press is the dead end this whole surface exists to remove, and with the
	// transcript covered this row is the only way left to reach a permission
	// card at all; the drafts survive the close, so the cost is one tap on
	// `Answer` afterwards.
	//
	// So the press only asks for the jump; the jump itself waits for the close
	// to be on the screen. It has to: the last thing it does is move focus into
	// the card, and focus into an `inert` subtree is dropped by the spec —
	// silently, which is why scroll and highlight would go on looking right
	// while the keyboard half of the jump was lost. `setAnswerPanelOpen` is
	// state, so the commit that takes `inert` off comes after this handler
	// returns; ordering the two lines differently changes nothing.
	//
	// Not while the panel is sending, the same as its own ways out: a
	// permission request can come up mid-send, and closing then would take
	// away the only place the send's outcome — a refusal included — is told.
	const [answerPanelSending, setAnswerPanelSending] = useState(false);
	const [pendingJumpRequestId, setPendingJumpRequestId] = useState<
		string | null
	>(null);
	const handleJumpToRequest = useCallback((requestId: string) => {
		setAnswerPanelOpen(false);
		setAnswerAnchor(null);
		setPendingJumpRequestId(requestId);
	}, []);
	// The request is read in the commit the press produced, which is the one the
	// close is in: `transcriptInert` is the same value the DOM attribute is
	// written from, so this is the cover being gone rather than a delay guessed
	// to outlast it. A layout effect, so the scroll and the focus land in the
	// paint the uncovered transcript first appears in — a `useEffect` would
	// paint the card where it was and move it afterwards.
	//
	// Asked for once and answered once, never held for later: anything still
	// covering the transcript here is not the panel this press put away — an
	// overlay, or a question that arrived in the same frame and raised the panel
	// again — and a jump kept waiting for that to end would tear the view and
	// the caret away whenever the user was finally done with it. The strip's row
	// is still there to press again.
	useLayoutEffect(() => {
		if (pendingJumpRequestId === null) return;
		setPendingJumpRequestId(null);
		if (transcriptInert) return;
		messageListRef.current?.jumpToRequest(pendingJumpRequestId);
	}, [pendingJumpRequestId, transcriptInert]);

	const forkAnchor = forkTarget
		? resolveForkAnchor(messages, forkTarget.messageId, hasMoreHistory)
		: null;
	// Any overlay — a shared sheet or dialog raised from anywhere, a dropdown,
	// the session drawer — has to be asked about rather than trusted to claim
	// the key: neither `stopPropagation` nor a `preventDefault` made after this
	// sibling `document` listener has run can stop it. Every one of them counts
	// itself as covering the page (`useCoverPage`).
	//
	// The answer panel is not in that count — it is drawn in the transcript's
	// rectangle and leaves the page usable — so it is named here, and that
	// is the whole of what it costs to dim the transcript: the user is looking
	// at a covered conversation, so Escape has to mean "put this away". It does
	// not hold focus — it shows itself — so leaving the key here would turn a
	// press aimed at the panel into an interrupt of the agent's turn, which
	// cannot be undone. The panel claims Escape on the window for as long as it
	// is up; pressing it again, with the panel gone, interrupts.
	const isPageCovered = useIsPageCovered();
	const isSheetOpen = isPageCovered || answerPanelShown;

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

	// What the transcript region shows. Rendered whether or not an overlay is
	// up: an overlay covers this, it no longer replaces it.
	const renderTranscript = () => {
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
				tail={tail}
				openedThoughtIds={openedThoughtIds}
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
				// whose answer panel is not rendered at all. The other two are
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
				// the parent with no sign anything happened, so the fork row waits
				// for a host that can navigate. Restoring a discarded message needs
				// none and brings its own slot (docs/session-fork-ui.md, "Which rows
				// reserve a slot").
				onForkMessage={
					!isReadOnly && onSelectSession && forkSupport !== "none"
						? handleStartFork
						: undefined
				}
				onSignIn={isReadOnly ? undefined : handleSignIn}
				onRestoreMessages={isReadOnly ? undefined : handleRestoreMessages}
			/>
		);
	};

	// A git view waits, blank, until the server has said this is a repository;
	// the shell replaces the route if it is not. Mounting it early would send
	// reads that can only fail and flash their error first.
	const isOverlayHeld = isGitOverlay(overlay) && !isGitRepo;

	// An overlay is a page of its own, so the header names that page rather than
	// the session behind it: no session there to read or reconfigure. The page
	// supplies its own heading; until it does, the project's name stands.
	const pageHeader = usePageHeaderHost();
	const renderHeading = () => {
		if (overlay) return pageHeader.claimed ? pageHeader.outlet : undefined;
		// A route naming no session leaves nothing to describe, so the header
		// keeps the project's name and offers no panel.
		if (sessionId === "") return undefined;
		return (
			<SessionHeader
				title={headerTitle}
				detail={sessionDetail}
				onOpenWorkDetail={onOpenWorkDetail}
				readOnly={isReadOnly}
				agentType={agentType}
				model={model}
				effort={effort}
				mode={mode}
				hasSessionSettings={hasSessionSettings}
				isSessionActivated={isSessionActivated}
				turnOpen={turnOpen}
				onAgentTypeChange={setAgentType}
				onModelChange={setModel}
				onEffortChange={setEffort}
				onModeChange={setMode}
			/>
		);
	};

	const renderOverlay = (overlay: NonNullable<OverlayState>) => {
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

	// The panel and its backdrop are positioned against this wrapper rather than
	// portalled to the body, so the rectangle they cover is the transcript's own:
	// no header height, composer height or strip height to measure, and two of
	// those change because of this very feature. Dimming stops at this
	// rectangle's edges, which is what leaves the composer, the strip and the
	// header lit and usable. `relative` belongs here and not on `MessageList`,
	// whose empty-conversation branches have no `relative` of their own for the
	// panel to escape through.
	//
	// An overlay is drawn in the same rectangle, over the same transcript, for
	// the same reason the answer panel is: what it covers is a conversation the
	// user is coming back to.
	const renderContent = () => (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{/* The list is covered, never unmounted — by the answer panel and by
			    an overlay alike. Its scroll position, its expanded cards and its
			    highlight ring are what the user gets back on closing whatever
			    covered it, and none of those live anywhere but in this subtree;
			    re-mounting loses all three. (The history does survive a re-mount
			    — `useChatMessages` is held here, above the cover — so what a
			    remount costs is the reader's place, not a reload.)

			    Under an overlay it is taken out of the flow rather than hidden
			    with `display: none`: a scroll container with no box has no scroll
			    position either, so `display: none` would throw away the very
			    thing staying mounted is for. `absolute inset-0` keeps it the size
			    of the rectangle the overlay now fills, so the height it comes
			    back to is the height it had — and `visibility: hidden` keeps that
			    box while taking it off the screen and out of the accessibility
			    tree.

			    `inert` rather than `pointer-events-none`, because with no focus
			    trap above them every covered button would otherwise still be in
			    the Tab order — ahead of what is covering them — and still in the
			    accessibility tree, which for a conversation plainly put out of
			    reach would be a lie.

			    Neither of those reaches what the transcript portals out of
			    itself — a message's fork menu — so `CoveredSurface` says the
			    same thing down the React tree, which a portal does not leave. */}
			<div
				ref={transcriptRef}
				inert={transcriptInert}
				className={
					transcriptCovered
						? "invisible absolute inset-0 flex flex-col"
						: "flex min-h-0 flex-1 flex-col"
				}
			>
				<CoveredSurface covered={transcriptCovered}>
					{renderTranscript()}
				</CoveredSurface>
			</div>
			<PageHeaderTarget value={pageHeader.target}>
				{overlay &&
					(isOverlayHeld ? (
						// Which page this will be is known, what it is about is not.
						<PageHeader back={null} title={null} subtitle={null} />
					) : (
						renderOverlay(overlay)
					))}
			</PageHeaderTarget>
			{answerPanelDrawn && (
				<AnswerPanel
					sessionId={sessionId}
					unanswered={unanswered}
					anchorRequestId={answerAnchor?.requestId}
					takeFocus={answerAnchor !== null}
					onSend={handleSendAnswers}
					onClose={handleCloseAnswerPanel}
					onFocusChange={setAnswerPanelFocused}
					onSendingChange={setAnswerPanelSending}
					chromeCollapsed={chromeCollapsed}
					yielded={answerPanelYielded}
				/>
			)}
		</div>
	);

	return (
		<SessionViewProvider value={view}>
			<MainContainer
				title={overlay ? projectTitle : resolvedTitle || projectTitle}
				heading={renderHeading()}
				onOpenSidebar={onOpenSidebar}
				// Already there: a way to the page the user is on would only reopen it.
				onOpenSettings={
					overlay?.type === "settings" ? undefined : onOpenSettings
				}
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
						onAnswer={handleOpenAnswerPanel}
						// Driven by the same flags that draw the panel, so the row goes
						// and the panel appears in one frame. Told rather than derived
						// inside the strip: a frame where both are on screen moves the
						// composer down and straight back up, and one open is then two
						// visible jumps. A yielded card is off the screen, so the row
						// is the way back to it, as after a close.
						answerPanelOpen={answerPanelOnScreen}
						sendPending={isSendPending}
						jumpDisabled={answerPanelSending}
						permissionRequests={blockingPermissions}
						// Answering does not close the answer panel: unlike the jump, it
						// needs nothing from the transcript, and it is what lets the
						// panel's own send through afterwards.
						onPermissionRespond={handlePermissionRespond}
						promptError={promptError ?? undefined}
						watchedStories={watchedStories}
						onOpenWorkDetail={onOpenWorkDetail}
					/>
				)}
				{/* Held back by an overlay like the composer's errors: the session
				    panel that raised it is not reachable from a page either. */}
				{!overlay && settingError && (
					<ComposerErrorBar
						message={settingError}
						onDismiss={clearSettingError}
					/>
				)}
				{!overlay && commandError?.sessionId === sessionId && (
					<ComposerErrorBar
						message={commandError.message}
						onDismiss={() => setCommandError(null)}
					/>
				)}
				{/* Gone if the anchor left the transcript — a session deleted, a
				    worktree switched away from. There is nothing left to confirm.

				    Raised from the transcript, held here only because a fork is a
				    session-level request belonging to no one bubble — so it is
				    the transcript's cover that decides it, not this bar's. Inside
				    the same `CoveredSurface` it closes when an overlay takes the
				    chat, which also clears `forkTarget`: coming back hands the
				    reader their conversation, not a confirmation of something
				    they navigated away from. */}
				<CoveredSurface covered={transcriptCovered}>
					{forkTarget && forkAnchor && (
						<ForkSessionSheet
							anchor={forkAnchor.message}
							droppedCount={forkAnchor.droppedCount}
							agentType={agentType}
							defaultTitle={forkTarget.defaultTitle}
							isForking={isForking}
							error={forkError}
							onFork={(title) =>
								handleFork(forkAnchor.anchorSeq, title, forkAnchor)
							}
							onClose={handleCloseFork}
						/>
					)}
					{signInTarget && (
						<CliLoginSheet
							agent={signInTarget.agent}
							onClose={handleCloseSignIn}
							sendAgain={
								resendText === undefined
									? undefined
									: {
											text: resendText,
											draftKept: hasDraft,
											onSendAgain: handleSendAgain,
										}
							}
						/>
					)}
				</CoveredSurface>
				{/* The keyboard is in one field at a time, and while this is
				    collapsed it is in the card's. Unmounting is safe for the same
				    reason the overlays above may do it: a draft has to outlive its
				    bar, which `InputBarProps` asks of every bar and the default one
				    answers with `inputStore` (docs/answering-ui.md §3, §5). Stop
				    lives in the bar and folds with it, though it is one of the
				    user's two exits from a blocked turn: one press outside the card
				    brings it back. */}
				{!isInputBarHidden(overlay) &&
					!chromeCollapsed &&
					(view ? (
						<ReadOnlyBar view={view} onOpenThere={onOpenSessionThere} />
					) : (
						// Read from outside the bar, the way the card reports its own
						// focus: the bar is a registry component, and what it renders
						// inside is its own business. `contents` so the wrapper takes no
						// part in the column's layout.
						// biome-ignore lint/a11y/noStaticElementInteractions: listens to focus moving through the bar; nothing here is a control
						<div
							className="contents"
							onFocus={() => setComposerFocused(true)}
							onBlur={(e) => {
								if (e.currentTarget.contains(e.relatedTarget)) return;
								setComposerFocused(false);
							}}
						>
							<InputBar
								sessionId={sessionId}
								onSend={handleSend}
								canSend={
									status === "connected" && !isChatPending && !promptOwnsInput
								}
								sendBlockedReason={
									promptOwnsInput ? "Allow or deny to send" : undefined
								}
								disabled={!isSessionResolved}
								turnOpen={turnOpen}
								onStop={handleInterrupt}
								focusRequest={inputFocusRequest}
							/>
						</div>
					))}
			</MainContainer>
		</SessionViewProvider>
	);
}

export default ChatPanel;
