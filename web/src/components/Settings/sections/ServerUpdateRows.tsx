import {
	type ServerUpdateCheck,
	UPDATE_BUDGET_MS,
	type UpdateCandidate,
	updateCandidateName,
	updateFailureKind,
} from "@pockode/shared";
import {
	AlertTriangle,
	ArrowUpCircle,
	CheckCircle2,
	CircleDashed,
	ExternalLink,
	Info,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ServerUpdateRun } from "../../../lib/wsStore";
import { formatRelativeDate } from "../../../utils/relativeTime";
import {
	busyTextButtonClass,
	formatMinutes,
	primaryButtonClass,
	secondaryButtonClass,
	textButtonClass,
	useNow,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";
import CliRow, { CliRowNotice, type CliRowState } from "./CliRow";

/** `server.update_check`, as the section last heard it. */
export interface UpdateCheckRead {
	info?: ServerUpdateCheck;
	/** Why the last request failed — the request, not the release check. */
	error?: string;
	/** When the last answer — not a failure — landed (epoch ms); 0 before any has. */
	answeredAt: number;
}

export interface UpdateRowsInput {
	check: UpdateCheckRead;
	/** This page's install, from the store. */
	run: ServerUpdateRun | null;
	/** The executable the install replaces, once `server.version` has said. */
	path: string | undefined;
	/**
	 * A check this page forced is out: the status row shows it, and `check`
	 * is still what the card knew when it was pressed.
	 */
	checking: boolean;
	/**
	 * `check` is the answer to a check this page forced — the one answer the
	 * status region reads out, so an ordinary visit stays silent.
	 */
	checkAnswered: boolean;
	onUpdate: (candidate: UpdateCandidate) => void;
	/** Forces a check: **Check**, **Check again**, **Try again**. */
	onCheckAgain: () => void;
	onDismiss: () => void;
}

export interface UpdateRows {
	/** The rows under the version row (docs/self-update-ui.md, "web"). */
	rows: ReactNode;
	/** A latest row carries Update: it, not Restart, is the card's primary. */
	latestUpdateOffered: boolean;
	/** Any row carries Update — what an unreadable file is told to use. */
	updateOffered: boolean;
	/**
	 * For the card's status region: an install of this page's, or its
	 * failure; else a check this page forced, and its answer.
	 */
	announcement: string;
}

const BUDGET_MINUTES = UPDATE_BUDGET_MS / 60_000;

/** From when "Installing" names the budget: long enough to wonder. */
const NAME_BUDGET_AFTER_MS = 2 * 60_000;

const PROXY_HINT =
	"If this server reaches the internet through a proxy, start pockode with `HTTPS_PROXY` set.";

/**
 * What the card shows under its version row: one status row, or one row per
 * candidate (docs/self-update-ui.md, "web: Settings → Pockode").
 */
export function updateRows({
	check,
	run,
	path,
	checking,
	checkAnswered,
	onUpdate,
	onCheckAgain,
	onDismiss,
}: UpdateRowsInput): UpdateRows {
	const none = { latestUpdateOffered: false, updateOffered: false };
	const { info } = check;

	if (run?.phase === "installing") {
		return {
			...none,
			rows: <InstallingRow run={run} />,
			announcement: `Installing ${run.candidate.version}...`,
		};
	}

	// What a forced check found, said once it lands. A request that failed
	// says nothing here: its notice is an alert of its own.
	const answered = (words: string) =>
		checking
			? CHECKING_ANNOUNCEMENT
			: checkAnswered && !check.error
				? words
				: "";
	const status = (state: CliRowState, words = ""): UpdateRows => ({
		...none,
		rows: <StatusRow {...state} checking={checking} />,
		announcement: answered(words),
	});
	const checkButton = (label: string, name?: string) => (
		<CheckButton
			label={label}
			name={name}
			busy={checking}
			onClick={onCheckAgain}
		/>
	);

	const checkedAgo = info?.checked_at
		? `Checked ${formatRelativeDate(info.checked_at)}`
		: undefined;
	// A re-check that failed leaves the last answer standing, and says so.
	const stale = check.error
		? `Couldn't check again: ${check.error}`
		: undefined;

	if (!info) {
		if (!check.error) return status({ title: undefined });
		// The request to this server failed, not GitHub: no proxy advice.
		return status({
			...couldNotCheck(checkButton("Try again")),
			notice: { error: `Couldn't ask the server: ${check.error}` },
		});
	}

	if (info.installing) {
		const { started_at, version } = info.installing;
		// The install this page lost the answer to, still running.
		const ours = run?.phase === "lost" && version === run.candidate.version;
		return status(
			{
				icon: <Spinner srText={null} />,
				title: "Another update is running",
				subtitle: started_at ? (
					<ElapsedSince since={Date.parse(started_at)} />
				) : (
					"On this machine"
				),
				notice: {
					body: ours
						? `The update to ${version} this page started is still running; the page lost its answer. This card checks again when you come back to it.`
						: "Another Pockode on this machine — a cluster node, or this server from another device — is installing a new version. This card checks again when you come back to it.",
					error: stale,
				},
			},
			"Another update is running",
		);
	}

	if (info.check_error?.reason === "dev_build") {
		return status({
			icon: <Info className="h-4 w-4 text-th-text-muted" />,
			title: "No updates for a development build",
			subtitle: "Built from source",
		});
	}

	if (info.candidates.length === 0) {
		if (info.check_error) {
			return status(
				{
					...couldNotCheck(checkButton("Try again")),
					subtitle: checkedAgo,
					notice: {
						body: withCode(
							`${sentence(info.check_error.message)} ${PROXY_HINT}`,
						),
						error: stale,
					},
				},
				"Couldn't check for updates",
			);
		}
		// Neither an answer nor a failure: this process has not checked, as it
		// only does when asked to. Pressed, and still so: the check outlived
		// the server's wait for it.
		if (!checkedAgo) {
			return status(
				{
					icon: <CircleDashed className="h-4 w-4 text-th-text-muted" />,
					title: "Updates not checked",
					subtitle: "Checked only on request",
					// "Check" alone, so the title still fits beside it at 320px.
					action: checkButton("Check", "Check for updates"),
					notice: check.error
						? { error: `Couldn't check: ${check.error}` }
						: checkAnswered
							? {
									body: "The check is still running on the server. Press Check in a moment to see its answer.",
								}
							: undefined,
				},
				"Still checking on the server",
			);
		}
		return status(
			{
				icon: <CheckCircle2 className="h-4 w-4 text-th-text-muted" />,
				title: "Up to date",
				subtitle: checkedAgo,
				action: checkButton("Check again"),
				notice: { error: stale },
			},
			"Up to date",
		);
	}

	const failure = run && run.phase !== "restart_refused" ? run : null;
	let latestUpdateOffered = false;
	let updateOffered = false;
	let announcement = "";

	const rows = info.candidates.map((candidate, index) => {
		const installable = !info.cannot_install && !candidate.unavailable;
		const ended =
			failure?.candidate.version === candidate.version ? failure : null;
		// A lost answer is news only once a check made after it still offers the
		// release: until then it may well have been installed.
		const copy =
			ended?.phase === "failed" &&
			updateFailureKind(ended.reason).kind === "show"
				? failureCopy(ended, info, path)
				: ended?.phase === "lost" && check.answeredAt > ended.endedAt
					? lostCopy(ended, path)
					: null;
		if (copy?.title) announcement = copy.title;

		// Nor is it a release to offer again: the install may still be running,
		// or be on disk already.
		const unsettled =
			ended?.phase === "lost" && check.answeredAt <= ended.endedAt;
		const update = installable && !copy && !unsettled;
		if (update) {
			updateOffered = true;
			if (candidate.channel === "latest") latestUpdateOffered = true;
		}
		const primary = update && candidate.channel === "latest";

		let action: ReactNode;
		if (update) {
			action = (
				<button
					type="button"
					onClick={() => onUpdate(candidate)}
					aria-label={`Update to ${updateCandidateName(candidate)}`}
					className={primary ? primaryButtonClass : secondaryButtonClass}
				>
					Update
				</button>
			);
		} else if (copy?.retry && installable) {
			action = (
				<button
					type="button"
					onClick={() => onUpdate(candidate)}
					aria-label={`Try again to update to ${updateCandidateName(candidate)}`}
					className={secondaryButtonClass}
				>
					Try again
				</button>
			);
		}

		const last = index === info.candidates.length - 1;
		let notice: ReactNode;
		if (copy) {
			notice = (
				<CliRowNotice
					body={<Titled title={copy.title}>{copy.body}</Titled>}
					details={copy.details}
					detailsKey={candidate.version}
					footer={
						<button
							type="button"
							onClick={onDismiss}
							className={textButtonClass}
						>
							Dismiss
						</button>
					}
				/>
			);
		} else if (candidate.unavailable) {
			notice = <CliRowNotice body={unavailableBody(candidate, info.asset)} />;
		}

		return (
			<div key={candidate.channel}>
				<CandidateRow
					candidate={candidate}
					// A failure is how a release fetched from the atom feed, which
					// lists no files, turns out to have none for here.
					unavailable={
						candidate.unavailable?.reason ??
						(ended?.phase === "failed" &&
						(ended.reason === "no_asset" || ended.reason === "no_checksums")
							? ended.reason
							: undefined)
					}
					platform={info.platform}
					failed={!!copy}
					action={action}
					notice={notice}
				/>
				{last && info.cannot_install && (
					<CliRowNotice
						body={cannotInstallBody(info.cannot_install)}
						error={stale}
					/>
				)}
				{last && !info.cannot_install && stale && (
					<CliRowNotice error={stale} />
				)}
			</div>
		);
	});

	if (!announcement) {
		const names = info.candidates.map(updateCandidateName).join(", ");
		announcement = answered(
			`${info.candidates.length === 1 ? "Update" : "Updates"} available: ${names}`,
		);
	}

	return { rows, latestUpdateOffered, updateOffered, announcement };
}

const CHECKING_ANNOUNCEMENT = "Checking for updates...";

function couldNotCheck(tryAgain: ReactNode): CliRowState {
	return {
		icon: <Info className="h-4 w-4 text-th-text-muted" />,
		title: "Couldn't check for updates",
		action: tryAgain,
	};
}

/**
 * Forces a check. Busy, it stays where it is, as wide as it was, and keeps
 * focus — `disabled` would drop focus to the page mid-check.
 */
function CheckButton({
	label,
	name,
	busy,
	onClick,
}: {
	label: string;
	/** The accessible name, when the visible label is cut short. */
	name?: string;
	busy: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={busy ? undefined : onClick}
			aria-label={name}
			aria-disabled={busy || undefined}
			className={busy ? busyTextButtonClass : textButtonClass}
		>
			{label}
		</button>
	);
}

/**
 * While a forced check is out, the row keeps what was known, says it is
 * checking, and holds back the last attempt's error until the new one ends.
 */
function StatusRow({
	notice,
	checking,
	...row
}: CliRowState & { checking: boolean }) {
	const busy: Partial<CliRowState> = checking
		? { icon: <Spinner srText={null} />, subtitle: "Checking..." }
		: {};
	const shown = checking && notice ? { ...notice, error: undefined } : notice;
	return (
		<CliRow
			{...row}
			{...busy}
			loadingLabel="Checking for a newer Pockode"
			notice={shown && <CliRowNotice {...shown} />}
		/>
	);
}

/**
 * A release: its title and subtitle are one link to its notes, so the hit area
 * is the row's height rather than a line of small text.
 */
function CandidateRow({
	candidate,
	unavailable,
	platform,
	failed,
	action,
	notice,
}: {
	candidate: UpdateCandidate;
	unavailable: "no_asset" | "no_checksums" | undefined;
	platform: string;
	failed: boolean;
	action: ReactNode;
	notice: ReactNode;
}) {
	const label = updateCandidateName(candidate);
	const latest = candidate.channel === "latest";
	const subtitle =
		unavailable === "no_asset"
			? `No build for ${platform}`
			: unavailable === "no_checksums"
				? "Can't be verified"
				: null;

	return (
		<div>
			<div className="flex min-h-11 items-center gap-3">
				<a
					href={candidate.notes_url}
					target="_blank"
					rel="noreferrer"
					aria-label={`Release notes for ${label}, opens GitHub`}
					className="group flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent"
				>
					<span className="flex h-9 w-4 shrink-0" aria-hidden="true">
						<span className="flex h-5 w-4 items-center justify-center">
							{failed ? (
								<AlertTriangle className="h-4 w-4 text-th-error" />
							) : (
								<ArrowUpCircle
									className={`h-4 w-4 ${latest ? "text-th-accent" : "text-th-text-muted"}`}
								/>
							)}
						</span>
					</span>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm leading-5 text-th-text-primary">
							{label}
						</span>
						<span className="flex items-center gap-1 text-xs leading-4 text-th-text-muted">
							<span className="truncate group-hover:underline">
								{subtitle ?? "Release notes"}
							</span>
							<ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
						</span>
					</span>
				</a>
				{action && (
					<div className="flex shrink-0 items-center gap-2">{action}</div>
				)}
			</div>
			{notice}
		</div>
	);
}

/** This page's install, ticking; the server's budget is named from 2 minutes on. */
function InstallingRow({
	run,
}: {
	run: Extract<ServerUpdateRun, { phase: "installing" }>;
}) {
	return (
		<CliRow
			icon={<Spinner srText={null} />}
			title={`Installing ${run.candidate.version}...`}
			subtitle={<ElapsedSince since={run.startedAt} budget />}
		/>
	);
}

/**
 * "Started 0:12 ago", ticking — and with `budget`, the server's limit beside
 * it once that is worth saying. Its own component, so only it redraws.
 */
export function ElapsedSince({
	since,
	budget,
}: {
	since: number;
	budget?: boolean;
}) {
	const now = useNow();
	// Whole seconds: formatMinutes rounds up, as a countdown should.
	const elapsed = Math.floor(Math.max(0, now - since) / 1000) * 1000;
	const long = budget && elapsed >= NAME_BUDGET_AFTER_MS;
	return (
		<>
			Started {formatMinutes(elapsed)} ago
			{long && ` · up to ${BUDGET_MINUTES} min`}
		</>
	);
}

/** A notice's own title above its body. */
function Titled({ title, children }: { title?: string; children: ReactNode }) {
	return (
		<>
			{title && <span className="block text-th-text-primary">{title}</span>}
			{children}
		</>
	);
}

function cannotInstallBody(
	cannot: NonNullable<ServerUpdateCheck["cannot_install"]>,
): ReactNode {
	if (cannot.reason === "not_writable") {
		return (
			<>
				<span className="block text-th-text-primary">
					Can't update from here: no write access to{" "}
					<span className="break-all font-mono">{cannot.dir}</span>
				</span>
				{withCode(cannot.hint ?? cannot.message)}
			</>
		);
	}
	if (cannot.reason === "container") {
		return (
			<Titled title="Can't update from here: running in a container">
				A file replaced inside a container is gone the next time it is
				recreated. Update by pulling a newer image.
			</Titled>
		);
	}
	return (
		<Titled title="Can't update from here">
			{withCode(sentence(cannot.message))}
		</Titled>
	);
}

function unavailableBody(candidate: UpdateCandidate, asset: string): ReactNode {
	const release = `Release ${candidate.version}`;
	if (candidate.unavailable?.reason === "no_checksums") {
		return (
			<>
				{release} has no <code className="font-mono">checksums.txt</code>, so
				its download can't be verified and Pockode won't install it.
			</>
		);
	}
	return (
		<>
			{release} has no <code className="font-mono">{asset}</code>, so it can't
			be installed here. Build it from source.
		</>
	);
}

interface FailureCopy {
	title?: string;
	body: ReactNode;
	details?: string;
	/** Pressing again could go differently. */
	retry: boolean;
}

function failureCopy(
	run: Extract<ServerUpdateRun, { phase: "failed" }>,
	info: ServerUpdateCheck,
	path: string | undefined,
): FailureCopy {
	const kind = updateFailureKind(run.reason);
	return {
		...failureWords(run, info, path),
		retry: kind.kind === "show" && kind.retry,
	};
}

/** docs/self-update-ui.md, "Failed". */
function failureWords(
	run: Extract<ServerUpdateRun, { phase: "failed" }>,
	info: ServerUpdateCheck,
	path: string | undefined,
): Omit<FailureCopy, "retry"> {
	const { version } = run.candidate;
	const unchanged = <Unchanged path={path} />;
	const details = run.message;
	const windows = info.platform.startsWith("windows/");

	switch (run.reason) {
		case "checksum_mismatch":
			return {
				title: "The download didn't match its checksum",
				body: (
					<>
						<code className="font-mono">{info.asset}</code> from {version}{" "}
						doesn't match the release's{" "}
						<code className="font-mono">checksums.txt</code>, so it was
						discarded. Try again; if it keeps failing, the download is being
						changed on the way — a proxy or a filter in between. {unchanged}
					</>
				),
				details,
			};
		case "download_failed":
			return {
				title: `Couldn't download ${version}`,
				body: (
					<>
						{withCode(`${sentence(run.message)} ${PROXY_HINT}`)} {unchanged}
					</>
				),
			};
		case "not_runnable":
			return {
				title: `${version} didn't run on this machine`,
				body: (
					<>
						The downloaded file failed{" "}
						<code className="font-mono">--version</code>:{" "}
						{run.message.replace(/\.$/, "")}. It was discarded. {unchanged}
					</>
				),
			};
		case "replace_failed":
			return {
				title: `Couldn't replace ${windows ? "pockode.exe" : "pockode"}`,
				body: (
					<>
						{sentence(run.message)}
						{windows &&
							" On Windows this is usually antivirus still scanning the new file; try again in a minute."}{" "}
						{unchanged}
					</>
				),
			};
		case "restore_failed":
			return {
				title: "Couldn't replace pockode.exe, and the old one wasn't put back",
				body: (
					<>
						{sentence(run.message)} This Pockode keeps running, but it can't
						restart or start again until{" "}
						<span className="break-all font-mono">
							{path ?? "the executable"}
						</span>{" "}
						is back.
					</>
				),
			};
		case "timeout":
			return {
				title: "The update took too long",
				body: (
					<>
						Pockode stopped after {BUDGET_MINUTES} minutes. Try again on a
						better connection, or run the install script on the server.{" "}
						{unchanged}
					</>
				),
				details,
			};
		case "no_asset":
		case "no_checksums":
			return {
				title: "Update failed",
				body: (
					<>
						{unavailableBody(
							{
								...run.candidate,
								unavailable: { reason: run.reason, message: run.message },
							},
							info.asset,
						)}{" "}
						{unchanged}
					</>
				),
				details,
			};
		default:
			return {
				title: "Update failed",
				body: (
					<>
						{sentence(run.message)} {unchanged}
					</>
				),
			};
	}
}

function lostCopy(
	run: Extract<ServerUpdateRun, { phase: "lost" }>,
	path: string | undefined,
): FailureCopy {
	return {
		body: (
			<>
				{run.cause === "connection"
					? "The connection was lost during the update"
					: "No answer came for the update"}
				; it didn't finish. <Unchanged path={path} />
			</>
		),
		retry: true,
	};
}

function Unchanged({ path }: { path: string | undefined }) {
	if (!path) return <>The installed Pockode is unchanged.</>;
	return (
		<>
			<span className="break-all font-mono">{path}</span> is unchanged.
		</>
	);
}

/** The server's fragments ("download x: 404") as a sentence of the copy. */
function sentence(message: string): string {
	const trimmed = message.trim();
	const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** Each `backtick` span of the server's text in mono, without its backticks. */
function withCode(text: string): ReactNode {
	return text.split("`").map((part, i) =>
		i % 2 === 1 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: the split is the text's own order
			<code key={i} className="font-mono">
				{part}
			</code>
		) : (
			part
		),
	);
}
