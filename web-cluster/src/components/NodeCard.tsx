import { Sheet, Spinner } from "@pockode/shared";
import { useEffect, useState } from "react";
import { useElapsed } from "../hooks/useElapsed";
import {
	type InstalledVersionState,
	installedOf,
	isUnreadable,
	useFreshRead,
} from "../hooks/useInstalledVersion";
import {
	displayVersion,
	type NodeVersionKind,
	versionLabel,
} from "../lib/version";
import type { NodeStatus, NodeWithStatus } from "../types/node";
import { displayPath, splitTail } from "../utils/path";
import { formatUptime } from "../utils/time";
import {
	DANGER_BUTTON,
	MENU_ITEM,
	NEUTRAL_BUTTON,
	PRIMARY_BUTTON,
} from "./buttons";
import { InstalledArrow } from "./InstalledArrow";
import { RestartNodeSheet } from "./RestartNodeSheet";
import { StartNodeSheet } from "./StartNodeSheet";

/**
 * What the confirmation does after `node.restart` answered: close (restarting,
 * or the error went to the card), hand over to the older node's sheet, or stay
 * open with the refusal.
 */
export type RestartResult =
	| { kind: "closed" }
	| { kind: "older" }
	| { kind: "refused"; message: string };

interface Props {
	node: NodeWithStatus;
	/** Reported by the last action on this node; stays until dismissed. */
	error?: string;
	onDismissError: (id: string) => void;
	onEdit: (node: NodeWithStatus) => void;
	onDelete: (id: string, options?: { stopFirst?: boolean }) => Promise<void>;
	/** Resolves to whether the node actually started. */
	onStart: (id: string, password: string) => Promise<boolean>;
	onStop: (id: string) => Promise<unknown>;
	onCleanup: (id: string) => Promise<void>;
	/** The panel's one read of the cluster's installed version. */
	installedState: InstalledVersionState;
	/** Whether this node needs a restart into it; null when current or unknown. */
	versionKind: NodeVersionKind;
	/** The cluster cannot ask this node: its Restart is `onRestartOlder`. */
	older: boolean;
	/** Asks the cluster to restart the node; see `RestartResult`. */
	onRestart: (node: NodeWithStatus) => Promise<RestartResult>;
	/** Opens the older node's stop-and-start sheet, which the list holds. */
	onRestartOlder: (node: NodeWithStatus) => void;
}

/**
 * A dot for running and stopped, a full pill for stale.
 *
 * When almost every card is one of the two ordinary states, a pill on each of
 * them is noise that makes the one card needing attention harder to find. Stale
 * keeps the pill because it is the state worth interrupting for.
 */
function StatusMark({ status }: { status: NodeStatus }) {
	if (status === "stale") {
		return (
			<span className="inline-flex shrink-0 items-center rounded-full border border-th-warning/30 bg-th-warning/10 px-2 py-0.5 text-xs font-medium text-th-warning">
				Stale
			</span>
		);
	}

	const [dot, label] =
		status === "running"
			? ["bg-th-success", "Running"]
			: status === "restarting"
				? ["bg-th-warning", "Restarting"]
				: ["bg-th-text-muted", "Stopped"];
	return (
		<>
			<span
				className={`size-2 shrink-0 rounded-full ${dot}`}
				aria-hidden="true"
			/>
			<span className="sr-only">{label}</span>
		</>
	);
}

/**
 * The path, cut in the middle rather than at the end.
 *
 * The head repeats across every node on a machine and the tail is what tells
 * two projects apart, so plain `truncate` hides the only part worth reading.
 * The head shrinks and the tail is held back, which puts the cut where the
 * actual width demands instead of at a character count guessed here. Not
 * `direction: rtl`, which ellipsises the right end but reorders the leading
 * punctuation and renders `~/a/b` as nonsense.
 */
function NodePath({ path }: { path: string }) {
	const shown = displayPath(path);
	const { head, tail } = splitTail(shown);

	return (
		<p
			className="mt-1 flex font-mono text-xs text-th-text-secondary"
			title={shown}
		>
			<span className="min-w-0 truncate">{head}</span>
			{tail && <span className="max-w-[60%] shrink-0 truncate">{tail}</span>}
		</p>
	);
}

type MenuView = "menu" | "stop" | "delete";

export function NodeCard({
	node,
	error,
	onDismissError,
	onEdit,
	onDelete,
	onStart,
	onStop,
	onCleanup,
	installedState,
	versionKind,
	older,
	onRestart,
	onRestartOlder,
}: Props) {
	const [menuView, setMenuView] = useState<MenuView | null>(null);
	// The restart confirmation, and where it was opened from: the menu's has
	// Back to the menu, the card's Cancel.
	const [restartFrom, setRestartFrom] = useState<"card" | "menu" | null>(null);
	// The version the confirmation speaks of, as of its opening: the reply's
	// refresh brings a restarting status, which carries none.
	const [restartingFrom, setRestartingFrom] = useState<string | undefined>();
	const [restartRefusal, setRestartRefusal] = useState<string | null>(null);
	const fresh = useFreshRead(installedState);
	const [startSheetOpen, setStartSheetOpen] = useState(false);
	// Whether `error` is this sheet's to show. The card's error belongs to
	// whatever acted on the node last, which is not necessarily a start: a
	// cleanup that was refused leaves one behind, and the card still offers
	// Start. Repeating it in the sheet unprompted reads as "your start failed"
	// before a start has been attempted.
	const [startFailed, setStartFailed] = useState(false);
	const [password, setPassword] = useState("");
	// Two delete kinds rather than one: the running-node sheet draws both a
	// "Stop and delete" and a "Delete anyway", and a single flag would spin the
	// one the user did not press.
	const [actionLoading, setActionLoading] = useState<
		"start" | "stop" | "cleanup" | "delete" | "stopDelete" | "restart" | null
	>(null);

	const status = node.status.status;
	const restarting = status === "restarting";
	const elapsed = useElapsed(
		restarting ? node.status.restart_requested_at : undefined,
	);
	const installed = installedOf(installedState);

	// A restart asked from elsewhere — another device, the batch — takes the
	// menu and the confirmation away under the user: everything in them would
	// race the restart, or ask for one already under way.
	useEffect(() => {
		if (restarting && actionLoading === null) {
			setMenuView(null);
			setRestartFrom(null);
		}
	}, [restarting, actionLoading]);

	const uptime = node.status.started_at
		? formatUptime(node.status.started_at, Date.now())
		: null;
	// Joined rather than laid out as spans with a gap: the separator has to
	// disappear along with the part it separates, and a node reporting neither
	// (a status arriving without its runtime info) must not leave an empty line
	// behind the card's spacing.
	const meta =
		status === "running"
			? [
					node.status.port ? `Port ${node.status.port}` : null,
					uptime ? `up ${uptime}` : null,
				]
					.filter(Boolean)
					.join(" · ")
			: "";
	// A phone on mobile data cannot reach localhost, so remote is the default
	// target whenever the cluster has one; local stays as a second link.
	const openUrl = node.status.remote_url ?? node.status.local_url;
	const showLocalLink = Boolean(
		node.status.remote_url && node.status.local_url,
	);

	const closeMenu = () => setMenuView(null);

	const openRestart = (from: "card" | "menu") => {
		setMenuView(null);
		if (older) {
			onRestartOlder(node);
			return;
		}
		setRestartRefusal(null);
		setRestartingFrom(node.status.version);
		fresh.begin();
		setRestartFrom(from);
	};

	const closeRestart = () => {
		if (actionLoading !== null) return;
		setRestartFrom(null);
	};

	const confirmRestart = () => {
		setRestartRefusal(null);
		void run("restart", async () => {
			const result = await onRestart(node);
			if (result.kind === "refused") {
				setRestartRefusal(result.message);
				return;
			}
			// In one go, so the two sheets are never up together.
			setRestartFrom(null);
			if (result.kind === "older") onRestartOlder(node);
		});
	};

	const run = async (
		kind: NonNullable<typeof actionLoading>,
		action: () => Promise<void>,
	) => {
		setActionLoading(kind);
		try {
			await action();
		} finally {
			setActionLoading(null);
		}
	};

	const handleEdit = () => {
		closeMenu();
		onEdit(node);
	};

	const handleStop = async () => {
		await run("stop", async () => {
			await onStop(node.id);
		});
		closeMenu();
	};

	const handleDelete = async (stopFirst: boolean) => {
		await run(stopFirst ? "stopDelete" : "delete", () =>
			onDelete(node.id, { stopFirst }),
		);
		closeMenu();
	};

	// Opening clears the verdict as well as raising the sheet: the same button
	// reopens it after a start that failed, and the reason it shows belongs to
	// that attempt, not to the one being made now.
	const openStartSheet = () => {
		setStartFailed(false);
		setStartSheetOpen(true);
	};

	// The sheet is kept open when the start fails. Closing it would throw away a
	// password the user typed by hand on a phone, for the one outcome where they
	// still need it.
	const confirmStart = () => {
		const trimmed = password.trim();
		if (!trimmed) return;
		setStartFailed(false);
		void run("start", async () => {
			const started = await onStart(node.id, trimmed);
			if (started) {
				setStartSheetOpen(false);
				setPassword("");
			} else {
				setStartFailed(true);
			}
		});
	};

	return (
		<>
			<div className="rounded-lg border border-th-border bg-th-bg-secondary p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<StatusMark status={status} />
							<h3 className="min-w-0 truncate font-medium text-th-text-primary">
								{node.name}
							</h3>
						</div>
						<NodePath path={node.path} />
					</div>
					<button
						type="button"
						onClick={() => setMenuView("menu")}
						disabled={restarting}
						className="flex size-11 shrink-0 items-center justify-center rounded-lg text-th-text-secondary hover:bg-th-overlay-hover hover:text-th-text-primary disabled:opacity-50"
						aria-label={`More options for ${node.name}`}
					>
						<svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
							<circle cx="12" cy="6" r="1.5" />
							<circle cx="12" cy="12" r="1.5" />
							<circle cx="12" cy="18" r="1.5" />
						</svg>
					</button>
				</div>

				{meta && <p className="mt-2 text-xs text-th-text-muted">{meta}</p>}

				{restarting && (
					<p className="mt-2 flex items-center gap-1.5 text-xs text-th-text-muted">
						<Spinner size="h-3 w-3" srText={null} />
						Restarting...{elapsed && ` ${elapsed}`}
					</p>
				)}

				{versionKind !== null && installed?.version !== undefined && (
					<p className="mt-1 flex items-center gap-1.5 text-xs text-th-text-muted">
						<InstalledArrow />
						{versionKind === "older" || node.status.version === undefined
							? "Older version"
							: versionLabel(node.status.version)}{" "}
						· {displayVersion(installed.version)} installed
					</p>
				)}

				{status === "stale" && (
					<p className="mt-2 text-sm text-th-text-secondary">
						The server exited without cleaning up. Nothing is running.
					</p>
				)}

				{error && (
					<div
						className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-th-error/30 bg-th-error/10 px-3 py-2 text-sm text-th-error"
						role="alert"
					>
						<p className="min-w-0 break-words">{error}</p>
						<button
							type="button"
							onClick={() => onDismissError(node.id)}
							className="min-h-9 shrink-0 rounded px-2 text-xs hover:bg-th-overlay-hover pointer-coarse:min-h-11"
						>
							Dismiss
						</button>
					</div>
				)}

				<div className="mt-4 flex items-center gap-3">
					{status === "running" && !openUrl && (
						<p className="text-sm text-th-text-muted">
							Running, but it reported no address to open.
						</p>
					)}

					{status === "running" && openUrl && (
						<>
							<a
								href={openUrl}
								target="_blank"
								rel="noopener noreferrer"
								className={`${PRIMARY_BUTTON} flex-1`}
							>
								Open
							</a>
							{showLocalLink && (
								<a
									href={node.status.local_url}
									target="_blank"
									rel="noopener noreferrer"
									// `touch-target` overlays a 44px hit area on a link that is
									// only 36px of text: the secondary link sits one thumb-width
									// from Open and has to be as hard to miss as it is to hit.
									className="touch-target shrink-0 px-1 py-2 text-sm text-th-accent hover:underline"
								>
									Local ↗
								</a>
							)}
						</>
					)}

					{status === "running" && versionKind !== null && (
						<button
							type="button"
							onClick={() => openRestart("card")}
							disabled={actionLoading !== null}
							className={`${NEUTRAL_BUTTON} shrink-0`}
						>
							Restart
						</button>
					)}

					{/* Never Start while restarting: on Windows the node has no
					    server.json for a moment, and a Start then would put a second
					    server on the project. */}
					{restarting && (
						<button
							type="button"
							disabled
							className={`${PRIMARY_BUTTON} flex-1`}
						>
							<Spinner size="h-4 w-4" srText={null} />
							Restarting...
						</button>
					)}

					{(status === "stopped" || status === "stale") && (
						// No in-flight label here, unlike Clean up beside it: a start is
						// only ever driven from the sheet, which covers this card until
						// the start resolves. It stays disabled all the same, because
						// Clean up does run with nothing on top of it.
						<button
							type="button"
							onClick={openStartSheet}
							disabled={actionLoading !== null}
							className={`${PRIMARY_BUTTON} flex-1`}
						>
							Start
						</button>
					)}

					{status === "stale" && (
						// No confirmation: this deletes a file describing a process that
						// is already gone, so there is nothing to lose and nothing to
						// undo. The card settling on Stopped is the confirmation.
						<button
							type="button"
							onClick={() => run("cleanup", () => onCleanup(node.id))}
							disabled={actionLoading !== null}
							className={`${NEUTRAL_BUTTON} shrink-0`}
						>
							{actionLoading === "cleanup" && <Spinner size="h-4 w-4" />}
							{actionLoading === "cleanup" ? "Cleaning..." : "Clean up"}
						</button>
					)}
				</div>
			</div>

			{menuView === "menu" && (
				<Sheet title={node.name} onClose={closeMenu}>
					<div className="flex flex-col gap-2 p-4">
						{/* Withheld only when the installed file is known not to run:
						    the cluster would refuse, and the header's sheet says why. */}
						{status === "running" && !isUnreadable(installedState) && (
							<button
								type="button"
								onClick={() => openRestart("menu")}
								className={`${MENU_ITEM} text-th-text-primary`}
							>
								Restart
							</button>
						)}
						{status === "running" && (
							<button
								type="button"
								onClick={() => setMenuView("stop")}
								className={`${MENU_ITEM} text-th-text-primary`}
							>
								Stop
							</button>
						)}
						<button
							type="button"
							onClick={handleEdit}
							className={`${MENU_ITEM} text-th-text-primary`}
						>
							Edit
						</button>
						<button
							type="button"
							onClick={() => setMenuView("delete")}
							className={`${MENU_ITEM} text-th-error`}
						>
							Delete
						</button>
					</div>
				</Sheet>
			)}

			{/* The confirmations replace the menu's contents in the same sheet rather
			    than opening over it: nothing in this app stacks overlays, and a
			    question asked where the thumb already is beats one in the middle of
			    the screen. Back returns to the menu. */}
			{menuView === "stop" && (
				<Sheet
					title={`Stop ${node.name}?`}
					onClose={closeMenu}
					dismissible={actionLoading === null}
					footer={
						<>
							<button
								type="button"
								onClick={() => setMenuView("menu")}
								disabled={actionLoading !== null}
								className={`${NEUTRAL_BUTTON} flex-1`}
							>
								Back
							</button>
							<button
								type="button"
								onClick={handleStop}
								disabled={actionLoading !== null}
								className={`${PRIMARY_BUTTON} flex-1`}
							>
								{actionLoading === "stop" && <Spinner size="h-4 w-4" />}
								{actionLoading === "stop" ? "Stopping..." : "Stop"}
							</button>
						</>
					}
				>
					<p className="p-4 text-sm text-th-text-secondary">
						Stops the Pockode server for this project. Any running AI sessions
						end.
					</p>
				</Sheet>
			)}

			{menuView === "delete" && (
				<Sheet
					title={`Delete ${node.name}?`}
					onClose={closeMenu}
					dismissible={actionLoading === null}
					footer={
						<div className="flex w-full flex-col gap-2">
							{status === "running" && (
								<button
									type="button"
									onClick={() => handleDelete(true)}
									disabled={actionLoading !== null}
									className={PRIMARY_BUTTON}
								>
									{actionLoading === "stopDelete" && <Spinner size="h-4 w-4" />}
									{actionLoading === "stopDelete"
										? "Stopping..."
										: "Stop and delete"}
								</button>
							)}
							<button
								type="button"
								onClick={() => handleDelete(false)}
								disabled={actionLoading !== null}
								className={
									status === "running" ? NEUTRAL_BUTTON : DANGER_BUTTON
								}
							>
								{actionLoading === "delete" && <Spinner size="h-4 w-4" />}
								{actionLoading === "delete"
									? "Deleting..."
									: status === "running"
										? "Delete anyway"
										: "Delete"}
							</button>
							{/* Cancel, not Back: this one leaves the card alone entirely,
							    where the stop sheet's Back hands the menu back. */}
							<button
								type="button"
								onClick={closeMenu}
								disabled={actionLoading !== null}
								className={NEUTRAL_BUTTON}
							>
								Cancel
							</button>
						</div>
					}
				>
					<div className="flex flex-col gap-3 p-4 text-sm text-th-text-secondary">
						<p>
							Removes “{node.name}” from this cluster. The project directory and
							its files are not touched.
						</p>
						{status === "running" && (
							<p className="text-th-warning">
								This node is running. Deleting it will not stop the server, and
								you will no longer be able to stop it from here.
							</p>
						)}
					</div>
				</Sheet>
			)}

			{restartFrom !== null && (
				<RestartNodeSheet
					nodeName={node.name}
					running={restartingFrom}
					installed={installed}
					reading={fresh.reading}
					loading={actionLoading === "restart"}
					refusal={restartRefusal}
					cancelLabel={restartFrom === "menu" ? "Back" : "Cancel"}
					onCancel={() => {
						closeRestart();
						if (restartFrom === "menu") setMenuView("menu");
					}}
					onClose={closeRestart}
					onConfirm={confirmRestart}
				/>
			)}

			{startSheetOpen && (
				<StartNodeSheet
					nodeName={node.name}
					error={startFailed ? error : undefined}
					password={password}
					progress={actionLoading === "start" ? "starting" : null}
					onPasswordChange={setPassword}
					onConfirm={confirmStart}
					onCancel={() => {
						if (actionLoading !== null) return;
						setStartSheetOpen(false);
						setPassword("");
					}}
				/>
			)}
		</>
	);
}
