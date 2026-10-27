import { Check, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
	type CheckoutRun,
	gitCheckoutActions,
	useCheckoutRun,
} from "../../lib/gitCheckoutStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { GitBranches } from "../../types/git";
import { Spinner } from "../ui";
import { iconButtonClass } from "../ui/iconButtonClass";
import { inputClass } from "../ui/inputClass";
import BranchName from "./BranchName";
import GitOutput from "./GitOutput";

/** Below this many branches the list fits on screen and a filter is just noise. */
const FILTER_THRESHOLD = 8;

const rowClass = (disabled: boolean) =>
	`flex min-h-[44px] w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${
		disabled
			? "cursor-not-allowed text-th-text-muted"
			: "text-th-text-primary hover:bg-th-bg-tertiary"
	}`;

export interface BranchCheckout extends CheckoutRun {
	checkout: (branch: string) => void;
	dismissError: () => void;
}

/**
 * This worktree's switch and how it ended, for the page that hosts the list:
 * it holds the way to a new branch while `switchingTo` is set, which is why
 * this lives above the list. The run itself is gitCheckoutStore's, so it
 * outlives the page.
 */
export function useBranchCheckout(
	onCheckout: (branch: string) => Promise<unknown>,
): BranchCheckout {
	const worktree = useWorktreeStore((s) => s.current);
	const run = useCheckoutRun(worktree);

	return {
		...run,
		checkout: (branch) =>
			void gitCheckoutActions.start(worktree, branch, () => onCheckout(branch)),
		dismissError: () => gitCheckoutActions.dismissError(worktree),
	};
}

interface Props {
	branches: GitBranches;
	state: BranchCheckout;
}

/**
 * The branches to switch to: local ones first, then the remote-only ones, with
 * a filter once the list is long.
 */
function BranchList({ branches, state }: Props) {
	const [filter, setFilter] = useState("");
	const filterId = useId();
	const { switchingTo, error, checkout, dismissError } = state;

	const { local, remote } = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const matches = (text: string) =>
			!needle || text.toLowerCase().includes(needle);

		return {
			local: branches.local.filter((b) => matches(b.name)),
			remote: branches.remote_only.filter((b) => matches(b.ref)),
		};
	}, [branches, filter]);

	const showFilter =
		branches.local.length + branches.remote_only.length > FILTER_THRESHOLD;
	const isSwitching = switchingTo !== null;

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

				{error && (
					<div className="flex items-start gap-2 px-4 py-3">
						<div className="min-w-0 flex-1 space-y-1" role="alert">
							<p className="text-sm text-th-error">{error.summary}</p>
							{/* Absent when the server refused before running git: there
							    is no output to quote, only the sentence above. */}
							{error.detail && <GitOutput>{error.detail}</GitOutput>}
						</div>
						{/* A page has no sheet whose closing puts the refusal away. */}
						<button
							type="button"
							onClick={dismissError}
							aria-label="Dismiss error"
							className={iconButtonClass()}
						>
							<X className="h-4 w-4" aria-hidden="true" />
						</button>
					</div>
				)}
			</div>

			{local.map((branch) => {
				const occupied = Boolean(branch.worktree);
				const disabled = branch.current || occupied || isSwitching;

				return (
					<button
						key={`local:${branch.name}`}
						type="button"
						onClick={() => checkout(branch.name)}
						disabled={disabled}
						className={rowClass(disabled)}
					>
						{branch.current ? (
							<Check
								className="h-4 w-4 shrink-0 text-th-success"
								aria-hidden="true"
							/>
						) : (
							<span className="h-4 w-4 shrink-0" />
						)}
						<BranchName name={branch.name} />
						{switchingTo === branch.name ? (
							<Spinner variant="current" className="shrink-0" />
						) : (
							<RowHint
								text={
									branch.current
										? "current"
										: occupied
											? `in ${branch.worktree}`
											: null
								}
							/>
						)}
					</button>
				);
			})}

			{remote.length > 0 && (
				<div className="mt-2 border-t border-th-border px-4 pt-2 pb-1 text-xs uppercase text-th-text-muted">
					Remote
				</div>
			)}
			{remote.map((branch) => (
				<button
					key={`remote:${branch.ref}`}
					type="button"
					onClick={() => checkout(branch.name)}
					disabled={isSwitching}
					className={rowClass(isSwitching)}
				>
					<span className="h-4 w-4 shrink-0" />
					<BranchName name={branch.ref} />
					{switchingTo === branch.name && (
						<Spinner variant="current" className="shrink-0" />
					)}
				</button>
			))}

			{local.length === 0 && remote.length === 0 && (
				<p className="px-4 py-3 text-sm text-th-text-muted">
					{filter.trim() ? "No branches match." : "No branches yet."}
				</p>
			)}
		</>
	);
}

function RowHint({ text }: { text: string | null }) {
	if (!text) return null;

	return <span className="shrink-0 text-xs text-th-text-muted">{text}</span>;
}

export default BranchList;
