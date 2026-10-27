import {
	ArrowDown,
	ArrowUp,
	type LucideIcon,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";
import type { SyncStatus, SyncStep } from "../../utils/gitSyncStatus";
import { Spinner } from "../ui";

interface Props {
	status: SyncStatus;
	onClick: () => void;
}

/**
 * The branch bar's right-hand target: the one step this branch most needs
 * against its upstream, and the way into the sync sheet.
 *
 * Every state only opens the sheet — "Pull 2" names the next step, it does not
 * take it. The counts are as old as the last fetch, which only the sheet has
 * room to say, so the chip is a button in every state, including "Synced".
 *
 * It also carries the progress of a run whose sheet has been closed (the sheet
 * is this chip expanded, so this is where the action was started from), and
 * the failure of an automatic fetch, which nobody started and so has no banner;
 * the chip, the sheet behind it and the sidebar's Git overview are where it is
 * reported.
 */
function SyncChip({ status, onClick }: Props) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center gap-1 rounded px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-xs text-th-text-secondary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			aria-label={`Sync with remote, ${status.description}`}
		>
			{/* Leads rather than replaces: the counts are still the truth until the
			    run refreshes them. */}
			{status.running && (
				<Spinner variant="current" size="h-3.5 w-3.5" srText={null} />
			)}
			{status.autoFetchFailed && (
				<TriangleAlert
					className="h-3.5 w-3.5 text-th-warning"
					aria-hidden="true"
				/>
			)}
			<StepLabel step={status.step} />
		</button>
	);
}

function StepLabel({ step }: { step: SyncStep }) {
	switch (step.kind) {
		case "publish":
			return "Publish";
		// Two verbs do not fit; the sheet says it as a sentence.
		case "diverged":
			return (
				<>
					<Count icon={ArrowDown} count={step.behind} />
					<Count icon={ArrowUp} count={step.ahead} />
				</>
			);
		case "pull":
			return <Count icon={ArrowDown} count={step.behind} verb="Pull" />;
		case "push":
			return <Count icon={ArrowUp} count={step.ahead} verb="Push" />;
		case "unfetched":
			return <Count icon={RefreshCw} verb="Fetch" />;
		case "synced":
			return <Count icon={RefreshCw} verb="Synced" />;
	}
}

function Count({
	icon: Icon,
	count,
	verb,
}: {
	icon: LucideIcon;
	count?: number;
	verb?: string;
}) {
	return (
		<span className={`flex items-center ${verb ? "gap-1" : ""}`}>
			<Icon className="h-3 w-3" aria-hidden="true" />
			{verb && <span>{verb}</span>}
			{count !== undefined && <span className="tabular-nums">{count}</span>}
		</span>
	);
}

export default SyncChip;
