import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";
import { describeGitSync, type GitSync } from "../../types/git";

interface Props {
	sync: GitSync;
	onClick: () => void;
}

/**
 * The branch bar's right-hand target: how this branch stands against its
 * upstream, and the way into the sync sheet.
 *
 * The counts are as old as the last fetch, which only the sheet has room to
 * say — so the chip is a button in every state, including "up to date".
 */
function SyncChip({ sync, onClick }: Props) {
	const { needsPublish } = describeGitSync(sync);

	return (
		<button
			type="button"
			onClick={onClick}
			className="flex min-h-[36px] shrink-0 items-center gap-1 rounded px-2 pointer-coarse:min-h-11 text-xs text-th-text-secondary transition-colors hover:bg-th-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
			aria-label={`Sync with remote, ${describeState(sync, needsPublish)}`}
		>
			{needsPublish ? (
				"Publish"
			) : sync.behind === 0 && sync.ahead === 0 ? (
				<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
			) : (
				<>
					{sync.behind > 0 && (
						<span className="flex items-center">
							<ArrowDown className="h-3 w-3" aria-hidden="true" />
							{sync.behind}
						</span>
					)}
					{sync.ahead > 0 && (
						<span className="flex items-center">
							<ArrowUp className="h-3 w-3" aria-hidden="true" />
							{sync.ahead}
						</span>
					)}
				</>
			)}
		</button>
	);
}

/** Spells the arrows out, since a screen reader gets nothing from them. */
function describeState(sync: GitSync, needsPublish: boolean): string {
	if (needsPublish) {
		return "branch not published";
	}

	const parts: string[] = [];
	if (sync.behind > 0) parts.push(`${sync.behind} to pull`);
	if (sync.ahead > 0) parts.push(`${sync.ahead} to push`);
	return parts.length > 0 ? parts.join(", ") : "up to date";
}

export default SyncChip;
