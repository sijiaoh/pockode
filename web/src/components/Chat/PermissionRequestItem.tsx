import { Check, CircleHelp, Lock, X } from "lucide-react";
import { type MouseEvent, useId, useMemo } from "react";
import { fullScreenSubject } from "../../lib/fullScreen";
import {
	changeRowCount,
	proposedChange,
	proposedChangeText,
} from "../../lib/proposedChange";
import { CodeHighlighter } from "../../lib/shikiUtils";
import { toolSummary, toolSummaryLine } from "../../lib/toolSummary";
import { useWSStore } from "../../lib/wsStore";
import type {
	ExpiryReason,
	PermissionRequest,
	PermissionRuleValue,
	PermissionStatus,
	PermissionUpdate,
	PermissionUpdateDestination,
} from "../../types/message";
import { HIGHLIGHT_LIMIT } from "../../utils/fileView";
import { formatFilePath } from "../../utils/path";
import { CollapsibleBody } from "../ui";
import {
	changeFullScreenContent,
	ProposedChange,
	proposedChangeHeader,
} from "./ProposedChange";
import { useRowExpanded } from "./rowExpansionContext";
import { Armed } from "./SendStopSlot";
import { invocationView, ToolInvocation } from "./ToolInvocation";
import { ToolRow } from "./ToolRow";
import { Section, type SectionFullScreen } from "./ToolSection";
import { keepClearProps } from "./useTranscriptScroll";

export type PermissionChoice = "deny" | "allow" | "always_allow";

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
	/**
	 * Re-arms the buttons for `ARM_MS` whenever it changes; absent, as in the
	 * transcript, they are live at once. The canvas's permission panel passes
	 * one, because a card settling there moves the next card's buttons under
	 * the thumb that pressed (docs/canvas-ui.md §10.1).
	 */
	armKey?: string;
	/**
	 * Another request in the same list was denied on Claude, which ends the
	 * turn: this one is about to expire, and an answer would only be refused.
	 */
	endingTurn?: boolean;
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
// One line at any width: the secondary buttons take their label's width and
// Allow, the primary, takes what is left — a label wrapped at 360px made one
// button two lines tall beside two that are one.
const PERMISSION_BUTTON =
	"min-h-9 whitespace-nowrap rounded-md px-3 text-sm font-medium pointer-coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";
const PERMISSION_SECONDARY = `${PERMISSION_BUTTON} flex-none border border-th-border bg-th-bg-primary text-th-text-primary hover:bg-th-overlay-hover`;

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
export const PERMISSION_EXPIRY_COPY: Partial<Record<ExpiryReason, string>> = {
	process_ended:
		"The agent's process ended before this was answered, so it counted as a denial and the tool did not run.",
	timeout:
		"This request was not answered in time, so it counted as a denial and the tool did not run.",
	work_closed:
		"This request was cancelled because the work was closed. The tool did not run.",
};

// Said when the reason is unknown or is not one this card can carry, and true of
// all of them.
export const PERMISSION_EXPIRY_FALLBACK =
	"The agent stopped waiting for this request, so it counted as a denial and the tool did not run.";

// The same sentences for several requests that expired together, after the
// count: the canvas says a batch's expiries once (docs/canvas-ui.md §10.1).
const PERMISSION_EXPIRY_PLURAL: Partial<Record<ExpiryReason, string>> = {
	process_ended:
		"the agent's process ended before they were answered, so they counted as denials and the tools did not run.",
	timeout:
		"they were not answered in time, so they counted as denials and the tools did not run.",
	work_closed:
		"they were cancelled because the work was closed. The tools did not run.",
};

const PERMISSION_EXPIRY_PLURAL_FALLBACK =
	"the agent stopped waiting for them, so they counted as denials and the tools did not run.";

/**
 * What the expired cards say, as one sentence: the card's own for one, and for
 * several a count with the reason they share — or the fallback, true of all of
 * them, when they do not share one.
 */
export function permissionExpiryText(
	reasons: (ExpiryReason | undefined)[],
): string {
	const [first] = reasons;
	if (reasons.length === 1) {
		return (
			(first && PERMISSION_EXPIRY_COPY[first]) ?? PERMISSION_EXPIRY_FALLBACK
		);
	}
	const shared = reasons.every((r) => r === first) ? first : undefined;
	const why =
		(shared && PERMISSION_EXPIRY_PLURAL[shared]) ??
		PERMISSION_EXPIRY_PLURAL_FALLBACK;
	return `${reasons.length} permission requests expired: ${why}`;
}

// In the canvas's panel a press must not focus the button it lands on: the
// card remounts settled, and only a keyboard answer has focus to carry on.
const keepFocus = (e: MouseEvent) => e.preventDefault();

export function PermissionRequestItem({
	request,
	status,
	reason,
	isCodex,
	onRespond,
	onOpenFile,
	error,
	armKey,
	endingTurn = false,
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
	const pressProps = armKey === undefined ? {} : { onMouseDown: keepFocus };

	const buttons = onRespond && (
		<>
			<button
				type="button"
				{...pressProps}
				onClick={() => onRespond(request, "deny")}
				className={PERMISSION_SECONDARY}
			>
				Deny
			</button>
			{offersAlwaysAllow && (
				<button
					type="button"
					{...pressProps}
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
				{...pressProps}
				onClick={() => onRespond(request, "allow")}
				className={`${PERMISSION_BUTTON} flex-1 bg-th-accent text-th-accent-text hover:opacity-90`}
			>
				Allow
			</button>
		</>
	);

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
			// The open row's bar is the exception: it has a z-index to stay over
			// what it is pinned above, which also puts it over this outline, so
			// the tint and the frame are restated for it as `--row-tint` and
			// `--row-frame` (`row-bar`).
			className={`scroll-mt-14 text-xs ${isPending ? "bg-th-warning/10 [--row-tint:color-mix(in_oklab,var(--th-warning)_10%,transparent)] outline-1 -outline-offset-1 outline-th-warning [--row-frame:var(--th-warning)]" : ""}`}
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
				    about — and restates it for a pinned section header
				    (`section-bar`), which would otherwise paint a drawer's. */}
				<div
					className={`space-y-3 border-t border-th-border p-2 ${isPending ? "[--section-ground:linear-gradient(var(--row-tint),var(--row-tint)),var(--row-ground,var(--th-bg-primary))]" : "bg-th-bg-secondary"}`}
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

			{isPending && onRespond && endingTurn && (
				<p className="border-t border-th-border px-2 py-2 text-th-text-muted">
					Ending the turn…
				</p>
			)}

			{isPending && onRespond && !endingTurn && (
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
					<div className="flex gap-2 p-2" {...keepClearProps}>
						{armKey === undefined ? (
							buttons
						) : (
							// Full width, so Allow keeps its `flex-1`.
							<Armed key={armKey} className="flex-1 gap-2">
								{buttons}
							</Armed>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * A pending request whose record this client does not have (docs/canvas-ui.md
 * §10.4). Nothing to answer with: an answer would have to quote what cannot be
 * shown, and the user must not grant something unread. `loading` while the
 * record is on its way — the server raises the blocker a moment before it
 * sends the record — and otherwise never coming: its append failed, so it was
 * only broadcast, before this client was listening.
 */
export function UnreadablePermissionItem({
	loading = false,
}: {
	loading?: boolean;
}) {
	return (
		<div className="flex items-start gap-2 bg-th-warning/10 px-2 py-2 text-xs text-th-text-primary outline-1 -outline-offset-1 outline-th-warning">
			<Lock
				className="mt-0.5 size-3 shrink-0 text-th-warning"
				aria-hidden="true"
			/>
			<p>
				{loading
					? "Loading the permission request…"
					: "A permission request is waiting, but its details could not be read. Stop the turn to go on."}
			</p>
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
	const changeCount = useMemo(
		() =>
			change
				? { noun: "line" as const, total: changeRowCount(change) }
				: undefined,
		[change],
	);
	const workDir = useWSStore((state) => state.workDir);
	const title = toolSummaryLine(
		toolSummary(request.toolName, request.toolInput, workDir),
	);
	// Its own keys, apart from the row's: the card and the row it becomes can
	// both be on screen.
	const fullScreenKey = `card:${request.toolUseId}`;
	const changeFullScreen = useMemo<SectionFullScreen | undefined>(
		() =>
			change
				? {
						key: `${fullScreenKey}:change`,
						title,
						subject: fullScreenSubject(request.toolName, request.toolInput),
						content: changeFullScreenContent(change, onOpenFile),
					}
				: undefined,
		[
			change,
			fullScreenKey,
			title,
			request.toolName,
			request.toolInput,
			onOpenFile,
		],
	);
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
				fullScreen={{ key: `${fullScreenKey}:plan`, title }}
			/>
			{change && (
				<Section
					label="Proposed change"
					noun="change"
					{...changeHeader}
					copyText={proposedChangeText(change)}
					fullScreen={changeFullScreen}
					budget="main"
					count={changeCount}
				>
					<ProposedChange change={change} onOpenFile={onOpenFile} />
				</Section>
			)}
			{showRaw && <RawInput input={request.toolInput} />}
		</>
	);
}
