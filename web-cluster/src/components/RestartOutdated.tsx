import { Sheet, Spinner } from "@pockode/shared";
import { displayVersion, versionLabel } from "../lib/version";
import type { NodeWithStatus } from "../types/node";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";
import { InstalledArrow } from "./InstalledArrow";

/** What the strip is drawn from, the same threshold as Clean up all's. */
export const BATCH_THRESHOLD = 2;

function nodesWord(count: number) {
	return count === 1 ? "1 node is" : `${count} nodes are`;
}

function names(nodes: NodeWithStatus[]) {
	return nodes.map((node) => node.name).join(", ");
}

interface StripProps {
	/** The installed version every outdated node would restart into. */
	installed: string;
	/** Outdated nodes the cluster can ask: what the button restarts. */
	askable: NodeWithStatus[];
	/** Older nodes: outdated too, but each needs its password on its card. */
	older: NodeWithStatus[];
	/** Refused by the last batch for something other than being older. */
	failedCount: number;
	onOpen: () => void;
}

/**
 * The top-of-list strip for an upgrade (docs/restart-ui.md, "Restart all
 * outdated"). Not sticky and not a warning: it is news the user caused, and
 * the cards carry their own marker anyway.
 */
export function RestartOutdatedStrip({
	installed,
	askable,
	older,
	failedCount,
	onOpen,
}: StripProps) {
	const total = askable.length + older.length;
	return (
		<div className="mb-2 flex flex-col gap-2 rounded-lg border border-th-border bg-th-bg-secondary p-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex items-start gap-2 text-sm text-th-text-secondary">
				<InstalledArrow />
				<p>
					{displayVersion(installed)} installed · {nodesWord(total)} outdated
					{askable.length === 0 &&
						". Restart each from its card; nodes started by an older Pockode need their password."}
					{failedCount > 0 &&
						(failedCount === 1
							? ". 1 couldn't restart; its card says why."
							: `. ${failedCount} couldn't restart; their cards say why.`)}
				</p>
			</div>
			{askable.length > 0 && (
				<button
					type="button"
					onClick={onOpen}
					className={`${NEUTRAL_BUTTON} shrink-0`}
				>
					Restart all outdated ({askable.length})
				</button>
			)}
		</div>
	);
}

interface SheetProps {
	installed: string | null;
	askable: NodeWithStatus[];
	older: NodeWithStatus[];
	/** A read started on opening has not landed: the list may still change. */
	reading: boolean;
	loading: boolean;
	onConfirm: () => void;
	onClose: () => void;
}

/** The batch's confirmation. N is recomputed from the list it is given. */
export function RestartOutdatedSheet({
	installed,
	askable,
	older,
	reading,
	loading,
	onConfirm,
	onClose,
}: SheetProps) {
	const count = askable.length;
	return (
		<Sheet
			title={
				count === 0
					? "Restart outdated nodes"
					: count === 1
						? "Restart 1 outdated node?"
						: `Restart ${count} outdated nodes?`
			}
			onClose={onClose}
			dismissible={!loading}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						disabled={loading}
						className={`${NEUTRAL_BUTTON} flex-1`}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						aria-busy={loading}
						disabled={reading || loading || count === 0}
						className={`${PRIMARY_BUTTON} flex-1`}
					>
						{loading && <Spinner size="h-4 w-4" />}
						{loading ? "Restarting..." : `Restart ${count}`}
					</button>
				</>
			}
		>
			<div className="flex flex-col gap-3 p-4 text-sm text-th-text-secondary">
				<ul className="flex flex-col gap-1 text-th-text-primary">
					{askable.map((node) => (
						<li key={node.id} className="truncate">
							{node.name}
							{node.status.version !== undefined && (
								<span className="text-th-text-muted">
									{" "}
									— {versionLabel(node.status.version)}
								</span>
							)}
						</li>
					))}
				</ul>
				{installed === null && !reading ? (
					// The re-read on opening could not compare: nothing is called
					// outdated on a guess, and the header's sheet has the reason.
					<p role="alert">
						The installed version couldn't be read just now, so no node is
						called outdated. The version in the header says why.
					</p>
				) : (
					<p>
						They restart and come back running{" "}
						{installed === null
							? "the installed version"
							: displayVersion(installed)}
						. Any AI turn running in them is stopped — sessions and history are
						kept, and can be continued afterwards.
					</p>
				)}
				{older.length === 1 && (
					<p>
						Not included: {older[0].name} — started by an older Pockode, it
						needs its password. Restart it from its card.
					</p>
				)}
				{older.length > 1 && (
					<p>
						Not included: {names(older)} — started by an older Pockode, each
						needs its password. Restart them from their cards.
					</p>
				)}
			</div>
		</Sheet>
	);
}
