import {
	AlertTriangle,
	ArrowUpCircle,
	CheckCircle2,
	CircleSlash,
	Info,
} from "lucide-react";
import type { ReactNode } from "react";
import { AGENT_CLI_INFO, getAgentLabel } from "../../../lib/agentType";
import type {
	CliInstallRefusedReason,
	CliUpdate,
	CliUpdateCheck,
} from "../../../types/cliUpdate";
import type { AgentType } from "../../../types/settings";
import { InstallLink } from "../../CliLogin/cliAuthText";
import {
	cardTextButtonClass,
	formatMinutes,
	primaryButtonClass,
	secondaryButtonClass,
	useNow,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";
import CliRow, { CliRowNotice, type CliRowState as RowState } from "./CliRow";

interface Props {
	agent: AgentType;
	check: CliUpdateCheck | undefined;
	/** Why the last check request failed. */
	checkError: string | undefined;
	/**
	 * A check is out. Where the row waits on a check rather than holding the
	 * last one, an error from before it is no longer the answer.
	 */
	checking: boolean;
	/** The version sign-in status read, for the row while no check has answered. */
	statusVersion: string | undefined;
	/** The CLI is not on the server, as the check — or before it answers, sign-in status — reads it. */
	notInstalled: boolean;
	/** The update record to draw, already chosen by `shownUpdate`. */
	update: CliUpdate | null;
	/** Whether this page started `update`. */
	startedHere: boolean;
	/** Why the update could not be followed. */
	followError: string | undefined;
	/** A sign-in to the CLI is running: the update would replace its binary. */
	signingIn: boolean;
	/** A start, install or dismiss request is out: every button waits. */
	busy: boolean;
	/** The request out is an install: its button shows the spinner. */
	installPending: boolean;
	/** A refused start, install or dismiss, in the server's words. */
	error: string | null;
	/** Why the server refused the last install, when it said. */
	installRefusal: CliInstallRefusedReason | null;
	onUpdate: () => void;
	onInstall: () => void;
	onDismiss: (updateId: string) => void;
}

/**
 * Which of the CLI's update records the row draws, if any
 * (docs/cli-update-ui.md, "Which update record the row shows"): a running one
 * always; a success only when this page watched it end; a failure until it is
 * dismissed — unless the CLI has changed since the update left it, both
 * versions being known. "Left it" is the version read after the update, not
 * before: a failure that moved the CLI part of the way is still news. A failed
 * install is news only while the CLI is still missing: once it is there,
 * however it got there, the failure is about a state that is gone.
 */
export function shownUpdate(
	update: CliUpdate | undefined,
	check: CliUpdateCheck | undefined,
	seenEnding: boolean,
): CliUpdate | null {
	if (!update) return null;
	switch (update.phase) {
		case "running":
			return update;
		case "succeeded":
			return seenEnding ? update : null;
		default: {
			if (update.kind === "install") {
				// Another install, which the subscription has not delivered yet,
				// has replaced this one.
				if (check?.state === "installing") {
					return check.update_id === update.id ? update : null;
				}
				return !check || check.state === "not_installed" ? update : null;
			}
			const left = update.to_version ?? update.from_version;
			if (check?.version && left && check.version !== left) return null;
			return update;
		}
	}
}

/**
 * The card's installation row: the installed version, whether a newer one is
 * out, and the update or install — running, just done, or failed. The version
 * is always the check's, never an update record's: the record is what happened
 * then.
 */
export default function CliInstallRow(props: Props) {
	const { agent, check, update } = props;

	let state: RowState;
	// Only the update's phases are announced, not "Checking" and "Up to date"
	// for both cards on every refresh.
	let announcement = "";
	if (update?.phase === "running") {
		state = runningState(props, update);
		announcement = state.title ?? "";
	} else if (update?.phase === "succeeded") {
		if (update.kind === "install") {
			state = installedState(props, update);
			announcement = state.title ?? "";
		} else {
			announcement = updatedText(agent, update);
			state = updatedState(agent, update);
		}
	} else if (update) {
		const copy =
			update.kind === "install"
				? describeInstallFailure(agent, update)
				: describeUpdateFailure(agent, update);
		announcement = copy.title;
		state = failedState(props, update, copy);
		// The subtitle is the check's: without one, say why there is none.
		if (props.checkError && !props.checking && !check) {
			state.notice = {
				...state.notice,
				body: (
					<>
						{state.notice?.body} Couldn't check {getAgentLabel(agent)} again:{" "}
						{props.checkError}
					</>
				),
			};
		}
	} else {
		state = checkState(props);
		if (check?.state === "updating" || check?.state === "installing") {
			announcement = state.title ?? "";
		}
		// Otherwise a failure the subscription never delivered would go
		// unmentioned.
		if (props.followError) {
			const follow = `Couldn't follow ${getAgentLabel(agent)}'s updates: ${props.followError}. Reload the page to follow them.`;
			const body = state.notice?.body;
			state.notice = {
				...state.notice,
				body: body ? (
					<>
						{body} {follow}
					</>
				) : (
					follow
				),
			};
		}
	}

	// npm is the install's one requirement, and the guide is the way without it.
	// A failure's footer offers the guide itself (`failedState`), beside Dismiss.
	if (props.installRefusal === "npm_not_found" && !state.notice?.footer) {
		state.notice = {
			...state.notice,
			footer: <InstallLink agent={agent} variant="text" />,
		};
	}

	const { notice, ...row } = state;
	return (
		<>
			{/* One live region for every phase, so each is heard once: a region
			    mounted with its text already in it is often not read at all. */}
			<output className="sr-only">{announcement}</output>
			<CliRow
				{...row}
				loadingLabel={`Checking ${getAgentLabel(agent)} version`}
				notice={<CliRowNotice {...notice} error={props.error} />}
			/>
		</>
	);
}

const mutedInfo = <Info className="h-4 w-4 text-th-text-muted" />;
const succeededIcon = <CheckCircle2 className="h-4 w-4 text-th-success" />;
const failedIcon = <AlertTriangle className="h-4 w-4 text-th-error" />;
const spinnerIcon = <Spinner srText={null} />;

function versionTitle(version: string | undefined): string {
	return version ? `Version ${version}` : "Version unknown";
}

function InstallButton({
	label,
	busy,
	pending,
	onInstall,
}: {
	label: string;
	busy: boolean;
	/** Its own request is out, not just any. */
	pending: boolean;
	onInstall: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onInstall}
			disabled={busy}
			aria-busy={pending}
			className={primaryButtonClass}
		>
			{pending && <Spinner variant="current" srText={null} />}
			{label}
		</button>
	);
}

function checkState({
	agent,
	check,
	checkError,
	statusVersion,
	notInstalled,
	signingIn,
	busy,
	installPending,
	onUpdate,
	onInstall,
}: Props): RowState {
	if (check?.state === "installing") {
		// As "updating" below: one this page did not start.
		return {
			icon: spinnerIcon,
			title: installingText(agent),
			subtitle: "Started earlier.",
		};
	}

	if (notInstalled) {
		// Short enough to stay whole beside Install on a 320px phone; the
		// dialog says the rest.
		return {
			icon: <CircleSlash className="h-4 w-4 text-th-text-muted" />,
			title: "Not installed",
			subtitle: "Installs with npm",
			action: (
				<InstallButton
					label="Install"
					busy={busy}
					pending={installPending}
					onInstall={onInstall}
				/>
			),
		};
	}

	const version = check?.version ?? statusVersion;

	// A check that could not be made is never drawn as "Up to date".
	if (checkError) {
		return {
			icon: mutedInfo,
			title: versionTitle(version),
			subtitle: "Couldn't check for updates",
			notice: { body: checkError },
		};
	}

	if (!check) {
		// Nothing read yet: the skeleton, not a guess.
		if (!version) return { title: undefined };
		return {
			title: versionTitle(version),
			subtitle: "Checking for updates…",
		};
	}

	switch (check.state) {
		case "up_to_date":
			return {
				icon: <CheckCircle2 className="h-4 w-4 text-th-text-muted" />,
				title: versionTitle(check.version),
				subtitle: "Up to date",
			};
		case "update_available": {
			// Short enough to stay whole beside Update on a 320px phone.
			const latest = check.latest_version ?? "A newer version";
			const available = signingIn
				? `${latest} · update after sign-in`
				: check.channel && check.channel !== "latest"
					? `${latest} on ${check.channel}`
					: `${latest} available`;
			return {
				icon: <ArrowUpCircle className="h-4 w-4 text-th-accent" />,
				title: versionTitle(check.version),
				subtitle: available,
				action: signingIn ? undefined : (
					<button
						type="button"
						onClick={onUpdate}
						disabled={busy}
						className={secondaryButtonClass}
					>
						Update
					</button>
				),
			};
		}
		case "not_yet_available":
			// The server cannot tell a lagging install method from an update that
			// went to another install, so neither is asserted.
			return {
				icon: mutedInfo,
				title: versionTitle(check.version),
				subtitle: `${check.latest_version ?? "A newer version"} is out · not reachable yet`,
				notice: {
					body: `The last update didn't reach it: the way ${getAgentLabel(agent)} is installed may not have it yet, or the update went to another install on this machine.`,
				},
			};
		case "updating":
			// The check saw an update the subscription has not delivered: not one
			// this page started, which would have come back in the start's reply.
			return {
				icon: spinnerIcon,
				title: updatingText(agent),
				subtitle: "Started earlier.",
			};
		default:
			// unavailable, and any state this build does not know. Without the
			// installed version there is nothing to update from: a CLI that cannot
			// print its version is not one to trust with replacing itself.
			if (!check.version) {
				return {
					icon: failedIcon,
					title: "Couldn't read the version",
					subtitle: "Version unknown",
					notice: { body: check.error },
				};
			}
			return {
				icon: mutedInfo,
				title: versionTitle(check.version),
				subtitle: "Couldn't check for updates",
				notice: { body: check.error },
			};
	}
}

function runningState(
	{ agent, startedHere, followError }: Props,
	update: CliUpdate,
): RowState {
	const install = update.kind === "install";
	return {
		icon: spinnerIcon,
		title: install
			? installingText(agent, update.target_version)
			: updatingText(agent),
		subtitle: startedHere ? (
			<Elapsed startedAt={update.started_at} slow={install} />
		) : (
			"Started earlier."
		),
		// Otherwise "Updating…" would stay up after the update ended. Refresh
		// reads the check but does not subscribe again; a new page does.
		notice: followError
			? {
					body: `Couldn't follow this ${update.kind}: ${followError}. Reload the page to follow it.`,
				}
			: undefined,
	};
}

// An npm install that has run this long is still within the server's
// 10-minute budget (docs/code/cli-update.md), but no longer looks it.
const SLOW_SECONDS = 120;

/**
 * Its own component, so only the elapsed time redraws every second. `slow`:
 * says how long it may take once it has run a while.
 */
function Elapsed({ startedAt, slow }: { startedAt: string; slow?: boolean }) {
	const now = useNow();
	const seconds = elapsedSeconds(startedAt, now);
	const elapsed = `Started ${formatMinutes(seconds * 1000)} ago`;
	return slow && seconds >= SLOW_SECONDS
		? `${elapsed} · up to 10 min`
		: elapsed;
}

function updatingText(agent: AgentType): string {
	return `Updating ${getAgentLabel(agent)}…`;
}

/** `version`: the release the install is getting, when the server read it. */
function installingText(agent: AgentType, version?: string): string {
	return version
		? `Installing ${getAgentLabel(agent)} ${version}…`
		: `Installing ${getAgentLabel(agent)}…`;
}

/** Whole seconds since `startedAt`, rounded down: "0:00" at the start. */
function elapsedSeconds(startedAt: string, now: number): number {
	return Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
}

function updatedText(agent: AgentType, update: CliUpdate): string {
	const { from_version: from, to_version: to } = update;
	if (from && to && from === to) {
		return `${getAgentLabel(agent)} was already up to date (${to})`;
	}
	if (from && to) return `Updated from ${from} to ${to}`;
	if (to) return `Updated to ${to}`;
	return `Updated ${getAgentLabel(agent)}`;
}

function updatedState(agent: AgentType, update: CliUpdate): RowState {
	const { from_version: from, to_version: to } = update;
	if (from && to && from === to) {
		return {
			icon: succeededIcon,
			title: "Already up to date",
			subtitle: versionTitle(to),
		};
	}
	return {
		icon: succeededIcon,
		title: to ? `Updated to ${to}` : `Updated ${getAgentLabel(agent)}`,
		subtitle: from && to ? `from ${from}` : undefined,
	};
}

/**
 * An install this page watched end: the version it left, then what the check
 * read afterwards says — which waits for that check, the one before it having
 * found nothing.
 */
function installedState(
	{ agent, check, checkError, checking }: Props,
	update: CliUpdate,
): RowState {
	const label = getAgentLabel(agent);
	const read =
		check && check.state !== "not_installed" && check.state !== "installing";
	const title = update.to_version
		? `Installed ${label} ${update.to_version}`
		: `Installed ${label}`;
	// Otherwise "Checking for updates…" would stay up for good.
	if (!read && checkError && !checking) {
		return {
			icon: succeededIcon,
			title,
			subtitle: "Couldn't check for updates",
			notice: { body: checkError },
		};
	}
	let subtitle = "Checking for updates…";
	if (read) {
		subtitle = versionTitle(check.version);
		if (check.state === "up_to_date") subtitle += " · Up to date";
		else if (check.state === "update_available" && check.latest_version) {
			subtitle += ` · ${check.latest_version} available`;
		}
	}
	return { icon: succeededIcon, title, subtitle };
}

interface FailureCopy {
	title: string;
	/** What to do. Enough on its own, without opening the details. */
	body: ReactNode;
	retry: boolean;
	/** The CLI's install page, for the way npm did not take. */
	installLink?: boolean;
	/** Install instead of Try again: the CLI the update needs is gone. */
	offerInstall?: boolean;
	details?: string;
	detailsOpen?: boolean;
}

// npm ends every failure with where it wrote its log, after the line saying
// why, and that log is on the server, where the terminal answer points anyway.
const NPM_LOG_TRAILER = /complete log of this run can be found in/i;

// npm closes a permissions failure with a paragraph of advice ("If you believe
// this might be a permissions issue, … try running the command again as
// root/Administrator"), after the paragraph saying why. Everything from it on
// is dropped, and so are the bare "npm error" lines between paragraphs.
const NPM_ADVICE = /^npm (error|ERR!) If you believe\b/;
const NPM_BLANK = /^npm (error|ERR!)$/;

// Claude ends a failure with advice after the reason — "Possible causes:",
// "Try:" and bulleted lines — none of which says what went wrong.
const ADVICE = /^[•*-]\s|:$/;

/** Where the CLI says why: its last line of output that is not boilerplate. */
function lastLine(text: string): string | undefined {
	const lines = text.split("\n").map((line) => line.trim());
	const advice = lines.findIndex((line) => NPM_ADVICE.test(line));
	return (advice === -1 ? lines : lines.slice(0, advice))
		.filter(
			(line) =>
				line &&
				!NPM_BLANK.test(line) &&
				!NPM_LOG_TRAILER.test(line) &&
				!ADVICE.test(line),
		)
		.at(-1);
}

/**
 * Every way an update ends badly, as one layout (docs/cli-update-ui.md,
 * "Failed").
 */
function describeUpdateFailure(
	agent: AgentType,
	update: CliUpdate,
): FailureCopy {
	const label = getAgentLabel(agent);
	const command = AGENT_CLI_INFO[agent].command;
	const updateCommand = (
		<code className="font-mono">{`${command} update`}</code>
	);
	const detail = update.failure?.detail;

	switch (update.failure?.reason) {
		case "command_failed": {
			// The CLI says why at the end of its output.
			const why = detail ? lastLine(detail) : undefined;
			return {
				title: `${label} couldn't update itself`,
				body: (
					<>
						{why && <>{why} </>}
						Fix it on the server, or run {updateCommand} there.
					</>
				),
				retry: true,
				details: detail,
			};
		}
		case "not_applied": {
			const at = update.to_version ?? update.from_version;
			return {
				title: at
					? `${label} was still at ${at} after updating`
					: `${label} wasn't updated`,
				body: (
					<>
						The update didn't reach the{" "}
						<code className="font-mono">{command}</code> Pockode runs
						{update.binary_path && (
							<>
								{" "}
								(<code className="font-mono">{update.binary_path}</code>)
							</>
						)}
						. Either the way it is installed doesn't have{" "}
						{update.target_version ?? "the new version"} yet, or the update went
						to a second install on this machine — update that one from a
						terminal, or remove one.
					</>
				),
				// The same press would fail the same way; the check says when the
				// release has reached this install.
				retry: false,
				details: detail,
				detailsOpen: true,
			};
		}
		case "timeout":
			return {
				title: "The update took too long",
				body: (
					<>
						Pockode stopped waiting for it. If {label} no longer starts, run{" "}
						{updateCommand} on the server.
					</>
				),
				retry: true,
				details: detail,
			};
		case "not_installed":
			return {
				title: `${label} wasn't found`,
				body: (
					<>
						Pockode can't find the <code className="font-mono">{command}</code>{" "}
						command. Install it again, or install it on the server yourself.
					</>
				),
				retry: false,
				offerInstall: true,
			};
		default:
			return {
				title: "Update failed",
				body: detail ?? "The update ended without saying why.",
				retry: true,
			};
	}
}

/**
 * Every way an install ends badly (docs/cli-update-ui.md, "Failed"). Each says
 * how to get past it, since the same press would mostly fail the same way.
 */
function describeInstallFailure(
	agent: AgentType,
	update: CliUpdate,
): FailureCopy {
	const label = getAgentLabel(agent);
	const detail = update.failure?.detail;

	switch (update.failure?.reason) {
		case "permission_denied":
			// Without the PATH step, following this would fail as not_on_path.
			return {
				title: "npm can't write its global folder",
				body: (
					<>
						npm's global folder belongs to another user (usually root). Give it
						to this user, or set a prefix in your home directory (
						<code className="font-mono">
							npm config set prefix ~/.npm-global
						</code>
						), add its <code className="font-mono">bin</code> to the PATH
						pockode starts with, restart pockode, then try again.
					</>
				),
				retry: true,
				installLink: true,
				details: detail,
			};
		case "not_on_path":
			return {
				title: `${label} installed, but Pockode can't find it`,
				body: (
					<>
						npm installed it, but the folder npm puts commands in isn't on the
						PATH pockode was started with. Add it (
						<code className="font-mono">npm prefix --global</code>, plus{" "}
						<code className="font-mono">/bin</code> on Linux and macOS) and
						restart pockode.
					</>
				),
				// Installing again lands in the same folder.
				retry: false,
				// They name the prefix, when npm said.
				details: detail,
				detailsOpen: true,
			};
		case "command_failed": {
			const why = detail ? lastLine(detail) : undefined;
			return {
				title: `npm couldn't install ${label}`,
				body: (
					<>
						{why && <>{why} </>}
						Install it on the server yourself, or try again.
					</>
				),
				retry: true,
				installLink: true,
				details: detail,
			};
		}
		case "timeout":
			return {
				title: "The install took too long",
				body: `Pockode stopped npm after 10 minutes. Try again, or install ${label} on the server yourself.`,
				retry: true,
				details: detail,
			};
		default:
			return {
				title: "Install failed",
				body: detail ?? "The install ended without saying why.",
				retry: true,
				installLink: true,
			};
	}
}

function failedState(
	{
		agent,
		check,
		notInstalled,
		busy,
		installPending,
		signingIn,
		onUpdate,
		onInstall,
		onDismiss,
		installRefusal,
	}: Props,
	update: CliUpdate,
	copy: FailureCopy,
): RowState {
	const install = update.kind === "install";
	// A sign-in holds an update off; there is nothing to sign in to before an
	// install.
	const heldBySignIn = !install && signingIn;
	let action: ReactNode;
	if (copy.offerInstall) {
		action = (
			<InstallButton
				label="Install"
				busy={busy}
				pending={installPending}
				onInstall={onInstall}
			/>
		);
	} else if (copy.retry && install) {
		action = (
			<InstallButton
				label="Try again"
				busy={busy}
				pending={installPending}
				onInstall={onInstall}
			/>
		);
	} else if (copy.retry && !heldBySignIn) {
		action = (
			<button
				type="button"
				onClick={onUpdate}
				disabled={busy}
				className={secondaryButtonClass}
			>
				Try again
			</button>
		);
	}
	return {
		icon: failedIcon,
		title: copy.title,
		wrap: true,
		// The CLI as it is now, which a partial update may have moved.
		subtitle: check?.version
			? versionTitle(check.version)
			: notInstalled
				? "Not installed"
				: undefined,
		action,
		notice: {
			body: copy.body,
			details: copy.details,
			detailsKey: update.id,
			detailsOpen: copy.detailsOpen,
			footer: (
				<>
					{copy.retry && heldBySignIn && (
						<p className="self-center text-xs text-th-text-muted">
							Finish or cancel the sign-in first.
						</p>
					)}
					{(copy.installLink || installRefusal === "npm_not_found") && (
						<InstallLink agent={agent} variant="text" />
					)}
					<button
						type="button"
						onClick={() => onDismiss(update.id)}
						disabled={busy}
						className={`${cardTextButtonClass} text-th-text-secondary`}
					>
						Dismiss
					</button>
				</>
			),
		},
	};
}
