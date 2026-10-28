import { Check, Ellipsis, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
	type BranchRow,
	branchDetails,
	branchRowLabel,
	FILTER_THRESHOLD,
	groupBranches,
} from "../../lib/gitBranches";
import {
	type CheckoutRun,
	gitCheckoutActions,
	useCheckoutRun,
} from "../../lib/gitCheckoutStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { GitBranches } from "../../types/git";
import type { GitFailure } from "../../utils/gitErrors";
import { formatRelativeDate } from "../../utils/relativeTime";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";
import { inputClass } from "../ui/inputClass";
import BranchName from "./BranchName";
import GitOutput from "./GitOutput";

export interface BranchCheckout extends CheckoutRun {
	checkout: (branch: string) => void;
	dismissError: () => void;
	/** Resolves once the delete settles, failed or not; see startDelete. */
	deleteBranch: (branch: string, tip: string) => Promise<void>;
	dismissDeleteError: () => void;
}

/**
 * This worktree's switch and delete and how they ended, for the page that
 * hosts the list: it holds the way to a new branch while `switchingTo` is set,
 * which is why this lives above the list. The runs themselves are
 * gitCheckoutStore's, so they outlive the page.
 */
export function useBranchCheckout(
	onCheckout: (branch: string) => Promise<unknown>,
	onDelete: (branch: string, tip: string) => Promise<unknown>,
): BranchCheckout {
	const worktree = useWorktreeStore((s) => s.current);
	const run = useCheckoutRun(worktree);

	return {
		...run,
		checkout: (branch) =>
			void gitCheckoutActions.start(worktree, branch, () => onCheckout(branch)),
		dismissError: () => gitCheckoutActions.dismissError(worktree),
		deleteBranch: (branch, tip) =>
			gitCheckoutActions.startDelete(worktree, branch, () =>
				onDelete(branch, tip),
			),
		dismissDeleteError: () => gitCheckoutActions.dismissDeleteError(worktree),
	};
}

/**
 * Whether a row has a `⋯`. Never the current branch's, whose every action —
 * merging it into itself, deleting it — would be unavailable.
 */
export function hasMenu(row: BranchRow): boolean {
	return !row.current;
}

interface Props {
	branches: GitBranches;
	state: BranchCheckout;
	/**
	 * Why no branch can be switched to right now — an operation in progress —
	 * null when one can. `pausedId` names the line for the page's own
	 * `New branch…`, which stops for the same reason.
	 */
	paused: string | null;
	pausedId?: string;
	/**
	 * The key of the row whose merge handoff is waiting for a new session:
	 * the list holds still as during a switch, since a switch now would make
	 * the prompt name the wrong branch.
	 */
	handingOff: string | null;
	/** The handoff's failure, pinned beside the list's own. */
	handoffError: GitFailure | null;
	onDismissHandoffError: () => void;
	onOpenMenu: (row: BranchRow) => void;
}

/**
 * The branches to switch to, grouped Recent / Local / Remote once the list is
 * long (docs/git-branches-ui.md#the-list), with the filter and failures pinned
 * above them.
 */
function BranchList({
	branches,
	state,
	paused,
	pausedId,
	handingOff,
	handoffError,
	onDismissHandoffError,
	onOpenMenu,
}: Props) {
	const [filter, setFilter] = useState("");
	const filterId = useId();
	const {
		switchingTo,
		error,
		checkout,
		dismissError,
		deleteError,
		dismissDeleteError,
	} = state;

	const groups = useMemo(
		() => groupBranches(branches, filter),
		[branches, filter],
	);

	const showFilter =
		branches.local.length + branches.remote_only.length > FILTER_THRESHOLD;
	const isSwitching = switchingTo !== null;
	const blocked = isSwitching || handingOff !== null || paused !== null;

	return (
		<>
			{/*
			 * Pinned above the rows: the list is taller than the screen whenever
			 * either of these matters. A filter that scrolls away is the way out of
			 * a long list that the user cannot reach, and a refusal that scrolls
			 * away turns a failed switch into a row that simply did nothing — the
			 * user taps a branch from halfway down, and the message lands off the
			 * top.
			 */}
			{/* Opaque over the rows scrolling under it. */}
			<div className="sticky top-0 z-10 bg-th-bg-primary">
				{showFilter && (
					<div className="p-3">
						<label htmlFor={filterId} className="sr-only">
							Filter branches
						</label>
						<input
							id={filterId}
							type="text"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter branches…"
							className={`w-full rounded-lg bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted ${inputClass}`}
							autoComplete="off"
						/>
					</div>
				)}

				{paused && (
					<p id={pausedId} className="px-4 py-3 text-sm text-th-text-muted">
						{paused}
					</p>
				)}

				{/* Failures share one capped box that scrolls on its own: several,
				    each with git's output, would otherwise push the list off a
				    short phone — and none is dropped to make room. */}
				{(error || deleteError || handoffError) && (
					<div className="max-h-[40dvh] overflow-y-auto">
						{/* Each its own, never merged: two failures are two things
						    the user has not acknowledged yet. */}
						{error && (
							<PinnedFailure failure={error} onDismiss={dismissError} />
						)}
						{deleteError && (
							<PinnedFailure
								failure={deleteError}
								onDismiss={dismissDeleteError}
							/>
						)}
						{handoffError && (
							<PinnedFailure
								failure={handoffError}
								onDismiss={onDismissHandoffError}
							/>
						)}
					</div>
				)}
			</div>

			{groups.length > 0 && branches.default_branch && (
				<p className="px-4 pt-2 pb-1 text-xs text-th-text-muted">
					Compared with {branches.default_branch}
				</p>
			)}

			{groups.map((group, i) => (
				<div key={group.title ?? "all"}>
					{group.title && (
						<div
							className={`px-4 pt-2 pb-1 text-xs uppercase text-th-text-muted ${
								i > 0 ? "mt-2 border-t border-th-border" : ""
							}`}
						>
							{group.title}
						</div>
					)}
					{group.rows.map((row) => (
						<BranchRowItem
							key={row.key}
							row={row}
							defaultBranch={branches.default_branch}
							disabled={row.current || Boolean(row.worktree) || blocked}
							busy={
								switchingTo === row.name
									? `Switching to ${row.label}`
									: handingOff === row.key
										? "Opening a new chat"
										: null
							}
							onCheckout={() => checkout(row.name)}
							onOpenMenu={hasMenu(row) ? () => onOpenMenu(row) : null}
						/>
					))}
				</div>
			))}

			{groups.length === 0 && (
				<p className="px-4 py-3 text-sm text-th-text-muted">
					{filter.trim() ? "No branches match." : "No branches yet."}
				</p>
			)}
		</>
	);
}

function PinnedFailure({
	failure,
	onDismiss,
}: {
	failure: GitFailure;
	onDismiss: () => void;
}) {
	return (
		<div className="flex items-start gap-2 px-4 py-3">
			<div className="min-w-0 flex-1 space-y-1" role="alert">
				<p className="text-sm text-th-error">{failure.summary}</p>
				{/* Absent when the server refused before running git: there is
				    no output to quote, only the sentence above. */}
				{failure.detail && <GitOutput>{failure.detail}</GitOutput>}
			</div>
			{/* A page has no sheet whose closing puts the refusal away. */}
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss error"
				className={iconButtonClass()}
			>
				<X className="h-4 w-4" aria-hidden="true" />
			</button>
		</div>
	);
}

interface RowProps {
	row: BranchRow;
	defaultBranch: string;
	disabled: boolean;
	/** What this row's running switch or merge handoff is doing, for the spinner. */
	busy: string | null;
	onCheckout: () => void;
	/** Null where the row has no `⋯`; the slot then stays empty. */
	onOpenMenu: (() => void) | null;
}

/**
 * One branch: the row that switches to it, and the slot beside it, siblings
 * as in the Changes list. The slot holds the spinner while this row's switch
 * or merge handoff runs and the row's `⋯` otherwise — enabled even on a greyed
 * row, whose menu says why it cannot be deleted — and is left empty on a row
 * with no menu, so names line up.
 */
function BranchRowItem({
	row,
	defaultBranch,
	disabled,
	busy,
	onCheckout,
	onOpenMenu,
}: RowProps) {
	const age = formatRelativeDate(row.committed_at);

	return (
		<div className="flex min-h-[52px] items-center">
			<button
				type="button"
				onClick={onCheckout}
				disabled={disabled}
				aria-label={branchRowLabel(row, defaultBranch, age)}
				className={`flex min-w-0 flex-1 items-center gap-2 self-stretch py-1.5 pl-4 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${
					disabled
						? "cursor-not-allowed text-th-text-muted"
						: "text-th-text-primary hover:bg-th-bg-tertiary"
				}`}
			>
				{row.current ? (
					<Check
						className="h-4 w-4 shrink-0 text-th-success"
						aria-hidden="true"
					/>
				) : (
					<span className="h-4 w-4 shrink-0" />
				)}
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="flex min-w-0">
						<BranchName name={row.label} />
					</span>
					<span className="flex min-w-0 gap-2 text-xs text-th-text-muted">
						{/* Cut at the tail: the state word leads, and it is the reason
						    a greyed row is greyed. */}
						<span className="min-w-0 flex-1 truncate">
							{branchDetails(row).join(" · ")}
						</span>
						<span className="shrink-0">{age}</span>
					</span>
				</span>
			</button>
			<span className="flex h-11 w-11 shrink-0 items-center justify-center text-th-text-muted">
				{busy ? (
					<Spinner variant="current" srText={busy} />
				) : (
					onOpenMenu && (
						<button
							type="button"
							onClick={onOpenMenu}
							aria-label={`More actions for ${row.label}`}
							className={iconButtonClass()}
						>
							<Ellipsis className="h-4 w-4" aria-hidden="true" />
						</button>
					)
				)}
			</span>
		</div>
	);
}

export default BranchList;
