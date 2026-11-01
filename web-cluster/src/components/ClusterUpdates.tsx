import {
	type ServerUpdateCheck,
	type UpdateCandidate,
	updateCandidateName,
} from "@pockode/shared";
import { type UpdateCheckState, updateCheckOf } from "../hooks/useUpdateCheck";
import { cannotInstallCopy, unavailableCopy } from "../lib/updateCopy";
import { DEV_VERSION } from "../lib/version";
import { formatAgo } from "../utils/time";
import { NEUTRAL_BUTTON, PRIMARY_BUTTON } from "./buttons";
import { CodeText } from "./CodeText";

/** A failed install this page remembers, said under its candidate. */
export interface UpdateFailure {
	version: string;
	title: string;
	body: string;
	/** Whether pressing Update again can help. */
	retry: boolean;
}

const TEXT_BUTTON =
	"inline-flex min-h-[44px] items-center px-1 font-medium text-th-accent hover:underline disabled:opacity-50";

/** Whether the check says nothing can be installed right now, release aside. */
export function blocksInstall(check: ServerUpdateCheck) {
	return check.cannot_install !== undefined || check.installing !== undefined;
}

/**
 * Whether candidate's row carries Update: the cluster can install, the
 * release has a verifiable build here, and no failure has ruled a retry out.
 */
export function offersUpdate(
	check: ServerUpdateCheck,
	candidate: UpdateCandidate,
	failure: UpdateFailure | null,
) {
	const failed = failure?.version === candidate.version ? failure : null;
	return (
		!blocksInstall(check) &&
		candidate.unavailable === undefined &&
		(failed?.retry ?? true)
	);
}

/** Whether there is anything to check: a development build never is. */
export function checksForUpdates(running: string, state: UpdateCheckState) {
	return (
		running !== DEV_VERSION &&
		updateCheckOf(state)?.check_error?.reason !== "dev_build"
	);
}

function ExternalLinkIcon() {
	return (
		<svg
			className="h-3 w-3 shrink-0"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			viewBox="0 0 24 24"
			aria-hidden="true"
		>
			<path d="M15 3h6v6" />
			<path d="M10 14 21 3" />
			<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
		</svg>
	);
}

/**
 * The release's GitHub page, as the whole text block of its row so the hit
 * area is the row's 44px rather than one line of `text-xs`.
 */
export function ReleaseNotesLink({
	candidate,
	reason,
	title = true,
}: {
	candidate: UpdateCandidate;
	/** Why it can't be installed, said in place of "Release notes". */
	reason?: string;
	/** Off where the sheet's title already names the release. */
	title?: boolean;
}) {
	const name = updateCandidateName(candidate);
	return (
		<a
			href={candidate.notes_url}
			target="_blank"
			rel="noreferrer"
			// With a reason in place of "Release notes", the name starts with what
			// is on screen, so a voice user can still say it.
			aria-label={
				reason
					? `${name}, ${reason}, release notes on GitHub`
					: `Release notes for ${name}, opens GitHub`
			}
			className="group flex min-h-[44px] min-w-0 flex-col justify-center"
		>
			{title && (
				<span className="text-th-text-primary">
					{updateCandidateName(candidate)}
				</span>
			)}
			<span className="flex items-center gap-1 text-xs text-th-text-muted group-hover:underline">
				{reason ?? "Release notes"}
				<ExternalLinkIcon />
			</span>
		</a>
	);
}

interface Props {
	running: string;
	state: UpdateCheckState;
	failure: UpdateFailure | null;
	onUpdate: (candidate: UpdateCandidate) => void;
	/** A restart is out: nothing here may start until it is answered. */
	busy: boolean;
}

/**
 * The candidates, the check line under them and every reason one cannot be
 * installed, in the cluster sheet's first view (docs/self-update-ui.md,
 * "web-cluster: the header").
 */
export function ClusterUpdates({
	running,
	state,
	failure,
	onUpdate,
	busy,
}: Props) {
	if (!checksForUpdates(running, state)) return null;

	const check = updateCheckOf(state);
	// One button with three labels: Check for updates, Check again, Try again.
	// "Checking..." follows the user's press only, never a connect or
	// visibility read.
	const checkAgain = (label: string) => (
		<button
			type="button"
			onClick={() => state.refresh(true)}
			disabled={state.forcing || busy}
			className={TEXT_BUTTON}
		>
			{state.forcing ? "Checking..." : label}
		</button>
	);

	if (state.read?.kind === "failed") {
		return (
			<p className="text-xs text-th-text-muted">
				Couldn't check for updates: {state.read.message} ·{" "}
				{checkAgain("Try again")}
			</p>
		);
	}
	// Before the first read lands there is nothing to say: no request to
	// GitHub is out to say "Checking" about.
	if (check === null) return null;

	const cannot = check.cannot_install
		? cannotInstallCopy(check.cannot_install)
		: null;
	const checked = check.checked_at
		? formatAgo(check.checked_at, Date.now())
		: null;

	let checkLine: React.ReactNode;
	if (check.installing) {
		checkLine = "Another Pockode on this machine is installing a new version.";
	} else if (!check.checked_at && !check.check_error) {
		// The server answers unforced reads from what it last found, and it has
		// found nothing since it started: neither up to date nor checking.
		checkLine = (
			<>
				Not checked since the cluster started ·{" "}
				{checkAgain("Check for updates")}
			</>
		);
	} else if (check.check_error) {
		checkLine = (
			<>
				Couldn't check for updates: {check.check_error.message} ·{" "}
				{checkAgain("Try again")}
			</>
		);
	} else if (check.candidates.length > 0) {
		checkLine = (
			<>
				Checked {checked} · {checkAgain("Check again")}
			</>
		);
	} else {
		checkLine = (
			<>
				Up to date · checked {checked} · {checkAgain("Check again")}
			</>
		);
	}

	return (
		<div className="flex flex-col">
			{check.candidates.map((candidate) => {
				const unavailable = candidate.unavailable
					? unavailableCopy(
							candidate.unavailable.reason,
							candidate.version,
							check,
						)
					: null;
				const failed = failure?.version === candidate.version ? failure : null;
				const installable = offersUpdate(check, candidate, failure);
				return (
					<div key={candidate.channel} className="flex flex-col">
						<div className="flex items-center justify-between gap-3">
							<ReleaseNotesLink
								candidate={candidate}
								reason={unavailable?.subtitle}
							/>
							{installable && (
								<button
									type="button"
									onClick={() => onUpdate(candidate)}
									disabled={busy}
									aria-label={`Update to ${updateCandidateName(candidate)}`}
									className={
										candidate.channel === "latest"
											? PRIMARY_BUTTON
											: NEUTRAL_BUTTON
									}
								>
									Update
								</button>
							)}
						</div>
						{unavailable && (
							<p className="text-th-text-secondary">
								<CodeText text={unavailable.notice} />
							</p>
						)}
						{failed && (
							<p role="alert" className="text-th-error">
								<span className="font-medium">{failed.title}.</span>{" "}
								<CodeText text={failed.body} />
							</p>
						)}
					</div>
				);
			})}
			{check.candidates.length > 0 && cannot && (
				<p className="mt-2 text-th-text-secondary">
					<span className="font-medium text-th-text-primary">
						<CodeText text={cannot.title} />.
					</span>{" "}
					<CodeText text={cannot.body} />
				</p>
			)}
			<p className="text-xs text-th-text-muted">{checkLine}</p>
		</div>
	);
}
