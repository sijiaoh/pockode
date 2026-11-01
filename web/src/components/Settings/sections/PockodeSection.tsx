import {
	ConfirmDialog,
	RESTART_NOT_BACK_MS,
	type ServerUpdateCheck,
	type UpdateCandidate,
	updateCandidateName,
	useSecondsUntil,
} from "@pockode/shared";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerVersion } from "../../../lib/rpc";
import { APP_VERSION } from "../../../lib/version";
import { useWSStore, wsActions } from "../../../lib/wsStore";
import { errorMessage } from "../../../utils/errorMessage";
import {
	primaryButtonClass,
	secondaryButtonClass,
	textButtonClass,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";
import CliRow, { CliRowNotice, type CliRowState } from "./CliRow";
import { ElapsedSince, updateRows } from "./ServerUpdateRows";

/** A development build reports this, on both sides of the wire. */
const DEV_VERSION = "dev";

interface Read<T> {
	/** The last answer that arrived; kept while a re-read is out or failed. */
	info?: T;
	/** Why the last request failed — the request, not what it asks about. */
	error?: string;
	/** The read whose answer or failure this is; 0 before any has landed. */
	landed: number;
	/**
	 * When the last answer — not a failure — landed (epoch ms); 0 before any
	 * has. A failure keeps the old `info`, which says nothing about the time
	 * it failed at.
	 */
	answeredAt: number;
}

/**
 * A server read made on demand and never on a timer: `server.version` runs
 * the executable on the server, and `server.update_check` may ask GitHub. Only
 * the newest read's answer is kept, so one that overtakes an older one is not
 * undone by it. `request` has to be stable.
 */
function useNewestRead<T, A>(request: (arg: A) => Promise<T>) {
	const [state, setState] = useState<Read<T>>({ landed: 0, answeredAt: 0 });
	const latest = useRef(0);

	/** Starts a read; returns its number, which `landed` reaches when it is in. */
	const read = useCallback(
		(arg: A): number => {
			const mine = ++latest.current;
			request(arg).then(
				(info) => {
					if (mine === latest.current) {
						setState({ info, landed: mine, answeredAt: Date.now() });
					}
				},
				(err: unknown) => {
					if (mine === latest.current) {
						setState((s) => ({
							...s,
							error: errorMessage(err),
							landed: mine,
						}));
					}
				},
			);
			return mine;
		},
		[request],
	);

	return { ...state, read };
}

const readVersion = (): Promise<ServerVersion> => wsActions.serverVersion();
/** `force` looks past the server's cache: **Check again** and **Try again**. */
const readUpdateCheck = (force: boolean): Promise<ServerUpdateCheck> =>
	wsActions.serverUpdateCheck(force ? { force } : {});

interface UpdateDialog {
	candidate: UpdateCandidate;
	/** The reads it waits for before it can be confirmed. */
	checkRead: number;
	versionRead: number;
	/** Whether the fresh check has been judged — once, as it lands. */
	judged: boolean;
}

/**
 * The server process itself: the version it runs, the version installed on
 * disk, and restarting into it (docs/restart-ui.md, "web: Settings →
 * Pockode"). The running version is this page's build — the store reloads the
 * page whenever `auth` reports any other.
 */
export default function PockodeSection() {
	const isConnected = useWSStore((s) => s.status === "connected");
	const restartRequestedAt = useWSStore((s) => s.restartRequestedAt);
	const run = useWSStore((s) => s.serverUpdate);
	const { info, error, landed, read } = useNewestRead(readVersion);
	const check = useNewestRead(readUpdateCheck);
	const readCheck = check.read;
	// The read the open dialog waits for; null while it is closed.
	const [dialogRead, setDialogRead] = useState<number | null>(null);
	const [updateDialog, setUpdateDialog] = useState<UpdateDialog | null>(null);

	// Read on mount, on every reconnect — a same-version restart included —
	// and when the user comes back, typically from the terminal they just ran
	// the installer in. The check is its own request, so a slow GitHub never
	// holds up the version row.
	useEffect(() => {
		if (!isConnected) return;
		read(undefined);
		readCheck(false);

		const onVisible = () => {
			if (document.visibilityState === "visible") {
				read(undefined);
				readCheck(false);
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [isConnected, read, readCheck]);

	// An install that ended changed what both reads say: the file, or whether
	// the release is still a candidate. Only an ending seen here: one already
	// in the store on mount is read by the mount's reads, and a lost one by
	// the reconnect's.
	const runEndedAt = run && run.phase !== "installing" ? run.endedAt : null;
	const seenEnding = useRef(runEndedAt);
	useEffect(() => {
		if (runEndedAt === seenEnding.current) return;
		seenEnding.current = runEndedAt;
		if (runEndedAt === null) return;
		if (useWSStore.getState().status !== "connected") return;
		read(undefined);
		readCheck(false);
	}, [runEndedAt, read, readCheck]);

	// A failure is this page's memory of a release; a check made after it
	// that no longer offers that release ends it (docs/self-update-ui.md,
	// "Failed").
	const { answeredAt, info: checkInfo } = check;
	useEffect(() => {
		const ended = useWSStore.getState().serverUpdate;
		if (ended?.phase !== "failed" && ended?.phase !== "lost") return;
		if (!checkInfo || answeredAt <= ended.endedAt) return;
		const offered = checkInfo.candidates.some(
			(c) => c.version === ended.candidate.version,
		);
		if (!offered) wsActions.dismissServerUpdate();
	}, [answeredAt, checkInfo]);

	// The dialog's read is judged once, as it lands: a later read — the tab
	// coming back into view — failing while the user reads the dialog, or while
	// its request is out, is the row's to show, not a reason to take the
	// dialog away.
	const [dialogChecked, setDialogChecked] = useState(false);
	const dialogFresh = dialogRead !== null && landed >= dialogRead;
	if (dialogFresh && !dialogChecked) {
		setDialogChecked(true);
		// Nothing it could confirm: the row says why.
		if (error || info?.installed.error) setDialogRead(null);
	}

	const openRestart = () => {
		setDialogChecked(false);
		setDialogRead(read(undefined));
	};

	// The update dialog's check is judged the same way: a candidate gone from
	// it — installed from elsewhere, superseded, no longer installable — closes
	// the dialog into what the card shows now. A check that failed to answer
	// leaves the decision to the server, which checks again itself. A version
	// read that failed closes it as it closes Restart's: the turn count the
	// dialog states would be the old one.
	const updateFresh =
		updateDialog !== null &&
		check.landed >= updateDialog.checkRead &&
		landed >= updateDialog.versionRead;
	const dialogCandidate = updateDialog
		? (check.info?.candidates.find(
				(c) => c.version === updateDialog.candidate.version,
			) ?? null)
		: null;
	// The press that opened the dialog was on a row a closing dialog may have
	// taken away; the card is still there.
	const [refocusCard, setRefocusCard] = useState(false);
	if (updateDialog && updateFresh && !updateDialog.judged) {
		const offered =
			dialogCandidate !== null &&
			!dialogCandidate.unavailable &&
			!check.info?.cannot_install &&
			!check.info?.installing;
		const close = !!error || (!check.error && !offered);
		setRefocusCard(close);
		setUpdateDialog(close ? null : { ...updateDialog, judged: true });
	}
	useEffect(() => {
		if (!refocusCard) return;
		setRefocusCard(false);
		cardRef.current?.focus();
	}, [refocusCard]);

	const openUpdate = (candidate: UpdateCandidate) => {
		setUpdateDialog({
			candidate,
			checkRead: readCheck(false),
			versionRead: read(undefined),
			judged: false,
		});
	};

	// The card outlives the row that held the Restart button, so focus has
	// somewhere to go when the dialog closes into Restarting.
	const cardRef = useRef<HTMLDivElement>(null);
	const confirmRestart = async () => {
		await wsActions.restartServer();
		setDialogRead(null);
		cardRef.current?.focus();
	};

	const notBackIn = useSecondsUntil(
		restartRequestedAt === null
			? null
			: restartRequestedAt + RESTART_NOT_BACK_MS,
	);
	const notBack = restartRequestedAt !== null && notBackIn === 0;

	// Dismiss takes its own button away.
	const dismiss = () => {
		wsActions.dismissServerUpdate();
		cardRef.current?.focus();
	};

	const confirmUpdate = () => {
		const candidate = dialogCandidate ?? updateDialog?.candidate;
		setUpdateDialog(null);
		if (!candidate) return;
		// The dialog closes at once: a download can take a minute, and the row
		// is where a minute of progress belongs.
		void wsActions.updateServer(candidate);
		cardRef.current?.focus();
	};

	const updates = updateRows({
		check,
		run,
		path: info?.installed.path,
		onUpdate: openUpdate,
		onCheckAgain: () => readCheck(true),
		onDismiss: dismiss,
	});
	const installing = run?.phase === "installing";
	const restartRefused =
		run?.phase === "restart_refused"
			? `${run.candidate.version} was installed, but Pockode didn't restart: ${run.message}`
			: undefined;

	return (
		<div
			ref={cardRef}
			tabIndex={-1}
			className="rounded-lg border border-th-border bg-th-bg-secondary px-4 py-3 focus:outline-none"
		>
			{/* Always mounted, so a change to it is heard: a region born with its
			    text is often not read at all. Only the restart and an install are
			    announced; the rows would otherwise be read out on every visit,
			    and a refusal is an alert of its own — the dialog's, or the
			    version row's after an install. */}
			<output className="sr-only">
				{restartRequestedAt === null
					? updates.announcement
					: notBack
						? NOT_BACK_TITLE
						: RESTARTING_TITLE}
			</output>
			{restartRequestedAt !== null ? (
				<RestartingRow since={restartRequestedAt} notBack={notBack} />
			) : (
				<>
					<VersionRow
						info={info}
						error={error}
						// A restart now would end the install.
						onRestart={installing ? undefined : openRestart}
						restartPrimary={!updates.latestUpdateOffered}
						updateOffered={updates.updateOffered}
						restartRefused={restartRefused}
						onDismiss={dismiss}
					/>
					{updates.rows}
				</>
			)}

			{dialogRead !== null && (
				<ConfirmDialog
					title="Restart Pockode?"
					message={restartMessage(info)}
					confirmLabel="Restart"
					cancelLabel="Cancel"
					variant={info && info.running_turns > 0 ? "danger" : "default"}
					confirmDisabled={!dialogFresh}
					onConfirm={confirmRestart}
					onCancel={() => setDialogRead(null)}
				/>
			)}

			{updateDialog !== null && (
				<ConfirmDialog
					title={`Update Pockode to ${updateDialog.candidate.version}?`}
					message={updateMessage(
						dialogCandidate ?? updateDialog.candidate,
						check.info?.latest_version,
						info,
					)}
					confirmLabel="Update and restart"
					cancelLabel="Cancel"
					variant={info && info.running_turns > 0 ? "danger" : "default"}
					confirmDisabled={!updateFresh}
					onConfirm={confirmUpdate}
					onCancel={() => setUpdateDialog(null)}
				/>
			)}
		</div>
	);
}

const RESTARTING_TITLE = "Restarting Pockode...";
const NOT_BACK_TITLE = "Pockode hasn't come back";

const sameIcon = <CheckCircle2 className="h-4 w-4 text-th-text-muted" />;
const differIcon = <ArrowUpCircle className="h-4 w-4 text-th-accent" />;
const devIcon = <Info className="h-4 w-4 text-th-text-muted" />;
const unreadableIcon = <AlertTriangle className="h-4 w-4 text-th-error" />;

interface VersionRowProps {
	info: ServerVersion | undefined;
	error: string | undefined;
	/** Absent while Restart is withheld. */
	onRestart: (() => void) | undefined;
	/** Restart may be primary: no latest Update is on the card. */
	restartPrimary: boolean;
	/** A candidate row offers Update, which also fixes an unreadable file. */
	updateOffered: boolean;
}

function VersionRow({
	restartRefused,
	onDismiss,
	...props
}: VersionRowProps & {
	/** An install that went through, followed by a refused restart. */
	restartRefused: string | undefined;
	onDismiss: () => void;
}) {
	const { notice, ...row } = versionState(props);
	return (
		<CliRow
			{...row}
			loadingLabel="Reading the installed Pockode version"
			notice={
				<CliRowNotice
					{...notice}
					error={
						[restartRefused, notice?.error].filter(Boolean).join(" ") ||
						undefined
					}
					footer={
						restartRefused && (
							<button
								type="button"
								onClick={onDismiss}
								className={textButtonClass}
							>
								Dismiss
							</button>
						)
					}
				/>
			}
		/>
	);
}

function restartButton(primary: boolean, onRestart: (() => void) | undefined) {
	if (!onRestart) return undefined;
	return (
		<button
			type="button"
			onClick={onRestart}
			className={primary ? primaryButtonClass : secondaryButtonClass}
		>
			Restart
		</button>
	);
}

/** The row's state per docs/restart-ui.md, "The row's states". */
function versionState({
	info,
	error,
	onRestart,
	restartPrimary,
	updateOffered,
}: VersionRowProps): CliRowState {
	const dev = APP_VERSION === DEV_VERSION;
	const title = dev ? "Development build" : `Version ${APP_VERSION}`;

	if (!info) {
		if (!error) return { title: undefined };
		// The request failed, so nothing is known about the file: Restart stays,
		// and its dialog asks again.
		return {
			icon: unreadableIcon,
			title,
			subtitle: "Couldn't read the installed version",
			action: restartButton(false, onRestart),
			notice: { error: `Couldn't ask the server: ${error}` },
		};
	}

	// A re-read that failed leaves the last answer standing, and says so.
	const stale = error
		? `Couldn't read the installed version again: ${error}`
		: undefined;
	const { installed } = info;

	if (installed.error !== undefined || installed.version === undefined) {
		return {
			icon: unreadableIcon,
			title,
			subtitle: "Couldn't read the installed version",
			wrap: true,
			notice: {
				body: (
					<>
						{installed.error?.replace(/\.$/, "")}. Pockode can't restart until{" "}
						<span className="break-all font-mono">{installed.path}</span> runs.
						{updateOffered
							? " Update it below, or reinstall it on the server."
							: " Reinstall it on the server."}
					</>
				),
				error: stale,
			},
		};
	}

	if (dev) {
		return {
			icon: devIcon,
			title,
			subtitle:
				installed.version === DEV_VERSION
					? "Installed: development build"
					: `Installed: ${installed.version}`,
			action: restartButton(false, onRestart),
			notice: { error: stale },
		};
	}

	if (installed.version === APP_VERSION) {
		return {
			icon: sameIcon,
			title,
			subtitle: "Installed version is the same",
			action: restartButton(false, onRestart),
			notice: { error: stale },
		};
	}

	return {
		icon: differIcon,
		title,
		subtitle: `${installed.version} installed`,
		action: restartButton(restartPrimary, onRestart),
		notice: { error: stale },
	};
}

/**
 * From the accepted restart until the next connection: the elapsed time, and
 * from a minute on, that it hasn't come back. Its own component, so only it
 * redraws every second.
 */
function RestartingRow({
	since,
	notBack,
}: {
	since: number;
	notBack: boolean;
}) {
	return (
		<CliRow
			icon={
				notBack ? (
					<AlertTriangle className="h-4 w-4 text-th-warning" />
				) : (
					<Spinner srText={null} />
				)
			}
			title={notBack ? NOT_BACK_TITLE : RESTARTING_TITLE}
			subtitle={<ElapsedSince since={since} />}
			wrap={notBack}
			notice={
				notBack && (
					<CliRowNotice body="The restart may have failed on the server. Its log, or the terminal it runs in, says why; start pockode there again if it isn't running. This page keeps trying to reconnect." />
				)
			}
		/>
	);
}

/**
 * The dialog's message, from the parts in docs/restart-ui.md, "Pressing
 * Restart". Without any answer yet — the card's own read failed — it claims
 * nothing about versions or turns until the dialog's read lands.
 */
function restartMessage(info: ServerVersion | undefined) {
	if (!info)
		return "Pockode restarts on the server. This page reconnects by itself.";

	const installed = info.installed.version;
	let what: string;
	if (APP_VERSION === DEV_VERSION || installed === undefined) {
		what = "Pockode restarts on the server with the same options.";
	} else if (installed === APP_VERSION) {
		what = "Pockode restarts on the server with the same version and options.";
	} else {
		what = `Pockode restarts on the server and comes back running ${installed} (now ${APP_VERSION}).`;
	}

	const turns = info.running_turns;
	let cost: string;
	if (turns === 0) {
		cost = "No AI turn is running; sessions are kept.";
	} else {
		const running =
			turns === 1
				? "1 AI turn is running and will be stopped"
				: `${turns} AI turns are running and will be stopped`;
		cost = `${running} — their sessions and history are kept, and you can continue them afterwards.`;
	}

	return `${what} ${cost} This page reconnects by itself.`;
}

/**
 * The update dialog's message, from the parts in docs/self-update-ui.md,
 * "Pressing Update". Without a version read it leaves out what it cannot say.
 */
function updateMessage(
	candidate: UpdateCandidate,
	latestVersion: string | undefined,
	info: ServerVersion | undefined,
): string {
	const parts: string[] = [];
	if (candidate.channel === "alpha") {
		parts.push(
			latestVersion
				? `${candidate.version} is a prerelease and may be less stable than ${latestVersion}.`
				: `${candidate.version} is a prerelease and may be less stable.`,
		);
	}
	const target = info?.installed.path ?? "the installed pockode";
	parts.push(
		`Pockode downloads ${updateCandidateName(candidate)} from GitHub, verifies it and replaces ${target}, then restarts.`,
	);
	if (info) {
		const turns = info.running_turns;
		parts.push(
			turns === 0
				? "No AI turn is running now; any running when it restarts are stopped — sessions are kept."
				: `${turns === 1 ? "1 AI turn is" : `${turns} AI turns are`} running now; any still running when it restarts are stopped — their sessions and history are kept.`,
		);
	}
	parts.push(
		"Other Pockode servers that run this file, cluster nodes included, keep the version they run until they restart.",
	);
	if (APP_VERSION !== DEV_VERSION) {
		parts.push(`To go back, install ${APP_VERSION} with the install script.`);
	}
	parts.push("This page reconnects by itself.");
	return parts.join(" ");
}
