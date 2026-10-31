import { Sheet, Spinner } from "@pockode/shared";
import { useState } from "react";
import {
	type InstalledVersionState,
	installedOf,
	useFreshRead,
} from "../hooks/useInstalledVersion";
import { differingVersion, displayVersion, versionLabel } from "../lib/version";
import { useWSStore } from "../lib/wsStore";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";
import { InstalledArrow } from "./InstalledArrow";

function errorMessage(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

/**
 * The header's version button and the "Pockode cluster" sheet it opens, which
 * is both the information and the restart's confirmation (docs/restart-ui.md,
 * "web-cluster: the header"; cluster-ui.md rules 2 and 3). The installed read
 * is the list's, shared with the node cards.
 */
export function ClusterVersion({
	running,
	installedState,
}: {
	running: string;
	installedState: InstalledVersionState;
}) {
	const { actions } = useWSStore();
	const [sheetOpen, setSheetOpen] = useState(false);
	const fresh = useFreshRead(installedState);
	const [restarting, setRestarting] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);

	const openSheet = () => {
		setRefusal(null);
		fresh.begin();
		setSheetOpen(true);
	};

	const closeSheet = () => setSheetOpen(false);

	const confirmRestart = async () => {
		setRefusal(null);
		setRestarting(true);
		try {
			await actions.restartServer();
			setSheetOpen(false);
		} catch (err) {
			setRefusal(errorMessage(err, "The cluster refused to restart"));
		} finally {
			setRestarting(false);
		}
	};

	const { read } = installedState;
	const installed = installedOf(installedState);
	const newVersion = differingVersion(running, installed);
	const differs = newVersion !== null;
	const reading = fresh.reading;
	const unreadable =
		!reading && installed !== null && installed.version === undefined;

	const runningLabel = versionLabel(running);
	// Starts with the visible label, so a voice user can say what they see.
	const buttonName = differs
		? `Pockode cluster ${runningLabel}, ${displayVersion(newVersion)} installed`
		: `Pockode cluster ${runningLabel}`;

	return (
		<>
			<button
				type="button"
				onClick={openSheet}
				aria-label={buttonName}
				className="flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs text-th-text-secondary hover:bg-th-overlay-hover"
			>
				{differs && <InstalledArrow testId="version-differs" />}
				<span>{runningLabel}</span>
				{differs && (
					<span className="hidden sm:inline">
						→ {displayVersion(newVersion)}
					</span>
				)}
			</button>

			{sheetOpen && (
				<Sheet
					title="Pockode cluster"
					onClose={closeSheet}
					dismissible={!restarting}
					footer={
						unreadable ? (
							<button
								type="button"
								onClick={closeSheet}
								className={`${NEUTRAL_BUTTON} flex-1`}
							>
								Close
							</button>
						) : (
							<>
								<button
									type="button"
									onClick={closeSheet}
									disabled={restarting}
									className={`${NEUTRAL_BUTTON} flex-1`}
								>
									Cancel
								</button>
								<button
									type="button"
									onClick={confirmRestart}
									aria-busy={restarting}
									disabled={reading || restarting}
									className={`${differs ? PRIMARY_BUTTON : NEUTRAL_BUTTON} flex-1`}
								>
									{restarting && <Spinner variant="current" srText={null} />}
									Restart
								</button>
							</>
						)
					}
				>
					<div className="flex flex-col gap-4 p-4 text-sm">
						<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
							<dt className="text-th-text-secondary">Running</dt>
							<dd className="text-th-text-primary">
								{displayVersion(running)}
							</dd>
							<dt className="text-th-text-secondary">Installed</dt>
							<dd>
								{reading || read === null ? (
									<>
										<span
											className="inline-block h-4 w-16 animate-pulse rounded bg-th-bg-tertiary align-middle"
											aria-hidden="true"
										/>
										<span className="sr-only">Reading...</span>
									</>
								) : installed === null ? (
									<span className="text-th-text-muted">unknown</span>
								) : installed.version === undefined ? (
									<span className="text-th-error">couldn't read</span>
								) : (
									<span className="text-th-text-primary">
										{displayVersion(installed.version)}
									</span>
								)}
							</dd>
						</dl>

						{unreadable ? (
							<p className="text-th-text-secondary">
								{(installed.error ?? "It reported no version").replace(
									/\.$/,
									"",
								)}
								. The cluster can't restart until{" "}
								<span className="break-all font-mono">{installed.path}</span>{" "}
								runs. Reinstall it on the server.
							</p>
						) : (
							<>
								{!reading && read?.kind === "failed" && (
									<p className="text-th-text-secondary">
										Couldn't ask the cluster for its installed version:{" "}
										{read.message}
									</p>
								)}
								{!reading && differs && (
									<p className="text-th-text-primary">
										Restart to use {displayVersion(newVersion)}.
									</p>
								)}
								<p className="text-th-text-secondary">
									Restarting the cluster manager doesn't affect nodes: they keep
									running and stay reachable at their own addresses. This panel
									reconnects by itself.
								</p>
								{refusal && (
									<p role="alert" className="text-th-error">
										{refusal}
									</p>
								)}
							</>
						)}
					</div>
				</Sheet>
			)}
		</>
	);
}
