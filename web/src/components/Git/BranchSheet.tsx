import { Check, Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { GitBranches } from "../../types/git";
import { Sheet, Spinner } from "../ui";
import BranchName from "./BranchName";
import GitOutput from "./GitOutput";

interface Props {
	branches: GitBranches;
	onClose: () => void;
	onCheckout: (branch: string) => Promise<void>;
	onNewBranch: () => void;
}

/** Below this many branches the list fits on screen and a filter is just noise. */
const FILTER_THRESHOLD = 8;

/**
 * git's own refusal ends with "commit your changes or stash them". Pockode never
 * stashes — worktrees share one stash stack (docs/git-ui.md) — so the summary
 * names the two options the panel actually offers. Unmatched messages (other
 * failures, a non-English git) simply get no extra guidance.
 */
const OVERWRITE_REFUSAL = /would be overwritten by checkout/i;

function BranchSheet({ branches, onClose, onCheckout, onNewBranch }: Props) {
	const [filter, setFilter] = useState("");
	const [switchingTo, setSwitchingTo] = useState<string | null>(null);
	const [error, setError] = useState<{
		branch: string;
		message: string;
	} | null>(null);
	const filterId = useId();

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

	const handleCheckout = async (branch: string) => {
		if (isSwitching) return;

		setError(null);
		setSwitchingTo(branch);
		try {
			await onCheckout(branch);
		} catch (err) {
			setError({
				branch,
				message: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setSwitchingTo(null);
		}
	};

	const rowClass = (disabled: boolean) =>
		`flex min-h-[44px] w-full items-center gap-2 px-4 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent focus-visible:ring-inset ${
			disabled
				? "cursor-not-allowed text-th-text-muted"
				: "text-th-text-primary hover:bg-th-bg-tertiary"
		}`;

	return (
		<Sheet
			title="Switch branch"
			onClose={onClose}
			dismissible={!isSwitching}
			footer={
				<button
					type="button"
					onClick={onNewBranch}
					disabled={isSwitching}
					className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Plus className="h-4 w-4" aria-hidden="true" />
					New branch…
				</button>
			}
		>
			{/*
			 * Pinned above the rows: the list is taller than the sheet whenever
			 * either of these matters. A filter that scrolls away is the way out of
			 * a long list that the user cannot reach, and a refusal that scrolls
			 * away turns a failed switch into a row that simply did nothing — the
			 * user taps a branch from halfway down, and the message lands off the
			 * top of the sheet.
			 */}
			<div className="sticky top-0 z-10 bg-th-bg-secondary">
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
							className="w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none focus:ring-2 focus:ring-th-accent/20"
							autoComplete="off"
						/>
					</div>
				)}

				{error && (
					<div className="space-y-1 px-4 py-3" role="alert">
						<p className="text-sm text-th-error">
							Could not switch to {error.branch}.
							{OVERWRITE_REFUSAL.test(error.message) &&
								" Commit or discard these changes first."}
						</p>
						<GitOutput>{error.message}</GitOutput>
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
						onClick={() => handleCheckout(branch.name)}
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
					onClick={() => handleCheckout(branch.name)}
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
		</Sheet>
	);
}

function RowHint({ text }: { text: string | null }) {
	if (!text) return null;

	return <span className="shrink-0 text-xs text-th-text-muted">{text}</span>;
}

export default BranchSheet;
