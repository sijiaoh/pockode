import {
	AlertTriangle,
	Bot,
	Check,
	ChevronRight,
	CircleHelp,
	ExternalLink,
	ListTodo,
	SquareSlash,
	X,
} from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import { useChatUIConfig } from "../../lib/registries/chatUIRegistry";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { isTaskTool, toolSummary } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type { FileBlock } from "../../types/content";
import type {
	ContentPart,
	ExpiryReason,
	Message,
	PermissionRequest,
	PermissionRuleValue,
	PermissionStatus,
	PermissionUpdate,
	PermissionUpdateDestination,
	PockodeCommandInvocation,
	QuestionAnswerRecord,
	SystemMessageMeta,
} from "../../types/message";
import type { AgentType } from "../../types/settings";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { forkUnavailableReason } from "../../utils/forkAnchor";
import { hasMessageActions } from "../../utils/messageActions";
import { formatFilePath } from "../../utils/path";
import { workEventSubject, workEventWording } from "../../utils/systemMessage";
import {
	CollapsibleBody,
	MarkdownContent,
	ScrollableContent,
	useEverExpanded,
} from "../ui";
import AttachmentStrip from "./AttachmentStrip";
import AuthFailureNotice from "./AuthFailureNotice";
import MessageActions from "./MessageActions";
import MessageMenuTrigger, { type ForkBlocked } from "./MessageMenuTrigger";
import {
	ProposedChange,
	proposedChange,
	proposedChangeHeader,
	proposedChangeText,
} from "./ProposedChange";
import QuestionRecordItem from "./QuestionRecordItem";
import { useRowExpanded } from "./rowExpansionContext";
import { anchorCandidateProps } from "./scrollAnchor";
import TaskItem from "./TaskItem";
import ToolCallItem from "./ToolCallItem";
import { invocationView, ToolInvocation } from "./ToolInvocation";
import { PartBlocks } from "./ToolList";
import { ToolRow } from "./ToolRow";
import { Section } from "./ToolSection";

interface SystemItemProps {
	content: string;
}

interface SystemContent {
	subtype: string;
	status?: string;
}

function SystemItem({ content }: SystemItemProps) {
	const [expanded, setExpanded] = useState(false);
	const label = useMemo(() => {
		const parsed: SystemContent = JSON.parse(content);
		return parsed.status
			? `${parsed.subtype}: ${parsed.status}`
			: parsed.subtype;
	}, [content]);

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
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					<pre className="text-th-text-muted">{content}</pre>
				</ScrollableContent>
			</CollapsibleBody>
		</div>
	);
}

interface WorkEventItemProps {
	content: string;
	subtype?: string;
	meta?: SystemMessageMeta;
	onOpenWorkDetail?: (workId: string) => void;
}

/**
 * One thing that happened to a Pockode work, at the point in the stream where
 * it happened. It says only that — no status, no history, no live data: the
 * event is over, and what the work is doing now lives behind Details.
 */
function WorkEventItem({
	content,
	subtype,
	meta,
	onOpenWorkDetail,
}: WorkEventItemProps) {
	const [expanded, setExpanded] = useState(false);
	const { label, summary } = workEventWording(subtype, meta);
	// The subject's own title, even where the collapsed line names something
	// else (a finished child): expanded, it sits next to the link into that work.
	const { workId, title } = workEventSubject(subtype, meta);

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
			</button>
			<CollapsibleBody expanded={expanded}>
				<ScrollableContent className="max-h-[60vh] space-y-2 overflow-auto border-t border-th-border p-2">
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
					<MarkdownContent content={content} />
				</ScrollableContent>
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
	content: string;
}

function RawItem({ content }: RawItemProps) {
	const [expanded, setExpanded] = useState(false);
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
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					<pre className="text-th-text-muted">{formatted}</pre>
				</ScrollableContent>
			</CollapsibleBody>
		</div>
	);
}

interface CommandOutputItemProps {
	content: string;
}

function CommandOutputItem({ content }: CommandOutputItemProps) {
	const [expanded, setExpanded] = useState(true);

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
				<ScrollableContent className="max-h-[60vh] overflow-auto border-t border-th-border p-2">
					<MarkdownContent content={content} />
				</ScrollableContent>
			</CollapsibleBody>
		</div>
	);
}

type PermissionChoice = "deny" | "allow" | "always_allow";

interface PermissionRequestItemProps {
	request: PermissionRequest;
	status: PermissionStatus;
	/** Why it expired, when the server could say; see ExpiryReason. */
	reason?: ExpiryReason;
	isCodex?: boolean;
	onRespond?: (request: PermissionRequest, choice: PermissionChoice) => void;
	onOpenFile?: (path: string) => void;
	/** Why the last attempt to answer failed. */
	error?: string;
}

/**
 * The input the user is being asked to approve, pretty-printed.
 *
 * `command_actions` is left out: it is Codex's own parse of the command, it is
 * already what the row above says, and dumping the array into an approval
 * prompt asks the reader to parse the same command a second time.
 */
function formatInput(input: unknown): string {
	if (typeof input === "string") return input;
	try {
		if (input && typeof input === "object" && !Array.isArray(input)) {
			const { command_actions: _actions, ...rest } = input as Record<
				string,
				unknown
			>;
			return JSON.stringify(rest, null, 2);
		}
		return JSON.stringify(input, null, 2);
	} catch {
		return String(input);
	}
}

/** Check if input is empty (null, undefined, empty string, or empty object) */
function isEmptyInput(input: unknown): boolean {
	if (input == null) return true;
	if (input === "") return true;
	if (typeof input === "object" && Object.keys(input as object).length === 0)
		return true;
	return false;
}

/** Format permission rule for display */
function formatPermissionRule(rule: PermissionRuleValue): string {
	if (rule.ruleContent) {
		return `${rule.toolName}(${rule.ruleContent})`;
	}
	return rule.toolName;
}

/** Get human-readable destination label */
function getDestinationLabel(destination: PermissionUpdateDestination): string {
	switch (destination) {
		case "session":
			return "this session";
		case "projectSettings":
			return "this project";
		case "localSettings":
			return "local settings";
		case "userSettings":
			return "all projects";
	}
}

type PermissionMode = Extract<PermissionUpdate, { type: "setMode" }>["mode"];

/** Claude's permission modes, as the one line that names them reads them. */
function getModeLabel(mode: PermissionMode): string {
	switch (mode) {
		case "default":
			return "Default";
		case "acceptEdits":
			return "Accept edits";
		case "bypassPermissions":
			return "Bypass permissions";
		case "plan":
			return "Plan";
	}
}

/**
 * The input as it arrived, folded away under the reading of it above.
 *
 * Kept because the reading is a reading: a key no branch draws is still part
 * of what is being approved. A folded `Section` mounts nothing until the first
 * open, so the serialization below is paid for only by someone who asked — or
 * who copies it, which is why the header copies through a function.
 */
function RawInput({ input }: { input: unknown }) {
	return (
		<Section
			label="Raw input"
			copyText={() => formatInput(input)}
			collapsible={{ defaultOpen: false }}
		>
			<RawInputBody input={input} />
		</Section>
	);
}

function RawInputBody({ input }: { input: unknown }) {
	const json = useMemo(() => formatInput(input), [input]);
	return (
		<CodeHighlighter
			language="json"
			wrap
			copyable={false}
			plain={json.length > HIGHLIGHT_LIMIT}
		>
			{json}
		</CodeHighlighter>
	);
}

function RuleChips({ items }: { items: string[] }) {
	return (
		<span className="inline-flex flex-wrap gap-1 align-middle">
			{items.map((item, idx) => (
				<code
					// biome-ignore lint/suspicious/noArrayIndexKey: a request's suggestions never change
					key={idx}
					className="rounded bg-th-bg-tertiary px-1 py-0.5 font-mono text-th-text-primary"
				>
					{item}
				</code>
			))}
		</span>
	);
}

/**
 * One sentence of what pressing Always Allow writes.
 *
 * Every suggestion, not the first: the server answers with the whole list
 * (`UpdatedPermissions = PermissionSuggestions`), so a card naming fewer would
 * be agreeing to more than it says.
 */
function SuggestionLine({ update }: { update: PermissionUpdate }) {
	const dest = getDestinationLabel(update.destination);
	const workDir = useWSStore((state) => state.workDir);

	switch (update.type) {
		case "addRules":
			return (
				<>
					adds to {dest}:{" "}
					<RuleChips items={update.rules.map(formatPermissionRule)} />
				</>
			);
		case "replaceRules":
			return (
				<>
					replaces the rules in {dest} with:{" "}
					<RuleChips items={update.rules.map(formatPermissionRule)} />
				</>
			);
		case "removeRules":
			return (
				<>
					removes from {dest}:{" "}
					<RuleChips items={update.rules.map(formatPermissionRule)} />
				</>
			);
		case "setMode":
			// The mode is the weight of the sentence — bypassing permissions is the
			// heaviest thing any suggestion can do — so it is not left muted.
			return (
				<>
					switches {dest} to{" "}
					<span className="font-medium text-th-text-primary">
						{getModeLabel(update.mode)}
					</span>{" "}
					mode.
				</>
			);
		case "addDirectories":
			return (
				<>
					lets {dest} access:{" "}
					<RuleChips
						items={update.directories.map((dir) =>
							formatFilePath(dir, workDir),
						)}
					/>
				</>
			);
		case "removeDirectories":
			return (
				<>
					removes access to:{" "}
					<RuleChips
						items={update.directories.map((dir) =>
							formatFilePath(dir, workDir),
						)}
					/>
				</>
			);
	}
}

/**
 * What Always Allow does, said directly above the button that does it.
 *
 * Outside the scrolling body on purpose: a long command used to scroll this
 * explanation out of sight while the button stayed in view.
 */
function AlwaysAllowEffect({
	id,
	suggestions,
	isCodex,
}: {
	/** Described-by target of the Always Allow button. */
	id: string;
	suggestions: PermissionUpdate[];
	isCodex?: boolean;
}) {
	const label = (
		<span className="font-medium text-th-text-primary">Always Allow</span>
	);

	// Codex has no rules to show: its "always" is `acceptForSession`.
	if (suggestions.length === 0) {
		if (!isCodex) return null;
		return (
			<p id={id} className="px-2 pt-2 text-th-text-muted">
				{label} stops Codex asking about requests like this until the session
				ends.
			</p>
		);
	}

	return (
		<div id={id} className="space-y-1 px-2 pt-2 text-th-text-muted">
			{suggestions.map((update, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a request's suggestions never change
				<p key={idx}>
					{label} <SuggestionLine update={update} />
				</p>
			))}
		</div>
	);
}

// A decision, not a caption: the one place in this `text-xs` card that steps
// up to `text-sm`. The card is a container that can grow, so the box itself
// grows to the floor rather than borrowing a `touch-target` overlay.
const PERMISSION_BUTTON =
	"min-h-9 rounded-md text-sm font-medium pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";
const PERMISSION_SECONDARY = `${PERMISSION_BUTTON} flex-1 border border-th-border bg-th-bg-primary text-th-text-primary hover:bg-th-overlay-hover`;

// What an expired permission request says, per reason. Every one of them states
// the same outcome — the tool did not run — because a permission that is not
// granted is a denial whichever way the waiting ended; what differs is why
// nobody was asked again (docs/lifecycle-ui.md §5.2).
//
// `Partial`, not `Record`: `ExpiryReason` spans both card kinds and `step_done`
// reaches only a question card, so the absent key *is* the statement that it
// cannot arrive here. A row invented to satisfy the type would be a sentence for
// a case that never happens, and the fallback below already covers a reason this
// build does not recognise.
const PERMISSION_EXPIRY_COPY: Partial<Record<ExpiryReason, string>> = {
	process_ended:
		"The agent's process ended before this was answered, so it counted as a denial and the tool did not run.",
	timeout:
		"This request was not answered in time, so it counted as a denial and the tool did not run.",
	work_closed:
		"This request was cancelled because the work was closed. The tool did not run.",
};

// Said when the reason is unknown or is not one this card can carry, and true of
// all of them.
const PERMISSION_EXPIRY_FALLBACK =
	"The agent stopped waiting for this request, so it counted as a denial and the tool did not run.";

function PermissionRequestItem({
	request,
	status,
	reason,
	isCodex,
	onRespond,
	onOpenFile,
	error,
}: PermissionRequestItemProps) {
	const isPending = status === "pending";
	const workDir = useWSStore((state) => state.workDir);
	// The same derivation the tool row uses: a user who approved a command and
	// then reads the row that ran it is looking at one string, cut one way.
	const summary = toolSummary(request.toolName, request.toolInput, workDir);
	const hasToolInput = !isEmptyInput(request.toolInput);
	const suggestions = request.permissionSuggestions ?? [];
	const offersAlwaysAllow = isCodex || suggestions.length > 0;
	const alwaysAllowEffectId = useId();
	// The expired banner lives in the body, so a request with nothing else to
	// show still has to be openable — otherwise the one thing the card has left
	// to say is unreachable.
	const hasExpandableContent = hasToolInput || status === "expired";
	const [expanded, setExpanded] = useRowExpanded(
		isPending && hasExpandableContent,
	);

	const statusConfig = {
		pending: { Icon: CircleHelp, color: "text-th-warning" },
		allowed: { Icon: Check, color: "text-th-success" },
		denied: { Icon: X, color: "text-th-error" },
		expired: { Icon: X, color: "text-th-text-muted" },
	};

	const { Icon, color } = statusConfig[status];

	return (
		// The data attribute is how MessageList finds this card when the attention
		// strip jumps to it — the one card that is a jump target. `scroll-mt-14` is
		// clearance above where `scrollIntoView({block: "start"})` lands: a card
		// flush against the top edge reads as cut off rather than arrived at. It
		// used to be there to clear the pending-question pill, which floated there
		// and is gone.
		<div
			data-permission-request-id={request.requestId}
			//
			// A pending card is the one row in a list that is still a card: tinted,
			// and framed by an outline drawn inside its own edge. An outline rather
			// than a border, so the frame does not shift the row against its
			// neighbours; and rather than an inset ring, because an outline is
			// painted over the children, so the row's hover cannot cover it.
			className={`scroll-mt-14 text-xs ${isPending ? "bg-th-warning/10 outline-1 -outline-offset-1 outline-th-warning" : ""}`}
		>
			<ToolRow
				expanded={expanded}
				toggleable={hasExpandableContent}
				onToggle={() => hasExpandableContent && setExpanded(!expanded)}
				glyph={
					<Icon
						className={`mt-0.5 size-3 shrink-0 ${color}`}
						aria-label={status}
					/>
				}
				title={summary.title}
				chip={summary.chip}
				detail={summary.detail}
				detailTail={summary.detailTail}
				detailMono={summary.mono}
			/>

			<CollapsibleBody expanded={expanded}>
				{/* A settled card's body is an opened drawer like a tool row's; a
				    pending one keeps the card's tint, being what the card asks
				    about. */}
				<div
					className={`space-y-3 border-t border-th-border p-2 ${isPending ? "" : "bg-th-bg-secondary"}`}
				>
					{/* An expired permission can only have been a denial, and the card
					    states that outcome rather than offering anything to press: the
					    two expired cards are told apart by their affordances, not their
					    chrome (docs/lifecycle-ui.md §5.2). */}
					{status === "expired" && (
						<div className="rounded bg-th-bg-tertiary px-2 py-1.5 text-th-text-muted">
							{(reason && PERMISSION_EXPIRY_COPY[reason]) ??
								PERMISSION_EXPIRY_FALLBACK}
						</div>
					)}
					{hasToolInput && (
						<PermissionRequestBody request={request} onOpenFile={onOpenFile} />
					)}
				</div>
			</CollapsibleBody>

			{/* Outside the button row on purpose. A refusal often takes the buttons
			    away with it — the card is no longer pending — and an error that
			    disappears with the control it belongs to is a silent failure. */}
			{error && (
				<p
					role="alert"
					className="border-th-border border-t px-2 py-1.5 text-th-error"
				>
					{error}
				</p>
			)}

			{isPending && onRespond && (
				<div className="border-t border-th-border">
					{offersAlwaysAllow && (
						<AlwaysAllowEffect
							id={alwaysAllowEffectId}
							suggestions={suggestions}
							isCodex={isCodex}
						/>
					)}
					{/* Allow keeps the right-hand end whether or not Always Allow is
					    offered: the thumb's side, and the side Send sits on below. No
					    Enter or Escape shortcut — Escape already interrupts the turn
					    (docs/answering-ui.md#who-owns-escape), and a stray key on a
					    prompt that runs arbitrary commands costs too much. */}
					<div className="flex gap-2 p-2">
						<button
							type="button"
							onClick={() => onRespond(request, "deny")}
							className={PERMISSION_SECONDARY}
						>
							Deny
						</button>
						{offersAlwaysAllow && (
							<button
								type="button"
								onClick={() => onRespond(request, "always_allow")}
								// The sentence above is the button's consequence; a screen
								// reader landing on the button should hear it too.
								aria-describedby={alwaysAllowEffectId}
								className={PERMISSION_SECONDARY}
							>
								Always Allow
							</button>
						)}
						<button
							type="button"
							onClick={() => onRespond(request, "allow")}
							className={`${PERMISSION_BUTTON} flex-[1.4] bg-th-accent text-th-accent-text hover:opacity-90`}
						>
							Allow
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * The same reading of the input the tool row gives once the call has run, so
 * what was approved and what ran are one text: the invocation, then — for a
 * file tool — the change it will make, then the input as it arrived.
 */
function PermissionRequestBody({
	request,
	onOpenFile,
}: {
	request: PermissionRequest;
	onOpenFile?: (path: string) => void;
}) {
	const view = useMemo(
		() => invocationView(request.toolName, request.toolInput),
		[request.toolName, request.toolInput],
	);
	const change = proposedChange(request.toolName, request.toolInput);
	// Counting reads the whole diff; `change` is the same object every render.
	const changeHeader = useMemo(() => proposedChangeHeader(change), [change]);
	// Where the body already is the input — the JSON fallback or its fields, a
	// string input, a plan that is the input's only key — the raw input would
	// say it twice. A plan with anything beside it keeps it: whatever else the
	// plan asks for is being approved with it.
	const showRaw =
		view.kind !== "json" &&
		view.kind !== "params" &&
		typeof request.toolInput !== "string" &&
		!(
			view.kind === "plan" &&
			Object.keys(request.toolInput as object).length === 1
		);

	return (
		<>
			<ToolInvocation
				toolName={request.toolName}
				input={request.toolInput}
				onOpenFile={onOpenFile}
			/>
			{change && (
				<Section
					label="Proposed change"
					{...changeHeader}
					copyText={proposedChangeText(change)}
					fullScreenTitle="Proposed change"
				>
					<ProposedChange change={change} />
				</Section>
			)}
			{showRaw && <RawInput input={request.toolInput} />}
		</>
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
			/>
		);
	}
	if (part.type === "system") {
		return <SystemItem content={part.content} />;
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
		return <RawItem content={part.content} />;
	}
	if (part.type === "command_output") {
		return <CommandOutputItem content={part.content} />;
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
	 * spinner on it true. Not the same as `isLast` since a message sent mid-reply
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
}: {
	content: string;
	answering: QuestionAnswerRecord[] | undefined;
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
	command,
	content,
	attachments,
	sessionId,
	onOpenFile,
}: {
	command: PockodeCommandInvocation;
	content: string;
	attachments?: FileBlock[];
	sessionId: string;
	onOpenFile?: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<div className="rounded bg-th-bg-secondary text-xs">
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
			<CollapsibleBody expanded={expanded}>
				<div className="border-t border-th-border p-2">
					<Section label="Sent to the agent">
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
		const slot = onForkMessage ? (
			<MessageMenuTrigger onFork={onFork} forkBlocked={forkBlocked} />
		) : null;
		// An agent's answer is neither a bubble nor an event line; see
		// AgentAnswerItem. Full-bleed, but it is conversation the user can fork
		// from, so it keeps the slot and its `…`.
		if (message.source === "agent") {
			const answer = (
				<AgentAnswerItem
					content={message.content}
					answering={message.answering}
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
					content={message.content}
					subtype={message.subtype}
					meta={message.meta}
					onOpenWorkDetail={onOpenWorkDetail}
				/>
			);
		}
		if (message.command) {
			const item = (
				<PockodeCommandItem
					command={message.command}
					content={message.content}
					attachments={message.attachments}
					sessionId={sessionId}
					onOpenFile={onOpenFile}
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
					    bubble; a message can be nothing else. */}
					{message.attachments && (
						<AttachmentStrip
							files={message.attachments}
							sessionId={sessionId}
							onOpenFile={onOpenFile}
							divided={message.content !== ""}
						/>
					)}
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
						{/* Every part has a wrapper of its own, and an unpositioned one,
						    so this part can be what the view is held still over: one turn
						    is one row and can be several screens tall, so holding the row
						    still says nothing about where inside it the reader is (see
						    `scrollAnchor`).

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
				{message.status === "process_ended" && (
					<p className="mt-2 text-sm text-th-warning">Process ended</p>
				)}
				<MessageActions
					pending={pending}
					// Keyed on being the open turn rather than on being last. The two
					// agreed until a message could be sent mid-reply; now the reply
					// that is still growing routinely has that message under it, and
					// reading position would take its spinner away at the one moment
					// the user has just asked it something. A message left `streaming`
					// that is *not* the open turn gets nothing, which is what stopped
					// a superseded reply from claiming to still be running.
					spinning={
						message.status === "sending" ||
						(message.status === "streaming" && !!isOpenTurn)
					}
					copyText={copyText || undefined}
					onFork={onFork}
					forkBlocked={forkBlocked}
				/>
			</div>
		</div>
	);
});

export type { PermissionChoice };
export default MessageItem;
