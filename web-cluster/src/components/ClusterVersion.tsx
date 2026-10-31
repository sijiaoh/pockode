import { type InstalledVersion, Sheet, Spinner } from "@pockode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWSStore } from "../lib/wsStore";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";

const DEV_VERSION = "dev";

/** What the last read of the installed executable came back with. */
type InstalledRead =
	| { kind: "read"; installed: InstalledVersion }
	/** The request itself failed: not an answer about the install. */
	| { kind: "failed"; message: string };

function errorMessage(err: unknown, fallback: string) {
	return err instanceof Error ? err.message : fallback;
}

/**
 * The installed version when the cluster runs something other than it, else
 * null. Equality only — a downgrade is as much a reason to restart — and never
 * for a development build, which would always differ (docs/restart-ui.md).
 */
function differingVersion(
	running: string,
	installed: InstalledVersion | null,
): string | null {
	const version = installed?.version;
	return running !== DEV_VERSION && version !== undefined && version !== running
		? version
		: null;
}

function displayVersion(version: string) {
	return version === DEV_VERSION ? "development build" : version;
}

/**
 * The header's version button and the "Pockode cluster" sheet it opens, which
 * is both the information and the restart's confirmation (docs/restart-ui.md,
 * "web-cluster: the header"; cluster-ui.md rules 2 and 3).
 */
export function ClusterVersion({ running }: { running: string }) {
	const { status, actions } = useWSStore();
	const [read, setRead] = useState<InstalledRead | null>(null);
	const [sheetOpen, setSheetOpen] = useState(false);
	// The sheet speaks about now, not about when the header was drawn: until a
	// read started at or after its opening lands, the installed row is a
	// skeleton and Restart is disabled.
	const [readingSince, setReadingSince] = useState<number | null>(null);
	const [restarting, setRestarting] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const lastReadRef = useRef(0);

	// Each read runs the executable on the host, so it happens only on the
	// occasions the design names, never on the node poll; only the latest one
	// started is allowed to land.
	const readInstalled = useCallback(async () => {
		const id = ++lastReadRef.current;
		let next: InstalledRead;
		try {
			const result = await actions.serverVersion();
			next = { kind: "read", installed: result.installed };
		} catch (err) {
			// A read the dropped socket took down with it is the reconnect's to
			// report; the next connect reads again.
			if (useWSStore.getState().status !== "connected") return;
			next = {
				kind: "failed",
				message: errorMessage(err, "Unknown error"),
			};
		}
		if (id !== lastReadRef.current) return;
		setRead(next);
		setReadingSince((since) => (since !== null && id >= since ? null : since));
	}, [actions]);

	useEffect(() => {
		if (status === "connected") void readInstalled();
	}, [status, readInstalled]);

	// The user typically comes back from a terminal where they just ran the
	// installer.
	useEffect(() => {
		const onVisibilityChange = () => {
			if (!document.hidden && useWSStore.getState().status === "connected") {
				void readInstalled();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [readInstalled]);

	const openSheet = () => {
		setRefusal(null);
		setReadingSince(lastReadRef.current + 1);
		setSheetOpen(true);
		void readInstalled();
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

	const installed = read?.kind === "read" ? read.installed : null;
	const newVersion = differingVersion(running, installed);
	const differs = newVersion !== null;
	const reading = readingSince !== null;
	const unreadable =
		!reading && installed !== null && installed.version === undefined;

	const runningLabel = running === DEV_VERSION ? "dev" : `v${running}`;
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
				{differs && (
					<svg
						className="h-4 w-4 shrink-0 text-th-accent"
						fill="none"
						stroke="currentColor"
						strokeWidth={2}
						strokeLinecap="round"
						strokeLinejoin="round"
						viewBox="0 0 24 24"
						aria-hidden="true"
						data-testid="version-differs"
					>
						<circle cx="12" cy="12" r="10" />
						<path d="m16 12-4-4-4 4" />
						<path d="M12 16V8" />
					</svg>
				)}
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
