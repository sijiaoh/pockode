import {
	ConfirmDialog,
	RESTART_NOT_BACK_MS,
	useSecondsUntil,
} from "@pockode/shared";
import { AlertTriangle, ArrowUpCircle, CheckCircle2, Info } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerVersion } from "../../../lib/rpc";
import { APP_VERSION } from "../../../lib/version";
import { useWSStore, wsActions } from "../../../lib/wsStore";
import { errorMessage } from "../../../utils/errorMessage";
import {
	formatMinutes,
	primaryButtonClass,
	secondaryButtonClass,
	useNow,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";
import CliRow, { CliRowNotice, type CliRowState } from "./CliRow";

/** A development build reports this, on both sides of the wire. */
const DEV_VERSION = "dev";

interface VersionRead {
	/** The last answer that arrived; kept while a re-read is out or failed. */
	info?: ServerVersion;
	/** Why the last request failed — the request, not the installed file. */
	error?: string;
	/** The read whose answer or failure this is; 0 before any has landed. */
	landed: number;
}

/**
 * `server.version`, read on demand and never on a timer: each read runs the
 * executable on the server. Only the newest read's answer is kept, so one that
 * overtakes an older one is not undone by it.
 */
function useServerVersion() {
	const [state, setState] = useState<VersionRead>({ landed: 0 });
	const latest = useRef(0);

	/** Starts a read; returns its number, which `landed` reaches when it is in. */
	const read = useCallback((): number => {
		const mine = ++latest.current;
		wsActions.serverVersion().then(
			(info) => {
				if (mine === latest.current) setState({ info, landed: mine });
			},
			(err: unknown) => {
				if (mine === latest.current) {
					setState((s) => ({ ...s, error: errorMessage(err), landed: mine }));
				}
			},
		);
		return mine;
	}, []);

	return { ...state, read };
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
	const { info, error, landed, read } = useServerVersion();
	// The read the open dialog waits for; null while it is closed.
	const [dialogRead, setDialogRead] = useState<number | null>(null);

	// Read on mount, on every reconnect — a same-version restart included —
	// and when the user comes back, typically from the terminal they just ran
	// the installer in.
	useEffect(() => {
		if (!isConnected) return;
		read();

		const onVisible = () => {
			if (document.visibilityState === "visible") read();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [isConnected, read]);

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
		setDialogRead(read());
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

	return (
		<div
			ref={cardRef}
			tabIndex={-1}
			className="rounded-lg border border-th-border bg-th-bg-secondary px-4 py-3 focus:outline-none"
		>
			{/* Always mounted, so a change to it is heard: a region born with its
			    text is often not read at all. Only the restart is announced; the
			    version row would otherwise be read out on every visit, and a
			    refusal is the dialog's alert. */}
			<output className="sr-only">
				{restartRequestedAt === null
					? ""
					: notBack
						? NOT_BACK_TITLE
						: RESTARTING_TITLE}
			</output>
			{restartRequestedAt !== null ? (
				<RestartingRow since={restartRequestedAt} notBack={notBack} />
			) : (
				<VersionRow info={info} error={error} onRestart={openRestart} />
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
		</div>
	);
}

const RESTARTING_TITLE = "Restarting Pockode...";
const NOT_BACK_TITLE = "Pockode hasn't come back";

const sameIcon = <CheckCircle2 className="h-4 w-4 text-th-text-muted" />;
const differIcon = <ArrowUpCircle className="h-4 w-4 text-th-accent" />;
const devIcon = <Info className="h-4 w-4 text-th-text-muted" />;
const unreadableIcon = <AlertTriangle className="h-4 w-4 text-th-error" />;

function VersionRow({
	info,
	error,
	onRestart,
}: {
	info: ServerVersion | undefined;
	error: string | undefined;
	onRestart: () => void;
}) {
	const { notice, ...row } = versionState(info, error, onRestart);
	return (
		<CliRow
			{...row}
			loadingLabel="Reading the installed Pockode version"
			notice={<CliRowNotice {...notice} />}
		/>
	);
}

function restartButton(primary: boolean, onRestart: () => void) {
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
function versionState(
	info: ServerVersion | undefined,
	error: string | undefined,
	onRestart: () => void,
): CliRowState {
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
						Reinstall it on the server.
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
		action: restartButton(true, onRestart),
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
	const now = useNow();
	const elapsed = Math.max(0, now - since);

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
			// Whole seconds: formatMinutes rounds up, as a countdown should.
			subtitle={`Started ${formatMinutes(Math.floor(elapsed / 1000) * 1000)} ago`}
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
