import { Bot } from "lucide-react";
import {
	reviewAutomaticLabel,
	reviewCategoryLabel,
} from "../../lib/permissionReview";
import { useWSStore } from "../../lib/wsStore";
import type {
	PermissionAnswerer,
	PermissionReview,
	PermissionRuleValue,
	PermissionStatus,
	PermissionUpdate,
	PermissionUpdateDestination,
	ToolRunPermission,
} from "../../types/message";
import { formatFilePath } from "../../utils/path";
import { usePermissionReview } from "./permissionReviewContext";
import { RowSubline } from "./ToolRow";

// How a permission's answer is worded: on the card that asked, and on the row
// an answered card hands its place back to
// (docs/tool-call-ui.md#the-permission-card-takes-the-rows-place).

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
export function SuggestionLine({ update }: { update: PermissionUpdate }) {
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

/** Who answered a card in a person's place, as its verdict line says it. */
export type Verdict =
	| { by: "permission_reviewer"; allowed: boolean; review?: PermissionReview }
	| { by: "pockode"; review?: PermissionReview };

// A `by` this build does not know draws no line: there is nothing true to say
// about an answerer it cannot name beyond what the status glyph already says.
export function readVerdict(
	status: PermissionStatus,
	by: PermissionAnswerer | undefined,
	review: PermissionReview | undefined,
): Verdict | undefined {
	if (status !== "allowed" && status !== "denied") return undefined;
	if (by === "permission_reviewer") {
		return { by: "permission_reviewer", allowed: status === "allowed", review };
	}
	if (by === "pockode") return { by: "pockode", review };
	return undefined;
}

// Accent text over a text line rather than a box: the line is a statement, and
// the link the one thing in it to press. At module scope for the hit-area scan
// (web/tests/touchTarget.ts, `interactiveControls`).
const VIEW_REVIEW =
	"touch-target shrink-0 rounded text-th-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent";

/**
 * The link to the reviewer session that answered, when there is one to go to:
 * not when the review failed before a reviewer existed, and not when it is the
 * session on screen — a reviewer's own request is denied in its own transcript
 * (docs/unattended-mode-ui.md §3.2). Whether the reviewer still exists is not
 * the record's to say; a deleted one lands on the session-not-found screen.
 */
function ViewReviewLink({ sessionId }: { sessionId?: string }) {
	const view = usePermissionReview();
	if (!sessionId || sessionId === view.sessionId || !view.onOpenSession) {
		return null;
	}
	const open = view.onOpenSession;
	return (
		<>
			<span aria-hidden="true">·</span>
			<button
				type="button"
				onClick={() => open(sessionId)}
				className={VIEW_REVIEW}
			>
				View review
			</button>
		</>
	);
}

const REVIEWER_GLYPH = (
	<Bot className="mt-0.5 size-3 shrink-0 text-th-text-muted" aria-hidden />
);

/**
 * Who answered, or who is answering, under the card's row and outside its
 * body, so it shows folded (docs/unattended-mode-ui.md §3). The reason is the
 * reviewer's words or Pockode's, plain text whatever it says: it is model
 * output a prompt injection may have written, so it is never markdown and never
 * linked. Folded it is cut to two lines; open, the body has it whole.
 */
export function VerdictLine({
	verdict,
	reviewing,
	answerable,
	expanded,
}: {
	verdict?: Verdict;
	reviewing: boolean;
	/**
	 * Whether this screen can answer; a read-only one cannot. Only read while
	 * the review is under way.
	 */
	answerable?: boolean;
	expanded: boolean;
}) {
	if (reviewing) {
		return (
			<RowSubline glyph={REVIEWER_GLYPH}>
				<span className="text-th-text-muted">
					{answerable
						? "Permission reviewer is checking this. You can answer first."
						: "Permission reviewer is checking this."}
				</span>
			</RowSubline>
		);
	}
	if (!verdict) return null;

	const review = verdict.review;
	let headline: string;
	if (verdict.by === "pockode") {
		headline = `Denied by Pockode — ${reviewAutomaticLabel(review?.automatic)}`;
	} else if (verdict.allowed) {
		headline = "Allowed by the permission reviewer";
	} else {
		headline = review?.category
			? `Denied by the permission reviewer — ${reviewCategoryLabel(review.category)}`
			: "Denied by the permission reviewer";
	}

	return (
		<RowSubline
			glyph={verdict.by === "permission_reviewer" ? REVIEWER_GLYPH : undefined}
		>
			<span className="flex flex-wrap items-baseline gap-x-1.5 text-th-text-muted">
				<span>{headline}</span>
				<ViewReviewLink sessionId={review?.sessionId} />
			</span>
			{review?.reason && !expanded && (
				<span className="line-clamp-2 whitespace-pre-wrap break-words text-th-text-secondary">
					{review.reason}
				</span>
			)}
		</RowSubline>
	);
}

/**
 * What the row an answered card handed its place to says about a person's
 * allow, as one muted line at the top of its body: routine, so nothing on the
 * row itself. What Always Allow wrote is said in the words the card used
 * before it was pressed. A reviewer's answer says it on its verdict line
 * instead, and its reason here; a deny says it on the row.
 */
export function PermissionAnswerNote({
	permission,
}: {
	permission: ToolRunPermission;
}) {
	const verdict = readVerdict(
		permission.answer,
		permission.by,
		permission.review,
	);
	if (verdict) {
		const reason = verdict.review?.reason;
		return reason ? (
			<p className="whitespace-pre-wrap break-words text-th-text-secondary">
				{reason}
			</p>
		) : null;
	}
	// An answerer this build cannot name has nothing true said about it.
	if (permission.by || permission.answer !== "allowed") return null;
	if (!permission.always) {
		return <p className="text-th-text-muted">Allowed by you</p>;
	}
	const suggestions = permission.suggestions ?? [];
	// Only Codex offers Always Allow with no rule to show: its "always" is
	// `acceptForSession`.
	if (suggestions.length === 0) {
		return (
			<p className="text-th-text-muted">
				Always allowed · until the session ends
			</p>
		);
	}
	return (
		<div className="space-y-1 text-th-text-muted">
			{suggestions.map((update, idx) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a request's suggestions never change
				<p key={idx}>
					Always allowed · <SuggestionLine update={update} />
				</p>
			))}
		</div>
	);
}
