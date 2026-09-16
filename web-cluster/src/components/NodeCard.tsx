import { Sheet, Spinner } from "@pockode/shared";
import { useEffect, useId, useRef, useState } from "react";
import { generateNodeToken } from "../lib/nodeToken";
import type { NodeStatus, NodeWithStatus } from "../types/node";
import { displayPath, splitTail } from "../utils/path";
import { formatUptime } from "../utils/time";
import {
	DANGER_BUTTON,
	MENU_ITEM,
	NEUTRAL_BUTTON,
	PRIMARY_BUTTON,
} from "./buttons";

interface Props {
	node: NodeWithStatus;
	/** Reported by the last action on this node; stays until dismissed. */
	error?: string;
	onDismissError: (id: string) => void;
	onEdit: (node: NodeWithStatus) => void;
	onDelete: (id: string, options?: { stopFirst?: boolean }) => Promise<void>;
	/** Resolves to whether the node actually started. */
	onStart: (id: string, token: string) => Promise<boolean>;
	/**
	 * The token this session has already started a node with, if any. Present
	 * means Start needs no sheet: one tap, and the sheet is only reached
	 * deliberately through the overflow menu.
	 */
	savedToken?: string | null;
	onStop: (id: string) => Promise<void>;
	onCleanup: (id: string) => Promise<void>;
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

	return (
		<>
			<span
				className={`size-2 shrink-0 rounded-full ${
					status === "running" ? "bg-th-success" : "bg-th-text-muted"
				}`}
				aria-hidden="true"
			/>
			<span className="sr-only">
				{status === "running" ? "Running" : "Stopped"}
			</span>
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
	savedToken,
}: Props) {
	const [menuView, setMenuView] = useState<MenuView | null>(null);
	const [startSheetOpen, setStartSheetOpen] = useState(false);
	// Whether `error` is this sheet's to show. The card's error belongs to
	// whatever acted on the node last, which is not necessarily a start: a
	// cleanup that was refused leaves one behind, and the card still offers
	// Start. Repeating it in the sheet unprompted reads as "your start failed"
	// before a start has been attempted.
	const [startFailed, setStartFailed] = useState(false);
	const [token, setToken] = useState("");
	// Two delete kinds rather than one: the running-node sheet draws both a
	// "Stop and delete" and a "Delete anyway", and a single flag would spin the
	// one the user did not press. Start is split for the same reason — which
	// token a start is using is the difference, and it is the card, not a second
	// flag kept in step with this one, that has to say so.
	const [actionLoading, setActionLoading] = useState<
		"start" | "startSaved" | "stop" | "cleanup" | "delete" | "stopDelete" | null
	>(null);

	const status = node.status.status;
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

	const starting = actionLoading === "start" || actionLoading === "startSaved";
	// A start running on the remembered token says so where the rest of the
	// node's runtime facts go, so the one tap is not silent about which token it
	// used. A node being started is never running, so nothing is displaced.
	const metaLine =
		actionLoading === "startSaved" ? "Using the saved node token" : meta;

	const closeMenu = () => setMenuView(null);

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
		await run("stop", () => onStop(node.id));
		closeMenu();
	};

	const handleDelete = async (stopFirst: boolean) => {
		await run(stopFirst ? "stopDelete" : "delete", () =>
			onDelete(node.id, { stopFirst }),
		);
		closeMenu();
	};

	// The sheet is kept open when the start fails. Closing it would throw away a
	// token the user typed by hand on a phone, for the one outcome where they
	// still need it.
	const start = (value: string, kind: "start" | "startSaved") => {
		setStartFailed(false);
		return run(kind, async () => {
			const started = await onStart(node.id, value);
			if (started) {
				setStartSheetOpen(false);
				setToken("");
			} else {
				setStartFailed(true);
			}
		});
	};

	// Always through here, so a sheet never opens still carrying the verdict of
	// the start before it.
	const openStartSheet = () => {
		setStartFailed(false);
		setStartSheetOpen(true);
	};

	const handleStartPressed = () => {
		if (savedToken) {
			void start(savedToken, "startSaved");
			return;
		}
		openStartSheet();
	};

	const confirmStart = () => {
		const trimmed = token.trim();
		if (!trimmed) return;
		void start(trimmed, "start");
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
						className="flex size-11 shrink-0 items-center justify-center rounded-lg text-th-text-secondary hover:bg-th-overlay-hover hover:text-th-text-primary"
						aria-label={`More options for ${node.name}`}
					>
						<svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
							<circle cx="12" cy="6" r="1.5" />
							<circle cx="12" cy="12" r="1.5" />
							<circle cx="12" cy="18" r="1.5" />
						</svg>
					</button>
				</div>

				{metaLine && (
					<p className="mt-2 text-xs text-th-text-muted">{metaLine}</p>
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

					{status !== "running" && (
						<button
							type="button"
							onClick={handleStartPressed}
							disabled={actionLoading !== null}
							className={`${PRIMARY_BUTTON} flex-1`}
						>
							{starting && <Spinner size="h-4 w-4" />}
							{starting ? "Starting..." : "Start"}
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
						{status === "running" && (
							<button
								type="button"
								onClick={() => setMenuView("stop")}
								className={`${MENU_ITEM} text-th-text-primary`}
							>
								Stop
							</button>
						)}
						{status !== "running" && savedToken && (
							<button
								type="button"
								onClick={() => {
									closeMenu();
									openStartSheet();
								}}
								className={`${MENU_ITEM} text-th-text-primary`}
							>
								Start with a different token…
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

			{startSheetOpen && (
				<StartNodeSheet
					nodeName={node.name}
					error={startFailed ? error : undefined}
					token={token}
					loading={actionLoading === "start"}
					onTokenChange={setToken}
					onConfirm={confirmStart}
					onCancel={() => {
						if (actionLoading !== null) return;
						setStartSheetOpen(false);
						setToken("");
					}}
				/>
			)}
		</>
	);
}

interface StartNodeSheetProps {
	nodeName: string;
	/**
	 * Why the start attempted from this sheet failed — the card behind is
	 * hiding it. Only a start's own failure: the card's error outlives whatever
	 * raised it, and a cleanup's would read here as a start that had already
	 * gone wrong.
	 */
	error?: string;
	token: string;
	loading: boolean;
	onTokenChange: (token: string) => void;
	onConfirm: () => void;
	onCancel: () => void;
}

function StartNodeSheet({
	nodeName,
	error,
	token,
	loading,
	onTokenChange,
	onConfirm,
	onCancel,
}: StartNodeSheetProps) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);

	// Not `autoFocus`: the sheet takes focus itself in an effect, which runs
	// after this subtree is mounted and would undo it.
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleGenerate = () => {
		onTokenChange(generateNodeToken());
		setCopyState("idle");
		inputRef.current?.focus();
	};

	// A generated token exists nowhere else, so a copy that fails silently hands
	// the user a secret they can neither read (the field is masked) nor retrieve.
	// `navigator.clipboard` is absent outside a secure context, which is exactly
	// where a self-hosted cluster is often reached, so this path is real.
	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(token);
			setCopyState("copied");
		} catch {
			setCopyState("failed");
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!token.trim() || loading) return;
		onConfirm();
	};

	return (
		<Sheet
			title={`Start ${nodeName}`}
			onClose={onCancel}
			dismissible={!loading}
			onSubmit={handleSubmit}
			footer={
				<>
					<button
						type="button"
						onClick={onCancel}
						disabled={loading}
						className={`${NEUTRAL_BUTTON} flex-1`}
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={loading || !token.trim()}
						className={`${PRIMARY_BUTTON} flex-1`}
					>
						{loading && <Spinner size="h-4 w-4" />}
						{loading ? "Starting..." : "Start"}
					</button>
				</>
			}
		>
			<div className="flex flex-col gap-4 p-4">
				{/* A failed start keeps this sheet open, which puts the card — and the
				    reason — behind it. Repeated here rather than moved, because the
				    card is where the error belongs once this sheet is gone. No
				    `role="alert"`: the card's copy is already a live region, and the
				    same sentence announced twice is worse than once. */}
				{error && (
					<p className="rounded-lg border border-th-error/30 bg-th-error/10 px-3 py-2 text-sm text-th-error">
						{error}
					</p>
				)}
				<p className="text-sm text-th-text-secondary">
					Used by the Pockode server started in this project. It is not the
					cluster token. Remembered until this tab is reloaded.
				</p>
				<div>
					<label
						htmlFor={inputId}
						className="mb-1 block text-sm text-th-text-secondary"
					>
						Auth token
					</label>
					<input
						ref={inputRef}
						id={inputId}
						type="password"
						value={token}
						onChange={(e) => {
							onTokenChange(e.target.value);
							setCopyState("idle");
						}}
						disabled={loading}
						className="min-h-[44px] w-full rounded-lg border border-th-border bg-th-bg-primary px-3 py-2 font-mono text-sm text-th-text-primary placeholder:text-th-text-muted focus:border-th-border-focus focus:outline-none disabled:opacity-50"
					/>
					<div className="mt-2 flex items-center gap-2">
						<button
							type="button"
							onClick={handleGenerate}
							disabled={loading}
							className={NEUTRAL_BUTTON}
						>
							Generate
						</button>
						<button
							type="button"
							onClick={handleCopy}
							disabled={loading || !token}
							className={NEUTRAL_BUTTON}
						>
							Copy
						</button>
						{copyState !== "idle" && (
							<output
								className={`text-xs ${
									copyState === "copied"
										? "text-th-text-muted"
										: "text-th-error"
								}`}
							>
								{copyState === "copied"
									? "Copied"
									: "Could not copy. Take it down from here:"}
							</output>
						)}
					</div>
					{/* Revealed only when the copy failed, and only because there is no
					    other way out: "select the field and copy it yourself" is not
					    advice a masked input can take — browsers block copying from a
					    password field — and this token is needed again to sign in to the
					    server it starts. Asking for it is what unmasks it. */}
					{copyState === "failed" && (
						<code className="mt-2 block break-all rounded-lg border border-th-border bg-th-bg-primary p-2 font-mono text-xs text-th-text-primary">
							{token}
						</code>
					)}
				</div>
			</div>
		</Sheet>
	);
}
