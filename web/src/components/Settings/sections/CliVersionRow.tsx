import { AlertTriangle, ArrowUpCircle, CheckCircle2, Info } from "lucide-react";
import type { ReactNode } from "react";
import { AGENT_CLI_INFO, getAgentLabel } from "../../../lib/agentType";
import type { CliUpdate, CliUpdateCheck } from "../../../types/cliUpdate";
import type { AgentType } from "../../../types/settings";
import { InstallLink, NotInstalledHint } from "../../CliLogin/cliAuthText";
import {
	cardTextButtonClass,
	Details,
	formatMinutes,
	secondaryButtonClass,
	useNow,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";

interface Props {
	agent: AgentType;
	check: CliUpdateCheck | undefined;
	/** Why the last check request failed. */
	checkError: string | undefined;
	/** The version sign-in status read, for the line while no check has answered. */
	statusVersion: string | undefined;
	/** Sign-in status found no CLI, for while no check has answered. */
	statusNotInstalled: boolean;
	/** The update record to draw, already chosen by `shownUpdate`. */
	update: CliUpdate | null;
	/** Whether this page started `update`. */
	startedHere: boolean;
	/** Why the update could not be followed. */
	followError: string | undefined;
	/** A sign-in to the CLI is running: the update would replace its binary. */
	signingIn: boolean;
	busy: boolean;
	/** A refused start or dismiss, in the server's words. */
	error: string | null;
	onUpdate: () => void;
	onDismiss: (updateId: string) => void;
}

/**
 * Which of the CLI's update records the row draws, if any
 * (docs/cli-update-ui.md, "Which update record the row shows"): a running one
 * always; a success only when this page watched it end; a failure until it is
 * dismissed — unless the CLI has changed since the update left it, both
 * versions being known. "Left it" is the version read after the update, not
 * before: a failure that moved the CLI part of the way is still news.
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
			const left = update.to_version ?? update.from_version;
			if (check?.version && left && check.version !== left) return null;
			return update;
		}
	}
}

/**
 * The foot of a CLI's card: its installed version, whether a newer one is out,
 * and the update — running, just done, or failed. The version is always the
 * check's, never an update record's: the record is what happened then.
 */
export default function CliVersionRow(props: Props) {
	const { agent, check, update } = props;
	const notInstalled = check
		? check.state === "not_installed"
		: props.statusNotInstalled;
	// A not-installed CLI has no row, except to show why its update failed.
	if (notInstalled && !update) return null;

	let body: ReactNode;
	// Only the update's phases are announced, not "Checking" and "Up to date"
	// for both cards on every refresh.
	let announcement = "";
	if (update?.phase === "running") {
		announcement = updatingText(agent);
		body = <Running {...props} update={update} />;
	} else if (update?.phase === "succeeded") {
		announcement = updatedText(agent, update);
		body = <Line icon={succeededIcon}>{announcement}</Line>;
	} else if (update) {
		const copy = describeUpdateFailure(agent, update);
		announcement = copy.title;
		body = <Failed {...props} update={update} copy={copy} />;
	} else {
		if (check?.state === "updating") announcement = updatingText(agent);
		body = (
			<>
				<CheckLine {...props} />
				{/* Otherwise a failure the subscription never delivered would go
				    unmentioned. */}
				{props.followError && (
					<p className="break-words pl-6 text-xs text-th-text-muted">
						Couldn't follow {getAgentLabel(agent)}'s updates:{" "}
						{props.followError}. Reload the page to follow them.
					</p>
				)}
			</>
		);
	}

	return (
		<div className="space-y-2 border-t border-th-border pt-3">
			{/* One live region for every phase, so each is heard once: a region
			    mounted with its text already in it is often not read at all. */}
			<output className="sr-only">{announcement}</output>
			{body}
			{props.error && (
				<p className="break-words text-xs text-th-error" role="alert">
					{props.error}
				</p>
			)}
		</div>
	);
}

const succeededIcon = <CheckCircle2 className="h-4 w-4 text-th-success" />;

function Line({
	icon,
	children,
	secondary,
}: {
	icon: ReactNode;
	children: ReactNode;
	secondary?: ReactNode;
}) {
	return (
		<div className="flex items-start gap-2">
			<span className="flex h-5 w-4 shrink-0 items-center" aria-hidden="true">
				{icon}
			</span>
			<div className="min-w-0 space-y-0.5">
				<p className="break-words text-sm text-th-text-primary">{children}</p>
				{secondary && (
					<p className="break-words text-xs text-th-text-muted">{secondary}</p>
				)}
			</div>
		</div>
	);
}

function Actions({ children }: { children: ReactNode }) {
	return <div className="flex justify-end gap-2">{children}</div>;
}

function withVersion(version: string | undefined, state: string): string {
	return version ? `Version ${version} · ${state}` : state;
}

function CheckLine({
	agent,
	check,
	checkError,
	statusVersion,
	signingIn,
	busy,
	onUpdate,
}: Props) {
	const version = check?.version ?? statusVersion;

	// A check that could not be made is never drawn as "Up to date".
	if (checkError) {
		return (
			<Line icon={mutedInfo} secondary={checkError}>
				{withVersion(version, "Couldn't check for updates")}
			</Line>
		);
	}

	if (!check) {
		return (
			<Line icon={null}>{withVersion(version, "Checking for updates…")}</Line>
		);
	}

	switch (check.state) {
		case "up_to_date":
			return (
				<Line icon={<CheckCircle2 className="h-4 w-4 text-th-text-muted" />}>
					{withVersion(check.version, "Up to date")}
				</Line>
			);
		case "update_available": {
			const latest = check.latest_version ?? "A newer version";
			const available =
				check.channel && check.channel !== "latest"
					? `${latest} available on ${check.channel}`
					: `${latest} available`;
			return (
				<>
					<Line icon={<ArrowUpCircle className="h-4 w-4 text-th-accent" />}>
						{withVersion(check.version, available)}
					</Line>
					<Actions>
						{signingIn ? (
							<p className="text-xs text-th-text-muted">
								Finish or cancel the sign-in first.
							</p>
						) : (
							<button
								type="button"
								onClick={onUpdate}
								disabled={busy}
								className={secondaryButtonClass}
							>
								Update
							</button>
						)}
					</Actions>
				</>
			);
		}
		case "not_yet_available":
			// The server cannot tell a lagging install method from an update that
			// went to another install, so neither is asserted.
			return (
				<Line
					icon={mutedInfo}
					secondary={`The last update didn't reach it: the way ${getAgentLabel(agent)} is installed may not have it yet, or the update went to another install on this machine.`}
				>
					{withVersion(
						check.version,
						`${check.latest_version ?? "A newer version"} is out`,
					)}
				</Line>
			);
		case "updating":
			// The check saw an update the subscription has not delivered: not one
			// this page started, which would have come back in the start's reply.
			return (
				<Line icon={<Spinner srText={null} />} secondary="Started earlier.">
					{updatingText(agent)}
				</Line>
			);
		case "not_installed":
			return null;
		default:
			// unavailable, and any state this build does not know. Without the
			// installed version there is nothing to update from: a CLI that cannot
			// print its version is not one to trust with replacing itself.
			if (!check.version) {
				return (
					<Line
						icon={<AlertTriangle className="h-4 w-4 text-th-error" />}
						secondary={check.error}
					>
						Couldn't read the installed version
					</Line>
				);
			}
			return (
				<Line icon={mutedInfo} secondary={check.error}>
					{withVersion(check.version, "Couldn't check for updates")}
				</Line>
			);
	}
}

const mutedInfo = <Info className="h-4 w-4 text-th-text-muted" />;

function Running({
	agent,
	update,
	startedHere,
	followError,
}: Props & { update: CliUpdate }) {
	let secondary: ReactNode = startedHere ? (
		<Elapsed startedAt={update.started_at} />
	) : (
		"Started earlier."
	);
	// Otherwise "Updating…" would stay up after the update ended.
	if (followError) {
		// Refresh reads the check but does not subscribe again; a new page does.
		secondary = `Couldn't follow this update: ${followError}. Reload the page to follow it.`;
	}
	return (
		<Line icon={<Spinner srText={null} />} secondary={secondary}>
			{updatingText(agent)}
		</Line>
	);
}

/** Its own component, so only the elapsed time redraws every second. */
function Elapsed({ startedAt }: { startedAt: string }) {
	const now = useNow();
	return `Started ${formatMinutes(elapsedSeconds(startedAt, now) * 1000)} ago`;
}

function updatingText(agent: AgentType): string {
	return `Updating ${getAgentLabel(agent)}…`;
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

interface FailureCopy {
	title: string;
	/** What to do. Enough on its own, without opening the details. */
	body: ReactNode;
	retry: boolean;
	install?: boolean;
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
						command. <NotInstalledHint agent={agent} />
					</>
				),
				retry: false,
				install: true,
			};
		default:
			return {
				title: "Update failed",
				body: detail ?? "The update ended without saying why.",
				retry: true,
			};
	}
}

function Failed({
	agent,
	check,
	update,
	copy,
	busy,
	onUpdate,
	onDismiss,
	signingIn,
}: Props & { update: CliUpdate; copy: FailureCopy }) {
	return (
		<>
			{/* The CLI as it is now, which a partial update may have moved. */}
			{check?.version && <Line icon={null}>Version {check.version}</Line>}
			<Line icon={<AlertTriangle className="h-4 w-4 text-th-error" />}>
				{copy.title}
			</Line>
			<p className="break-words pl-6 text-xs text-th-text-muted">{copy.body}</p>
			{copy.details && (
				<div className="pl-6">
					<Details
						key={update.id}
						details={copy.details}
						defaultOpen={copy.detailsOpen}
					/>
				</div>
			)}
			<Actions>
				<button
					type="button"
					onClick={() => onDismiss(update.id)}
					disabled={busy}
					className={`${cardTextButtonClass} text-th-text-secondary`}
				>
					Dismiss
				</button>
				{copy.install && <InstallLink agent={agent} variant="text" />}
				{copy.retry &&
					(signingIn ? (
						<p className="self-center text-xs text-th-text-muted">
							Finish or cancel the sign-in first.
						</p>
					) : (
						<button
							type="button"
							onClick={onUpdate}
							disabled={busy}
							className={secondaryButtonClass}
						>
							Try again
						</button>
					))}
			</Actions>
		</>
	);
}
