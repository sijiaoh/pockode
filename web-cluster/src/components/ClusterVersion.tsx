import {
	Sheet,
	Spinner,
	UPDATE_BUDGET_MS,
	type UpdateCandidate,
	updateCandidateName,
} from "@pockode/shared";
import { useEffect, useState } from "react";
import { useElapsed } from "../hooks/useElapsed";
import {
	type InstalledVersionState,
	installedOf,
	useFreshRead,
} from "../hooks/useInstalledVersion";
import { updateCheckOf, useUpdateCheck } from "../hooks/useUpdateCheck";
import { isUpdateTimeout } from "../lib/rpc/server";
import { failureOutcome } from "../lib/updateCopy";
import { differingVersion, displayVersion, versionLabel } from "../lib/version";
import { useWSStore } from "../lib/wsStore";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";
import {
	blocksInstall,
	ClusterUpdates,
	offersUpdate,
	ReleaseNotesLink,
	type UpdateFailure,
} from "./ClusterUpdates";
import { CodeText } from "./CodeText";
import { InstalledArrow } from "./InstalledArrow";

/** From when the in-flight line also quotes the server's budget. */
const SHOW_BUDGET_AFTER_MS = 2 * 60_000;

function errorMessage(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

/**
 * The header's version button and the "Pockode cluster" sheet it opens, which
 * is the information, the restart's confirmation and, in place, an update's
 * (docs/restart-ui.md and docs/self-update-ui.md, "web-cluster: the header";
 * cluster-ui.md rules 2 and 3). The installed read is the list's, shared with
 * the node cards; the release check is this header's alone.
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
	const updates = useUpdateCheck();
	const freshCheck = useFreshRead(updates);
	/** The candidate whose confirmation the sheet shows, else its first view. */
	const [confirming, setConfirming] = useState<UpdateCandidate | null>(null);
	/** When this page's install started, while it and its restart are out. */
	const [installingSince, setInstallingSince] = useState<string | undefined>();
	const [failure, setFailure] = useState<UpdateFailure | null>(null);
	const elapsed = useElapsed(installingSince);
	const installing = installingSince !== undefined;

	const check = updateCheckOf(updates);
	const latest = check?.candidates.find((c) => c.channel === "latest") ?? null;
	// The web primary rule: a latest row carrying Update outranks Restart.
	const latestOffersUpdate =
		check !== null && latest !== null && offersUpdate(check, latest, failure);
	// The candidate as the check opened with the confirmation has it now. A
	// re-check whose request failed says nothing new, so the confirmation
	// rests on the last answer and the server decides (as in web).
	const confirmCheck = updates.last;
	const current =
		confirming && confirmCheck
			? (confirmCheck.candidates.find(
					(c) => c.version === confirming.version,
				) ?? null)
			: null;
	// The unreadable file's way out, when one of the rows can install over it.
	const offersInstall =
		check !== null &&
		!blocksInstall(check) &&
		check.candidates.some((c) => c.unavailable === undefined);
	const confirmable =
		current !== null &&
		current.unavailable === undefined &&
		confirmCheck !== null &&
		!blocksInstall(confirmCheck);

	// A candidate gone from the fresh check — installed from elsewhere, or
	// superseded — returns the sheet to what is there now. Not while this page
	// installs it: the check then reports the install, not the candidate.
	useEffect(() => {
		if (
			confirming &&
			installingSince === undefined &&
			!freshCheck.reading &&
			!confirmable
		) {
			setConfirming(null);
		}
	}, [confirming, installingSince, freshCheck.reading, confirmable]);

	// A check that no longer offers the failed release clears its failure, so
	// the release offered again later starts clean.
	useEffect(() => {
		if (
			failure &&
			check &&
			!check.candidates.some((c) => c.version === failure.version)
		) {
			setFailure(null);
		}
	}, [failure, check]);

	// A failure is kept across closing the sheet: one that rules out a retry
	// must not hand Update back for the same broken release. The next press,
	// or a check that no longer offers the release, is what clears it.
	const openSheet = () => {
		setRefusal(null);
		setConfirming(null);
		fresh.begin();
		setSheetOpen(true);
	};

	const closeSheet = () => setSheetOpen(false);

	const openConfirm = (candidate: UpdateCandidate) => {
		setRefusal(null);
		setFailure(null);
		freshCheck.begin();
		setConfirming(candidate);
	};

	/**
	 * Back to the first view, which speaks about now: both reads are asked
	 * again and Restart waits for the installed one, as on opening.
	 */
	const backToFirstView = () => {
		setConfirming(null);
		fresh.begin();
		freshCheck.begin();
	};

	const confirmUpdate = async () => {
		if (!current) return;
		const { version } = current;
		setInstallingSince(new Date().toISOString());
		try {
			try {
				await actions.serverUpdate(version);
			} catch (err) {
				// The install belongs to the cluster and runs on; a restart nobody is
				// watching is not one to send blind (docs/self-update-ui.md).
				if (useWSStore.getState().status !== "connected") {
					setRefusal(
						"The connection was lost during the update. The cluster checks again when it reconnects.",
					);
				} else if (isUpdateTimeout(err)) {
					// Given up on by this page, not answered: whether the file was
					// replaced is for the check the first view asks again to say.
					setRefusal(
						"No answer came for the update, so it may or may not have finished. What is shown here is checked again.",
					);
				} else {
					const outcome = failureOutcome(err, {
						version,
						path: installed?.path ?? null,
						check,
					});
					if (outcome.kind === "say") setFailure({ version, ...outcome });
				}
				backToFirstView();
				return;
			}
			try {
				await actions.restartServer();
				setSheetOpen(false);
			} catch (err) {
				setRefusal(
					`${version} was installed, but the cluster didn't restart: ${errorMessage(err, "it refused")}`,
				);
				backToFirstView();
			}
		} finally {
			setInstallingSince(undefined);
		}
	};

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
	const buttonName = [
		`Pockode cluster ${runningLabel}`,
		differs && `${displayVersion(newVersion)} installed`,
		latest && `${latest.version} out`,
	]
		.filter(Boolean)
		.join(", ");

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
				{latest && (
					<span
						className="h-1.5 w-1.5 shrink-0 rounded-full bg-th-accent"
						aria-hidden="true"
						data-testid="release-out"
					/>
				)}
			</button>

			{sheetOpen && confirming && (
				<Sheet
					title={`Update the cluster to ${confirming.version}?`}
					onClose={closeSheet}
					dismissible={!installing}
					footer={
						<>
							<button
								type="button"
								onClick={() => setConfirming(null)}
								disabled={installing}
								className={`${NEUTRAL_BUTTON} flex-1`}
							>
								Back
							</button>
							<button
								type="button"
								onClick={confirmUpdate}
								aria-busy={installing}
								disabled={freshCheck.reading || !confirmable || installing}
								className={`${PRIMARY_BUTTON} flex-1`}
							>
								{installing && <Spinner variant="current" srText={null} />}
								{installing ? "Installing..." : "Update and restart"}
							</button>
						</>
					}
				>
					<div className="flex flex-col gap-4 p-4 text-sm">
						<p className="text-th-text-primary">
							{confirming.channel === "alpha" &&
								`${confirming.version} is a prerelease and may be less stable than ${check?.latest_version ?? "the latest release"}. `}
							<CodeText
								text={`The cluster downloads ${updateCandidateName(confirming)} from GitHub, verifies it and replaces ${installed?.path ? `\`${installed.path}\`` : "its executable"}, then restarts.`}
							/>{" "}
							Nodes keep running and keep their version — afterwards they show
							as outdated, and Restart all outdated moves them over. To go back,
							install {displayVersion(running)} with the install script.
						</p>
						<div className="self-start">
							<ReleaseNotesLink candidate={confirming} title={false} />
						</div>
						{installingSince !== undefined && (
							<p className="text-th-text-secondary">
								Started {elapsed} ago
								{Date.now() - new Date(installingSince).getTime() >=
									SHOW_BUDGET_AFTER_MS &&
									` · up to ${UPDATE_BUDGET_MS / 60_000} min`}
							</p>
						)}
					</div>
				</Sheet>
			)}

			{sheetOpen && !confirming && (
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
									className={`${differs && !latestOffersUpdate ? PRIMARY_BUTTON : NEUTRAL_BUTTON} flex-1`}
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

						<ClusterUpdates
							running={running}
							state={updates}
							failure={failure}
							onUpdate={openConfirm}
							busy={restarting}
						/>

						{unreadable ? (
							<p className="text-th-text-secondary">
								{(installed.error ?? "It reported no version").replace(
									/\.$/,
									"",
								)}
								. The cluster can't restart until{" "}
								<span className="break-all font-mono">{installed.path}</span>{" "}
								runs.{" "}
								{offersInstall
									? "Update it below, or reinstall it on the server."
									: "Reinstall it on the server."}
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
							</>
						)}
						{refusal && (
							<p role="alert" className="text-th-error">
								{refusal}
							</p>
						)}
					</div>
				</Sheet>
			)}
		</>
	);
}
