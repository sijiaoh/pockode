import {
	AlertTriangle,
	Bot,
	ChevronRight,
	ExternalLink,
	ListTodo,
	SquareSlash,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import type { FullScreenSource } from "../../lib/fullScreen";
import { isHtmlRenderCard } from "../../lib/htmlRender";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import { outputLineCount } from "../../lib/textLines";
import { isTaskTool } from "../../lib/toolSummary";
import type { FileBlock } from "../../types/content";
import type {
	ContentPart,
	Message,
	PermissionRequest,
	PockodeCommandInvocation,
	QuestionAnswerRecord,
	SystemMessageMeta,
	UserMessage,
} from "../../types/message";
import type { AgentType } from "../../types/settings";
import { isRestorable } from "../../utils/discardedMessage";
import { forkUnavailableReason } from "../../utils/forkAnchor";
import { hasMessageActions } from "../../utils/messageActions";
import { workEventSubject, workEventWording } from "../../utils/systemMessage";
import { CollapsibleBody, MarkdownContent, useEverExpanded } from "../ui";
import AttachmentStrip from "./AttachmentStrip";
import AuthFailureNotice from "./AuthFailureNotice";
import { CanvasActionBubble } from "./CanvasActionBubble";
import { DiscardedNote, DiscardedSummary } from "./DiscardedMessage";
import { HeaderlessMainBlock } from "./HeaderlessMainBlock";
import { HtmlRenderCard } from "./HtmlRenderCard";
import MessageActions from "./MessageActions";
import MessageMenuTrigger, { type ForkBlocked } from "./MessageMenuTrigger";
import {
	type PermissionChoice,
	PermissionRequestItem,
} from "./PermissionRequestItem";
import QuestionRecordItem from "./QuestionRecordItem";
import { anchorBlocksProps, anchorCandidateProps } from "./scrollAnchor";
import TaskItem from "./TaskItem";
import ThinkingItem from "./ThinkingItem";
import ToolCallItem from "./ToolCallItem";
import { PartBlocks } from "./ToolList";
import { ToolRow } from "./ToolRow";
import { Section, type SectionFullScreen } from "./ToolSection";
import { TurnChangesCard } from "./TurnChangesCard";
import TurnTail from "./TurnTail";
import { useTranscriptView } from "./transcriptViewContext";

interface SystemItemProps {
	/** The part's, naming its body in full screen. */
	id: string;
	content: string;
}

interface SystemContent {
	subtype: string;
	status?: string;
}

function SystemItem({ id, content }: SystemItemProps) {
	const [expanded, setExpanded] = useState(false);
	const view = useTranscriptView();
	const label = useMemo(() => {
		const parsed: SystemContent = JSON.parse(content);
		return parsed.status
			? `${parsed.subtype}: ${parsed.status}`
			: parsed.subtype;
	}, [content]);
	const source = useMemo<FullScreenSource>(
		() => ({
			title: label,
			label: "System",
			noun: "system message",
			from: "start",
			copyText: content,
			content: { kind: "code", text: content, language: "json" },
		}),
		[label, content],
	);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<span className="italic text-th-text-muted">{label}</span>
			</button>
			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border p-2">
					<HeaderlessMainBlock
						name="system message"
						fullScreenKey={`system:${id}`}
						source={source}
						view={view}
						count={{ noun: "line", total: outputLineCount(content) }}
					>
						<pre className="text-th-text-muted">{content}</pre>
					</HeaderlessMainBlock>
				</div>
			</CollapsibleBody>
		</div>
	);
}

interface WorkEventItemProps {
	/** The message's, naming its body in full screen. */
	id: string;
	content: string;
	subtype?: string;
	meta?: SystemMessageMeta;
	onOpenWorkDetail?: (workId: string) => void;
	/** A Stop threw this message away before the agent read it. */
	discarded?: boolean;
}

/**
 * One thing that happened to a Pockode work, at the point in the stream where
 * it happened. It says only that — no status, no history, no live data: the
 * event is over, and what the work is doing now lives behind Details.
 */
function WorkEventItem({
	id,
	content,
	subtype,
	meta,
	onOpenWorkDetail,
	discarded,
}: WorkEventItemProps) {
	const [expanded, setExpanded] = useState(false);
	const { label, summary } = workEventWording(subtype, meta);
	// The subject's own title, even where the collapsed line names something
	// else (a finished child): expanded, it sits next to the link into that work.
	const { workId, title } = workEventSubject(subtype, meta);
	const view = useTranscriptView();
	const source = useMemo<FullScreenSource>(
		() => ({
			title: `Pockode · ${label}`,
			label: "Message",
			noun: "message",
			from: "start",
			copyText: content,
			content: { kind: "markdown", markdown: content },
		}),
		[label, content],
	);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<ListTodo className="size-3 shrink-0 text-th-text-muted" />
				<span className="shrink-0 text-th-text-muted">{`Pockode · ${label}`}</span>
				{summary && (
					<span className="min-w-0 truncate text-th-text-muted">{summary}</span>
				)}
				{discarded && (
					<span className="shrink-0 text-th-text-muted">· not read</span>
				)}
			</button>
			<CollapsibleBody expanded={expanded}>
				<div className="space-y-2 border-t border-th-border p-2">
					{(title || (workId && onOpenWorkDetail)) && (
						<div className="flex items-start gap-2">
							<p className="min-w-0 flex-1 break-words text-sm text-th-text-primary">
								{title}
							</p>
							{workId && onOpenWorkDetail && (
								<button
									type="button"
									onClick={() => onOpenWorkDetail(workId)}
									className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-th-accent hover:bg-th-overlay-hover"
								>
									<ExternalLink className="size-3" />
									Details
								</button>
							)}
						</div>
					)}
					<HeaderlessMainBlock
						name="message"
						fullScreenKey={`event:${id}`}
						source={source}
						view={view}
					>
						<MarkdownContent content={content} />
					</HeaderlessMainBlock>
				</div>
			</CollapsibleBody>
		</div>
	);
}

interface WarningItemProps {
	message: string;
	code: string;
}

function WarningItem({ message, code }: WarningItemProps) {
	return (
		<div className="flex items-start gap-2 rounded bg-th-warning/10 p-2 text-sm text-th-warning">
			<AlertTriangle className="size-4 shrink-0" />
			<div>
				<span>{message}</span>
				<span className="ml-2 text-xs opacity-70">({code})</span>
			</div>
		</div>
	);
}

interface RawItemProps {
	/** The part's, naming its body in full screen. */
	id: string;
	content: string;
}

function RawItem({ id, content }: RawItemProps) {
	const [expanded, setExpanded] = useState(false);
	const view = useTranscriptView();
	const everExpanded = useEverExpanded(expanded);
	const parsed = useMemo(() => {
		try {
			return JSON.parse(content) as { type?: unknown };
		} catch {
			return null;
		}
	}, [content]);
	const label = typeof parsed?.type === "string" ? parsed.type : "raw";
	// Re-indenting the payload is the expensive half and only the body reads it.
	const formatted = useMemo(
		() =>
			everExpanded ? (parsed ? JSON.stringify(parsed, null, 2) : content) : "",
		[everExpanded, parsed, content],
	);
	const source = useMemo<FullScreenSource | undefined>(
		() =>
			everExpanded
				? {
						title: label,
						label: "Raw",
						noun: "raw event",
						from: "start",
						copyText: formatted,
						content: parsed
							? { kind: "code", text: formatted, language: "json" }
							: { kind: "output", text: formatted },
					}
				: undefined,
		[everExpanded, label, formatted, parsed],
	);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<span className="italic text-th-text-muted">{label}</span>
			</button>
			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border p-2">
					<HeaderlessMainBlock
						name="raw event"
						fullScreenKey={`raw:${id}`}
						source={source}
						view={view}
						count={{ noun: "line", total: outputLineCount(formatted) }}
					>
						<pre className="text-th-text-muted">{formatted}</pre>
					</HeaderlessMainBlock>
				</div>
			</CollapsibleBody>
		</div>
	);
}

interface CommandOutputItemProps {
	/** The part's, naming its body in full screen. */
	id: string;
	content: string;
}

function CommandOutputItem({ id, content }: CommandOutputItemProps) {
	const [expanded, setExpanded] = useState(true);
	const view = useTranscriptView();
	const source = useMemo<FullScreenSource>(
		() => ({
			title: "Command Output",
			label: "Command Output",
			noun: "command output",
			from: "start",
			copyText: content,
			content: { kind: "markdown", markdown: content },
		}),
		[content],
	);

	return (
		<div className="rounded bg-th-bg-secondary text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center gap-1.5 rounded p-2 text-left hover:bg-th-overlay-hover"
			>
				<ChevronRight
					className={`size-3 shrink-0 text-th-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
				/>
				<span className="text-th-accent">Command Output</span>
			</button>
			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border p-2">
					<HeaderlessMainBlock
						name="command output"
						fullScreenKey={`command-output:${id}`}
						source={source}
						view={view}
					>
						<MarkdownContent content={content} />
					</HeaderlessMainBlock>
				</div>
			</CollapsibleBody>
		</div>
	);
}

interface ContentPartItemProps {
	part: ContentPart;
	sessionId: string;
	onOpenFile?: (path: string) => void;
	isCodex?: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	/**
	 * Opens the answer panel on one question. It is the record card's only
	 * control, and the card holds no state of its own for it — it calls the same
	 * opener the strip does (docs/answering-ui.md §4).
	 */
	onAnswerQuestion?: (requestId: string) => void;
	/** The failed answer, by request id; see `PromptError`. */
	promptError?: PromptError;
	/**
	 * How many subagent Processes this part sits inside; 0 in the bubble
	 * itself. Everything is drawn as it would be at the top, except text: a
	 * subagent's words are a note, not a message.
	 */
	depth?: number;
}

/**
 * The request whose last answer the server refused, and what it said. One at a
 * time: the user answers one card at a time, and the next attempt replaces it.
 */
export interface PromptError {
	requestId: string;
	message: string;
}

function ContentPartItem(props: ContentPartItemProps) {
	const {
		part,
		sessionId,
		onOpenFile,
		isCodex,
		onPermissionRespond,
		onAnswerQuestion,
		promptError,
		depth = 0,
	} = props;
	if (part.type === "text") {
		return (
			<MarkdownContent
				content={part.content}
				variant={depth > 0 ? "note" : "message"}
				onOpenFile={onOpenFile}
				// One part can be screens of prose, so its blocks are where the
				// reader's place is held (see `scrollAnchor`).
				rootProps={anchorBlocksProps}
			/>
		);
	}
	if (part.type === "system") {
		return <SystemItem id={part.id} content={part.content} />;
	}
	if (part.type === "permission_request") {
		return (
			<PermissionRequestItem
				request={part.request}
				status={part.status}
				reason={part.reason}
				isCodex={isCodex}
				onRespond={onPermissionRespond}
				onOpenFile={onOpenFile}
				error={
					promptError?.requestId === part.request.requestId
						? promptError.message
						: undefined
				}
			/>
		);
	}
	if (part.type === "question_record") {
		return (
			<QuestionRecordItem
				record={part.record}
				status={part.status}
				answer={part.answer}
				answerMessageId={part.answerMessageId}
				reason={part.reason}
				legacy={part.legacy}
				onAnswer={onAnswerQuestion}
			/>
		);
	}
	if (part.type === "warning") {
		return <WarningItem message={part.message} code={part.code} />;
	}
	if (part.type === "raw") {
		return <RawItem id={part.id} content={part.content} />;
	}
	if (part.type === "command_output") {
		return <CommandOutputItem id={part.id} content={part.content} />;
	}
	if (part.type === "thinking") {
		return <ThinkingItem thoughts={part.thoughts} />;
	}
	// A subagent call is a tool run like any other; only its body differs, so
	// this is a renderer chosen by category rather than a second model.
	if (isTaskTool(part.tool.name)) {
		return (
			<TaskItem
				run={part.tool}
				depth={depth}
				renderChild={(child) => (
					<ContentPartItem {...props} part={child} depth={depth + 1} />
				)}
			/>
		);
	}
	if (isHtmlRenderCard(part)) {
		return <HtmlRenderCard run={part.tool} />;
	}
	return (
		<ToolCallItem
			run={part.tool}
			sessionId={sessionId}
			onOpenFile={onOpenFile}
		/>
	);
}

interface Props {
	message: Message;
	/** The session this transcript belongs to; see `ToolCallItem`. */
	sessionId: string;
	/**
	 * Opens a work-directory file in the Files viewer. Absent when the host
	 * cannot navigate, which is what withholds the way over to an attachment's
	 * full viewer.
	 */
	onOpenFile?: (path: string) => void;
	/**
	 * First in the whole session, not in the pages loaded so far: it decides
	 * whether a fork anchored here has any conversation behind it to keep.
	 */
	isFirst?: boolean;
	/**
	 * This bubble is the one the open turn is writing into, which is what makes a
	 * tail line on it true. Not the same as `isLast` since a message sent mid-reply
	 * is appended below the reply it went into — that reply is still being written
	 * and has to keep saying so (docs/lifecycle-ui.md §2.3).
	 */
	isOpenTurn?: boolean;
	isCodex?: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	/** Opens the answer panel. Must be stable: this component is memoized. */
	onAnswerQuestion?: (requestId: string) => void;
	promptError?: PromptError;
	onOpenWorkDetail?: (workId: string) => void;
	/**
	 * Absent when forking is out of reach for the whole session — the agent
	 * cannot be forked, or there is no way to open the result. Must be stable:
	 * this component is memoized.
	 */
	onForkMessage?: (messageId: string) => void;
	/**
	 * Opens the sign-in for the CLI an auth failure in this message names.
	 * Absent where there is nothing to sign in from. Must be stable: this
	 * component is memoized.
	 */
	onSignIn?: (agent: AgentType, messageId: string) => void;
	/**
	 * A Stop threw this message away before the agent read it. Derived from the
	 * whole transcript by `MessageList`, since the record saying so sits in a
	 * turn below.
	 */
	isDiscarded?: boolean;
	/**
	 * Puts discarded messages back into the composer. Absent where there is no
	 * composer to put them into. Must be stable: this component is memoized.
	 */
	onRestoreMessages?: (messages: UserMessage[]) => void;
	/**
	 * Drawn for reading outside the transcript — canvas view's turn details
	 * (docs/canvas-ui.md §11.3) — so without the settled reply's Copy and Fork:
	 * chat view, one tap away, has them.
	 */
	withoutActions?: boolean;
}

/**
 * Why fork cannot run on this message, or undefined when it can.
 *
 * A message that is not a conversation turn has no reason at all: it has no
 * menu either, and these codes say why fork cannot run on a message it applies
 * to, not why it does not apply.
 *
 * The permanent reason is asked first: nothing behind the opening message is
 * ever coming back, so naming a missing seq or an unanswered request there
 * would point at a state whose clearing changes nothing.
 */
function forkBlockedReason(
	message: Message,
	isFirst: boolean | undefined,
): ForkBlocked | undefined {
	if (!hasMessageActions(message)) return undefined;
	// A fork anchored on a message the user sent returns to before they sent it,
	// so the session's opening prompt has nothing behind it to keep. The
	// server refuses this one too (chat.ErrForkAnchorNoHistory).
	if (isFirst && message.role === "user") return "nothing-before";
	return forkUnavailableReason(message);
}

/**
 * The body of a message that answered posted questions: the user's bubble, and
 * the named block an agent's answer gets instead of one (AgentAnswerItem).
 * Both hosts draw the same thing, because what was said is the same either way;
 * only who said it differs, and that is the host's to state.
 *
 * Drawn from the `answering` entries rather than from `content`, which is the
 * same facts flattened into `Q:` / `A:` lines for the agent to read — a
 * structure the user already saw as a form and should not have to read back as
 * prose. The header and the question travel with each entry, so this needs
 * nothing from the card that asked; that card may be pages away or not loaded
 * at all (docs/answering-ui.md §3).
 *
 * There is deliberately no link back to it. A link that works only when the
 * target happens to be paged in is worse than none — and an answered card
 * holds the filled-in form anyway, for a reader who scrolls up to it.
 */
function AnsweringBody({ answering }: { answering: QuestionAnswerRecord[] }) {
	return (
		<div className="space-y-2">
			{answering.map((entry) => (
				<div key={entry.request_id} className="min-w-0">
					{/* Outlined rather than filled, and the question is not faded.
					    The reasoning is about the tightest of the two hosts, the
					    user bubble, and a border derived from the text colour is
					    what makes one chip safe on both.
					    `--th-user-bubble` under `--th-user-bubble-text` is a pair
					    `contrast.test.ts` guards, and it is tuned close to the floor:
					    4.83–5.38 in eight of the ten variants. A tint moves the
					    backdrop and `opacity-80` moves the foreground, and either one
					    takes those eight under AA (measured: 3.64–3.97). A border
					    derived from the text colour moves neither — the chip keeps
					    its shape and every word on it keeps the ratio that was
					    checked. */}
					{entry.header && (
						<span className="inline-block max-w-full break-words rounded border border-current/40 px-1.5 py-0.5 text-xs">
							{entry.header}
						</span>
					)}
					{/* Source, not rendered (docs/answering-ui.md §3), but with its
					    line breaks: a question's paragraphs and code fences run
					    together into one line are harder to read than either. */}
					{entry.question && (
						<p className="mt-1 break-words whitespace-pre-wrap text-xs">
							{entry.question}
						</p>
					)}
					<p className="mt-0.5 break-words whitespace-pre-wrap">
						{answerText(entry)}
					</p>
				</div>
			))}
		</div>
	);
}

/**
 * An answer another agent gave, in place of the user bubble it is not.
 *
 * It is drawn on the left of the conversation and named, because the one thing
 * a reader must not conclude is that they answered this themselves — they never
 * saw the question, and the question card two screens up says `Answered` either
 * way. The naming comes off the answers (`resolved_by`), which is the record
 * that knows; the message's origin only says it was not the user.
 *
 * It is not folded into the work-event line like a system message: an answer is
 * conversation, not Pockode annotating itself, and the reader has to be able to
 * read what was said.
 */
function AgentAnswerItem({
	content,
	answering,
	discarded,
}: {
	content: string;
	answering: QuestionAnswerRecord[] | undefined;
	discarded?: boolean;
}) {
	return (
		<div className="rounded border border-th-border bg-th-bg-secondary p-2.5 text-xs text-th-text-secondary sm:p-3">
			<p className="mb-2 flex items-center gap-1.5 text-th-text-muted">
				<Bot className="size-3.5 shrink-0" />
				{answeredByLine(answering)}
			</p>
			{/* The answers, or the prose the agent was sent when there are none
			    to draw. The fallback is not an expected state — the origin is set
			    by the same call that fills `answering` — but the one thing this
			    shape exists to prevent is an answer read as the user's, and
			    falling back to the bubble would do exactly that. */}
			{answering ? (
				<AnsweringBody answering={answering} />
			) : (
				<p className="whitespace-pre-wrap">{content}</p>
			)}
			{discarded && <DiscardedNote className="mt-2 text-th-text-muted" />}
		</div>
	);
}

/**
 * Who this block says answered.
 *
 * One line for the whole block rather than one per entry: a single call answers
 * a single question today, and were that ever to change, every entry in one
 * message still came from the one agent that sent it.
 */
function answeredByLine(answering: QuestionAnswerRecord[] | undefined): string {
	const by = answering?.find(
		(entry) => entry.resolved_by?.kind === "agent",
	)?.resolved_by;
	return by?.title
		? `Answered by the agent working on "${by.title}" — not by you.`
		: "Answered by another agent — not by you.";
}

/**
 * What the user said, both halves of it, and the note beside either.
 *
 * The record keeps option labels and the user's own words apart so the *agent*
 * can tell them apart; the prose it reads marks the second as such
 * (`chat.answerMessage` on the server). Here they are simply joined: this is
 * the user reading their own answer back, and which half a word came from is
 * not a distinction they need drawn for them.
 */
function answerText(entry: QuestionAnswerRecord): string {
	const note = entry.note?.trim();
	if (entry.declined) {
		return note ? `Not answering — ${note}` : "Not answering.";
	}
	const text = entry.text?.trim();
	const answer = [...(entry.answers ?? []), ...(text ? [text] : [])].join(
		" · ",
	);
	return note ? `${answer} — ${note}` : answer;
}

/**
 * A Pockode command the user sent, drawn as the command they typed rather than
 * as the prompt it expanded to: the template is the same every time, and what a
 * reader wants is which command and what was added to it. The prompt is one tap
 * away, as the agent read it — plain text, since Markdown would change how it
 * looks.
 */
function PockodeCommandItem({
	id,
	command,
	content,
	attachments,
	sessionId,
	onOpenFile,
	discarded,
}: {
	/** The message's, naming its block in full screen. */
	id: string;
	command: PockodeCommandInvocation;
	content: string;
	attachments?: FileBlock[];
	sessionId: string;
	onOpenFile?: (path: string) => void;
	discarded?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const fullScreen = useMemo<SectionFullScreen | undefined>(
		() =>
			content
				? {
						key: `sent:${id}`,
						title: `/${command.name} · Sent to the agent`,
						content: { kind: "output", text: content },
					}
				: undefined,
		[id, command.name, content],
	);
	return (
		<div className="row-ground-secondary rounded bg-th-bg-secondary text-xs">
			<ToolRow
				expanded={expanded}
				onToggle={() => setExpanded(!expanded)}
				glyph={
					<SquareSlash className="mt-0.5 size-3 shrink-0 text-th-text-muted" />
				}
				title={`/${command.name}`}
				detail={command.args ?? ""}
			/>
			{attachments && (
				<AttachmentStrip
					files={attachments}
					sessionId={sessionId}
					onOpenFile={onOpenFile}
				/>
			)}
			{discarded && <DiscardedNote className="px-2 pb-2 text-th-text-muted" />}
			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border p-2">
					<Section
						label="Sent to the agent"
						noun="message"
						budget="main"
						fullScreen={fullScreen}
					>
						{/* Empty only on this client's own echo, until the server's
						    reply brings the prompt it expanded the command to — or
						    for good, when the send failed without a reply. */}
						{content ? (
							<p className="whitespace-pre-wrap break-words text-th-text-primary">
								{content}
							</p>
						) : (
							<p className="text-th-text-muted">
								Not received from the server.
							</p>
						)}
					</Section>
				</div>
			</CollapsibleBody>
		</div>
	);
}

const MessageItem = memo(function MessageItem({
	message,
	sessionId,
	onOpenFile,
	isFirst,
	isOpenTurn,
	isCodex,
	onPermissionRespond,
	onAnswerQuestion,
	promptError,
	onOpenWorkDetail,
	onForkMessage,
	onSignIn,
	isDiscarded,
	onRestoreMessages,
	withoutActions = false,
}: Props) {
	const chatUIConfig = useChatUIConfig();
	const UserAvatar = chatUIConfig.UserAvatar;
	const AssistantAvatar = chatUIConfig.AssistantAvatar;
	const userBubbleClass = chatUIConfig.userBubbleClass ?? "";
	const assistantBubbleClass = chatUIConfig.assistantBubbleClass ?? "";

	// Two conditions, one per level. The session decides whether fork is on
	// offer at all — a session nothing can be done to should not pay 44px a row
	// for a glyph that will never come — and the message decides whether it is a
	// turn yet.
	const onFork =
		onForkMessage && hasMessageActions(message)
			? () => onForkMessage(message.id)
			: undefined;
	const forkBlocked = forkBlockedReason(message, isFirst);

	if (message.role === "user") {
		// Restoring needs no navigation, so it brings the slot along even where
		// fork is not on offer (docs/session-fork-ui.md, "Which rows reserve a
		// slot").
		const restore =
			isDiscarded && onRestoreMessages && isRestorable(message)
				? { message, sessionId, onRestore: onRestoreMessages }
				: undefined;
		const slot =
			onForkMessage || restore ? (
				<MessageMenuTrigger
					onFork={onFork}
					forkBlocked={forkBlocked}
					restore={restore}
				/>
			) : null;
		// An agent's answer is neither a bubble nor an event line; see
		// AgentAnswerItem. Full-bleed, but it is conversation the user can fork
		// from, so it keeps the slot and its `…`.
		if (message.source === "agent") {
			const answer = (
				<AgentAnswerItem
					content={message.content}
					answering={message.answering}
					discarded={isDiscarded}
				/>
			);
			return slot ? (
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1">{answer}</div>
					{slot}
				</div>
			) : (
				answer
			);
		}
		// System-driven messages render as a collapsed event line, not a bubble.
		// No slot: it would always be empty (not a turn), and the agent's text
		// beside it runs to the reading column's edge now, so there is no bubble
		// edge left for an empty slot to line up with.
		if (message.source === "system") {
			return (
				<WorkEventItem
					id={message.id}
					content={message.content}
					subtype={message.subtype}
					meta={message.meta}
					onOpenWorkDetail={onOpenWorkDetail}
					discarded={isDiscarded}
				/>
			);
		}
		if (message.command) {
			const item = (
				<PockodeCommandItem
					id={message.id}
					command={message.command}
					content={message.content}
					attachments={message.attachments}
					sessionId={sessionId}
					onOpenFile={onOpenFile}
					discarded={isDiscarded}
				/>
			);
			// Full-bleed like the answer above, and the user's own, so it keeps the
			// slot and its `…`.
			return slot ? (
				<div className="flex items-start gap-2">
					<div className="min-w-0 flex-1">{item}</div>
					{slot}
				</div>
			) : (
				item
			);
		}
		if (message.canvasAction) {
			return (
				<div className="flex items-end justify-end gap-2">
					{slot}
					<CanvasActionBubble
						id={message.id}
						canvasAction={message.canvasAction}
						discarded={isDiscarded}
						className={userBubbleClass}
					/>
					{UserAvatar && <UserAvatar className="size-10 shrink-0" />}
				</div>
			);
		}
		return (
			<div className="flex items-end justify-end gap-2">
				{slot}
				<div
					className={`chat-bubble max-w-full min-w-0 overflow-hidden rounded-lg bg-th-user-bubble p-2.5 text-th-user-bubble-text sm:p-3 ${userBubbleClass}`}
				>
					{message.answering ? (
						<AnsweringBody answering={message.answering} />
					) : (
						message.content && (
							<p className="whitespace-pre-wrap">{message.content}</p>
						)
					)}
					{/* The files are part of what was sent, so they are inside the
					    bubble; a message can be nothing else. Spacing alone sets them
					    off from the text: a rule the bubble's width under a paragraph
					    reads as that paragraph's underline. */}
					{message.attachments && (
						<AttachmentStrip
							files={message.attachments}
							sessionId={sessionId}
							onOpenFile={onOpenFile}
							divided={false}
						/>
					)}
					{/* Inside the bubble and in its own colour: the ending belongs to
					    this message, the user is about to read it to decide whether
					    to send it again, and the row's alignment stays as it was. */}
					{isDiscarded && <DiscardedNote className="mt-2" />}
				</div>
				{UserAvatar && <UserAvatar className="size-10 shrink-0" />}
			</div>
		);
	}

	// One notice per turn, where the failure stands now: on the turn's error once
	// it has failed, and until then on the latest refused retry of the turn still
	// running. The turn's other auth warnings say the same thing again, so a
	// failed turn draws none of them; a turn that recovered draws them as the
	// warnings they were.
	const authError =
		message.status === "error" ? message.authFailure : undefined;
	const liveAuthIndex =
		!authError && isOpenTurn
			? message.parts.findLastIndex(
					(part) => part.type === "warning" && part.authFailure,
				)
			: -1;
	const shownParts = message.parts
		.map((part, index) => ({ part, index }))
		.filter(
			({ part }) => !(authError && part.type === "warning" && part.authFailure),
		);
	const signIn = (agent: AgentType) =>
		onSignIn ? () => onSignIn(agent, message.id) : undefined;
	// What the agent wrote, as it wrote it: top-level text only. Tool calls,
	// cards and a subagent's notes are the transcript's, not this message's prose.
	const copyText = message.parts
		.flatMap((part) => (part.type === "text" ? [part.content] : []))
		.join("\n\n");
	const pending =
		message.status === "sending" || message.status === "streaming";

	// Assistant message: no bubble, the full reading width. Not `overflow-hidden`
	// like the bubble was: the action row reaches left of the column so its first
	// icon lines up with the text, and clipping would cut its box and focus ring.
	return (
		<div className="flex items-start justify-start gap-2">
			{AssistantAvatar && <AssistantAvatar className="size-10 shrink-0" />}
			<div
				className={`min-w-0 flex-1 text-th-text-primary ${assistantBubbleClass}`}
			>
				{shownParts.length > 0 && (
					<div className="space-y-2">
						{/* Every part has a wrapper of its own, so this part can be what
						    the view is held still over: one turn is one row and can be
						    several screens tall, so holding the row still says nothing
						    about where inside it the reader is (see `scrollAnchor`).

						    A part on its own takes a `space-y-2` slot whether or not
						    anything is drawn in it, so a part renderer must render
						    something — every branch of `ContentPartItem` does today, and
						    one returning null would show as a gap with nothing in it. */}
						<PartBlocks
							items={shownParts}
							wrapperProps={anchorCandidateProps}
							renderPart={({ part, index }) =>
								index === liveAuthIndex &&
								part.type === "warning" &&
								part.authFailure ? (
									<AuthFailureNotice
										message={part.message}
										agent={part.authFailure}
										onSignIn={signIn(part.authFailure)}
									/>
								) : (
									<ContentPartItem
										part={part}
										sessionId={sessionId}
										onOpenFile={onOpenFile}
										isCodex={isCodex}
										onPermissionRespond={onPermissionRespond}
										onAnswerQuestion={onAnswerQuestion}
										promptError={promptError}
									/>
								)
							}
						/>
					</div>
				)}

				{message.status === "error" &&
					(authError ? (
						<div className="mt-2">
							<AuthFailureNotice
								message={message.error ?? ""}
								agent={authError}
								onSignIn={signIn(authError)}
							/>
						</div>
					) : (
						<p className="mt-2 text-sm text-th-error">{message.error}</p>
					))}
				{message.status === "interrupted" && (
					<p className="mt-2 text-sm text-th-text-muted">Interrupted</p>
				)}
				{message.discardedMessageIds && (
					<DiscardedSummary
						ids={message.discardedMessageIds}
						sessionId={sessionId}
						onRestore={onRestoreMessages}
					/>
				)}
				{message.status === "process_ended" && (
					<p className="mt-2 text-sm text-th-warning">Process ended</p>
				)}
				{/* Last before the actions however the turn ended, so it is always
				    in one place; shown when they are, so the two replace the tail line
				    together. */}
				{!pending && (
					<TurnChangesCard parts={message.parts} onOpenFile={onOpenFile} />
				)}
				{pending ? (
					<TurnTail
						// Keyed on being the open turn rather than on being last. The two
						// agreed until a message could be sent mid-reply; now the reply
						// that is still growing routinely has that message under it, and
						// reading position would take its line away at the one moment the
						// user has just asked it something. A message left `streaming`
						// that is *not* the open turn keeps the slot empty, which is what
						// stopped a superseded reply from claiming to still be running.
						writing={message.status === "sending" || !!isOpenTurn}
						placeholder={message.status === "sending"}
					/>
				) : (
					!withoutActions && (
						<MessageActions
							copyText={copyText || undefined}
							onFork={onFork}
							forkBlocked={forkBlocked}
						/>
					)
				)}
			</div>
		</div>
	);
});

export default MessageItem;
