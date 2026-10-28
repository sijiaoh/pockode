import { Plus } from "lucide-react";
import { useId, useState } from "react";
import {
	useGitBranchActions,
	useGitBranches,
} from "../../hooks/useGitBranches";
import { useGitStatus } from "../../hooks/useGitStatus";
import { branchSwitchPausedReason } from "../../lib/gitOperation";
import { BottomActionBar, Spinner } from "../ui";
import { headLabel } from "./BranchBar";
import BranchList, { useBranchCheckout } from "./BranchList";
import NewBranchSheet from "./NewBranchSheet";

/**
 * The Git workspace's Branches segment: the branch list as a page, with the
 * way to a new branch fixed under it.
 *
 * A switch that succeeds stays here — the check moves to the new branch and
 * the name in the top bar changes, which is the whole report of it.
 */
function BranchesSection() {
	const { data: branches, isLoading, error } = useGitBranches();
	const { checkoutMutation, createMutation } = useGitBranchActions();
	const checkout = useBranchCheckout(async (branch) => {
		await checkoutMutation.mutateAsync(branch);
	});
	const [creating, setCreating] = useState(false);
	const pausedId = useId();

	const head = branches?.head;
	const isSwitching = checkout.switchingTo !== null;
	const operation = useGitStatus().data?.operation;
	const paused = operation ? branchSwitchPausedReason(operation.kind) : null;

	return (
		<>
			{/* No vertical padding of its own: the list pins its filter and its
			    refusals to the top of this scroller. */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{/* Data first, as in the top bar: a refetch that fails leaves the
				    branches already known. */}
				{branches ? (
					<BranchList
						branches={branches}
						state={checkout}
						paused={paused}
						pausedId={pausedId}
					/>
				) : isLoading ? (
					<div className="flex items-center justify-center p-8">
						<Spinner variant="current" className="text-th-text-muted" />
					</div>
				) : (
					error && (
						<div className="p-4 text-center text-th-error">
							<div>Failed to load branches</div>
							<div className="mt-1 text-sm text-th-text-muted">
								{error instanceof Error ? error.message : String(error)}
							</div>
						</div>
					)
				)}
			</div>

			{head && (
				<BottomActionBar>
					<button
						type="button"
						onClick={() => setCreating(true)}
						disabled={isSwitching || paused !== null}
						aria-describedby={paused ? pausedId : undefined}
						className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-th-bg-tertiary px-4 py-2.5 text-sm text-th-text-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<Plus className="h-4 w-4" aria-hidden="true" />
						New branch…
					</button>
				</BottomActionBar>
			)}

			{creating && head && (
				<NewBranchSheet
					base={headLabel(head)}
					paused={paused}
					onClose={() => setCreating(false)}
					onCreate={async (name) => {
						await createMutation.mutateAsync(name);
						setCreating(false);
					}}
				/>
			)}
		</>
	);
}

export default BranchesSection;
