import { ChevronRight, Hourglass, Lock } from "lucide-react";
import { useState } from "react";
import {
	type ActivityItem,
	BACKGROUND_WORDS,
	PERMISSION_ANSWER_WORDS,
	PHASE_ANNOUNCEMENT,
	replyPrompt,
	type StripLine,
	type StripPhase,
	stripLine,
	stripLineText,
	stripPhase,
	stripReplyIndex,
} from "../../lib/activityStrip";
import { openAssistantIndex } from "../../lib/messageReducer";
import type { TurnTail } from "../../lib/thinking";
import { toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type {
	Message,
	PermissionRequest,
	SessionTurn,
} from "../../types/message";
import type { PromptError } from "../Chat/MessageItem";
import type { PermissionChoice } from "../Chat/PermissionRequestItem";
import { LatestChildLabel } from "../Chat/TaskItem";
import { Detail } from "../Chat/ToolRow";
import { LIVE_GLYPH, TurnClock } from "../Chat/TurnTail";
import TurnDetailsSheet from "./TurnDetailsSheet";

interface Props {
	sessionId: string;
	turn: SessionTurn;
	/** Both the session detail and the transcript have arrived. */
	loaded: boolean;
	messages: Message[];
	tail: TurnTail;
	openedThoughtIds: ReadonlySet<string>;
	isCodex: boolean;
	onPermissionRespond?: (
		request: PermissionRequest,
		choice: PermissionChoice,
	) => void;
	promptError?: PromptError;
	onOpenFile?: (path: string) => void;
	/** Switches to chat view with this reply's start at the top. */
	onOpenInChat: (messageId: string) => void;
}

const LINE = "mx-auto flex w-full max-w-3xl items-center gap-1.5 px-3 text-xs";

function Glyph({ phase }: { phase: StripPhase }) {
	switch (phase) {
		case "running":
		case "optimistic":
			return <span className="flex text-th-accent">{LIVE_GLYPH}</span>;
		// Muted, not warning: the banner is the one warning surface, and a
		// second would be two things to look at for one request.
		case "permission":
			return <Lock className="size-3 text-th-text-muted" />;
		case "background":
			return <Hourglass className="size-3 text-th-text-secondary" />;
		default:
			return null;
	}
}

function ItemLine({ item }: { item: ActivityItem }) {
	const workDir = useWSStore((state) => state.workDir);
	switch (item.kind) {
		case "text":
			return (
				<span className="truncate text-th-text-secondary">{item.text}</span>
			);
		case "thinking":
			return (
				<>
					<span className="shrink-0 text-th-text-secondary">Thinking…</span>
					{item.latest && (
						<>
							<span className="shrink-0 text-th-text-muted">·</span>
							<span className="truncate text-th-text-muted">{item.latest}</span>
						</>
					)}
				</>
			);
		case "thought":
			return (
				<span className="truncate text-th-text-secondary">{item.label}</span>
			);
		case "working":
			return <span className="truncate text-th-text-secondary">Working</span>;
		case "call": {
			const summary = toolSummary(item.name, item.input, workDir, item.outcome);
			return (
				<>
					<span className="shrink-0 text-th-text-secondary">
						{summary.chip ? `${summary.title} ${summary.chip}` : summary.title}
					</span>
					{item.child ? (
						<>
							<span className="shrink-0 text-th-text-muted">·</span>
							{/* Muted as the detail it stands in for; its text takes
							    its colour from around it. */}
							<span className="flex min-w-0 items-baseline gap-1.5 text-th-text-muted">
								<LatestChildLabel child={item.child} />
							</span>
						</>
					) : (
						<Detail
							detail={summary.detail}
							detailTail={summary.detailTail}
							mono={summary.mono}
						/>
					)}
					{item.answer && (
						<span className="shrink-0 text-th-text-secondary">
							· {PERMISSION_ANSWER_WORDS[item.answer]}
						</span>
					)}
				</>
			);
		}
	}
}

function LineContent({ line }: { line: StripLine }) {
	switch (line.kind) {
		case "background":
			return (
				<span className="truncate text-th-text-secondary">
					{BACKGROUND_WORDS}
				</span>
			);
		case "error":
			return <span className="truncate text-th-error">{line.message}</span>;
		case "item":
			return (
				<>
					{line.prefix && (
						<span className="shrink-0 text-th-text-secondary">
							{line.prefix} ·
						</span>
					)}
					<ItemLine item={line.item} />
				</>
			);
	}
}

/**
 * The status region's words, said when the phase changes — not on every line,
 * which changes several times a second, and not when the strip first learns
 * where the turn already was.
 */
function usePhaseAnnouncement(phase: StripPhase): string {
	const [baseline, setBaseline] = useState<StripPhase | null>(null);
	const [changed, setChanged] = useState(false);
	if (phase !== "unknown" && baseline === null) setBaseline(phase);
	if (
		!changed &&
		baseline !== null &&
		PHASE_ANNOUNCEMENT[phase] !== PHASE_ANNOUNCEMENT[baseline]
	) {
		setChanged(true);
	}
	return changed ? PHASE_ANNOUNCEMENT[phase] : "";
}

/**
 * One line between the canvas and the input saying what the agent is doing
 * (docs/canvas-ui.md §11): the latest item of the reply being written, how it
 * stands by the turn, and the turn's clock. A press opens the reply in full.
 *
 * Drawn from the first frame — before anything is known, as an empty box of
 * the same height — so the canvas has its final height before the first send
 * measures it (§5).
 */
function ActivityStrip({
	sessionId,
	turn,
	loaded,
	messages,
	tail,
	openedThoughtIds,
	isCodex,
	onPermissionRespond,
	promptError,
	onOpenFile,
	onOpenInChat,
}: Props) {
	const [detailsOpen, setDetailsOpen] = useState(false);
	const replyIndex = stripReplyIndex(messages, turn);
	const replyMessage = replyIndex >= 0 ? messages[replyIndex] : undefined;
	const reply = replyMessage?.role === "assistant" ? replyMessage : undefined;
	const phase = stripPhase(turn, reply, loaded);
	const announcement = usePhaseAnnouncement(phase);
	const workDir = useWSStore((state) => state.workDir);
	const line = stripLine(phase, reply, tail.thinking);
	const canOpen = reply !== undefined && phase !== "unknown";

	// An open sheet stays on the reply it was showing while none is open — a
	// turn started elsewhere is reported before its first record — and moves
	// on to the new one when it opens.
	const [shownReplyId, setShownReplyId] = useState<string>();
	if (reply && reply.id !== shownReplyId) setShownReplyId(reply.id);
	const sheetIndex = reply
		? replyIndex
		: messages.findIndex((m) => m.id === shownReplyId);
	const sheetMessage = sheetIndex >= 0 ? messages[sheetIndex] : undefined;
	const sheetReply =
		sheetMessage?.role === "assistant" ? sheetMessage : undefined;
	// What it shows can go — the session detail cleared — and the sheet with
	// it, for good: coming back is not the user asking again.
	const sheetUp =
		detailsOpen && sheetReply !== undefined && phase !== "unknown";
	if (detailsOpen && !sheetUp) setDetailsOpen(false);

	const status = (
		// biome-ignore lint/a11y/useSemanticElements: a live announcement, not a form output
		<span role="status" className="sr-only">
			{announcement}
		</span>
	);

	if (phase === "unknown" || phase === "not_started") {
		return (
			// The same box as the button, so the first turn moves nothing. Its
			// classes are written out in both places rather than shared: the
			// hit-area scan reads a control's height where its tag states it.
			<div className="flex min-h-9 border-t border-th-border pointer-coarse:min-h-11">
				{status}
				<div className={LINE}>
					<span aria-hidden className="size-3 shrink-0" />
					{phase === "not_started" && (
						<span className="text-th-text-muted">Not started</span>
					)}
				</div>
			</div>
		);
	}

	const clock =
		phase === "running" && tail.openedAt !== undefined ? (
			<span aria-hidden className="shrink-0">
				<TurnClock openedAt={tail.openedAt} />
			</span>
		) : null;

	return (
		<div>
			{status}
			<button
				type="button"
				onClick={() => setDetailsOpen(true)}
				aria-label={`Turn details: ${stripLineText(line, workDir)}`}
				// Only before the reply's first record, for a moment: nothing to
				// open yet.
				disabled={!canOpen}
				// The tail line's height, written down so it meets the hit-area
				// floors without `touch-target` (docs/canvas-ui.md §11.2).
				className="flex min-h-9 w-full border-t border-th-border text-left transition-colors hover:bg-th-bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-border-focus focus-visible:ring-inset pointer-coarse:min-h-11"
			>
				<span className={LINE}>
					<span
						aria-hidden
						className="flex size-3 shrink-0 items-center justify-center"
					>
						<Glyph phase={phase} />
					</span>
					<span
						className={`flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden ${
							// Settled, all of it muted — the detail's own two rungs
							// too — but an error keeps its colour.
							phase === "idle" && line.kind !== "error"
								? "[&_*]:text-th-text-muted!"
								: ""
						}`}
					>
						<LineContent line={line} />
					</span>
					{clock}
					<ChevronRight
						aria-hidden
						className="size-3 shrink-0 text-th-text-muted"
					/>
				</span>
			</button>
			{sheetUp && sheetReply && (
				<TurnDetailsSheet
					sessionId={sessionId}
					messages={messages}
					reply={sheetReply}
					prompt={replyPrompt(messages, sheetIndex)}
					turnOpen={turn.open || phase === "optimistic"}
					running={phase === "running"}
					isOpenTurn={sheetIndex === openAssistantIndex(messages)}
					tail={tail}
					openedThoughtIds={openedThoughtIds}
					isCodex={isCodex}
					onPermissionRespond={onPermissionRespond}
					promptError={promptError}
					onOpenFile={onOpenFile}
					onClose={() => setDetailsOpen(false)}
					onOpenInChat={() => {
						setDetailsOpen(false);
						onOpenInChat(sheetReply.id);
					}}
				/>
			)}
		</div>
	);
}

export default ActivityStrip;
