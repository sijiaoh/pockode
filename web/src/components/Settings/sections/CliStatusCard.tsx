import { ConfirmDialog } from "@pockode/shared";
import { AlertTriangle, CircleSlash, Info } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCliLoginSubscription } from "../../../hooks/useCliLoginSubscription";
import { useCliUpdateSubscription } from "../../../hooks/useCliUpdateSubscription";
import { getAgentLabel } from "../../../lib/agentType";
import {
	cliLoginActions,
	isLoginEnded,
	useCliLoginStore,
} from "../../../lib/cliLoginStore";
import type { CliUpdateCheck } from "../../../types/cliUpdate";
import type { AgentType } from "../../../types/settings";
import { errorMessage } from "../../../utils/errorMessage";
import {
	accountSummary,
	ExternalSource,
	InstallLink,
	NotInstalledHint,
} from "../../CliLogin/cliAuthText";
import {
	cardTextButtonClass,
	primaryButtonClass,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";
import Skeleton from "../../ui/Skeleton";
import CliVersionRow, { shownUpdate } from "./CliVersionRow";

interface Props {
	agent: AgentType;
	/** Opens the sign-in sheet, which starts a sign-in or resumes the running one. */
	onOpenSignIn: () => void;
}

/**
 * One CLI's sign-in status and version, and what can be done about either from
 * here.
 */
export default function CliStatusCard({ agent, onOpenSignIn }: Props) {
	// Follows the running sign-in and update, so the card moves on when they end.
	useCliLoginSubscription(agent);
	useCliUpdateSubscription(agent);
	const readStatus = useCliLoginStore((s) => s.statuses[agent]);
	const settledStatus = useCliLoginStore((s) => s.settledStatuses[agent]);
	const check = useCliLoginStore((s) => s.checks[agent]);
	const checkError = useCliLoginStore((s) => s.checkErrors[agent]);
	const record = useCliLoginStore((s) => s.updates[agent]);
	const seenEnding = useCliLoginStore((s) =>
		record ? s.updatesSeenEnding.includes(record.id) : false,
	);
	const updateStartedHere = useCliLoginStore((s) =>
		record ? s.updatesStartedHere.includes(record.id) : false,
	);
	const updateError = useCliLoginStore((s) => s.updateErrors[agent]);
	const loginRunning = useCliLoginStore((s) => {
		const login = s.logins[agent];
		return !!login && !isLoginEnded(login);
	});

	// While the CLI is being replaced its sign-in is not read: the card keeps
	// what it read before, and nothing that runs the CLI is offered.
	const updating =
		readStatus?.state === "updating" ||
		check?.state === "updating" ||
		record?.phase === "running";
	const status = updating ? settledStatus : readStatus;
	const signingIn = readStatus?.state === "signing_in" || loginRunning;
	const startedHere = useCliLoginStore((s) =>
		status?.login_id ? s.startedHere.includes(status.login_id) : false,
	);
	const label = getAgentLabel(agent);

	const [busy, setBusy] = useState<"signing_out" | "cancelling" | null>(null);
	const loginError = useCliLoginStore((s) => s.loginErrors[agent]);
	const [error, setError] = useState<string | null>(null);
	// An action's error is about the state it was pressed in; once the status
	// has moved on, a red "sign-out failed" under "Not signed in" would lie.
	const [errorState, setErrorState] = useState(status?.state);
	if (errorState !== status?.state) {
		setErrorState(status?.state);
		setError(null);
	}
	const [confirmingSignOut, setConfirmingSignOut] = useState(false);

	const run = async (
		kind: NonNullable<typeof busy>,
		action: () => Promise<void>,
	) => {
		setBusy(kind);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(null);
		}
	};

	const signOut = () => {
		setConfirmingSignOut(false);
		void run("signing_out", () => cliLoginActions.logout(agent));
	};

	const cancel = (loginId: string) =>
		void run("cancelling", () => cliLoginActions.cancelLogin(agent, loginId));

	const [updateBusy, setUpdateBusy] = useState(false);
	const [updateActionError, setUpdateActionError] = useState<string | null>(
		null,
	);
	// A refused start is about the check and record it was pressed over. By
	// content, not identity: the dialog re-reads the check, and that answer can
	// land after the refusal without anything having changed.
	const updateBasis = [
		check?.state,
		check?.version,
		check?.latest_version,
		record?.id,
		record?.phase,
	].join("|");
	const [errorBasis, setErrorBasis] = useState(updateBasis);
	if (errorBasis !== updateBasis) {
		setErrorBasis(updateBasis);
		setUpdateActionError(null);
	}
	const [confirmingUpdate, setConfirmingUpdate] = useState(false);
	// Another device started one while the dialog was up (its re-read check or
	// the subscription says so): pressing would join that update, not start one.
	if (confirmingUpdate && updating) setConfirmingUpdate(false);

	const runUpdateAction = async (action: () => Promise<void>) => {
		setUpdateBusy(true);
		setUpdateActionError(null);
		try {
			await action();
		} catch (err) {
			setUpdateActionError(errorMessage(err));
		} finally {
			setUpdateBusy(false);
		}
	};

	const openUpdate = () => {
		setConfirmingUpdate(true);
		// The dialog speaks for the check as it is now, not as the card drew it.
		void cliLoginActions.refreshCheck(agent);
	};

	const confirmUpdate = () => {
		setConfirmingUpdate(false);
		void runUpdateAction(() => cliLoginActions.startUpdate(agent));
	};

	let icon: ReactNode = null;
	let phrase: ReactNode = null;
	let detail: ReactNode = null;
	let actions: ReactNode = null;

	switch (status?.state) {
		case undefined:
			break;
		case "signed_in": {
			const summary = accountSummary(status.account);
			icon = <Dot className="text-th-success" filled />;
			phrase = summary ? `Signed in · ${summary}` : "Signed in";
			actions = (
				<button
					type="button"
					onClick={() => setConfirmingSignOut(true)}
					disabled={busy !== null}
					className={`${cardTextButtonClass} text-th-error`}
				>
					{busy === "signing_out" && (
						<Spinner variant="current" srText={null} />
					)}
					{busy === "signing_out" ? "Signing out…" : "Sign out"}
				</button>
			);
			break;
		}
		case "signed_out":
			icon = <Dot className="text-th-text-muted" />;
			phrase = "Not signed in";
			actions = (
				<button
					type="button"
					onClick={onOpenSignIn}
					className={primaryButtonClass}
				>
					Sign in
				</button>
			);
			break;
		case "external":
			icon = <Info className="h-4 w-4 text-th-text-muted" />;
			phrase = "Managed outside Pockode";
			detail = <ExternalSource agent={agent} external={status.external} />;
			break;
		case "not_installed":
			icon = <CircleSlash className="h-4 w-4 text-th-text-muted" />;
			phrase = "Not installed";
			detail = <NotInstalledHint agent={agent} />;
			actions = <InstallLink agent={agent} variant="text" />;
			break;
		case "signing_in": {
			const loginId = status.login_id;
			icon = <Spinner srText={null} />;
			phrase = "Signing in…";
			detail = startedHere ? null : "Started earlier.";
			// Otherwise "Signing in…" would stay up after the sign-in ended.
			if (loginError) {
				detail = `Couldn't follow this sign-in: ${loginError}. Refresh to check.`;
			}
			actions = (
				<>
					{loginId && (
						<button
							type="button"
							onClick={() => cancel(loginId)}
							disabled={busy !== null}
							className={`${cardTextButtonClass} text-th-accent`}
						>
							{busy === "cancelling" ? "Cancelling…" : "Cancel"}
						</button>
					)}
					<button
						type="button"
						onClick={onOpenSignIn}
						className={primaryButtonClass}
					>
						Continue
					</button>
				</>
			);
			break;
		}
		default:
			// unavailable, and any state this build does not know: never drawn as
			// "Not signed in", which would send the user into a sign-in that
			// cannot fix what is wrong.
			icon = <AlertTriangle className="h-4 w-4 text-th-error" />;
			phrase = "Couldn't read sign-in status";
			detail = status?.error ?? null;
			actions = (
				<button
					type="button"
					onClick={() => void cliLoginActions.refreshStatus(agent)}
					className={primaryButtonClass}
				>
					Retry
				</button>
			);
	}

	if (updating) {
		actions = null;
		if (!status) {
			// A reload mid-update: there is no earlier read to keep.
			phrase = "Sign-in status is checked after the update.";
		}
	}

	return (
		<li className="space-y-2 px-4 py-3">
			<h3 className="text-sm text-th-text-primary">{label}</h3>

			{status || updating ? (
				<>
					<div className="flex items-start gap-2">
						<span className="flex h-5 shrink-0 items-center" aria-hidden="true">
							{icon}
						</span>
						<div className="min-w-0 space-y-0.5">
							<p className="break-words text-sm text-th-text-primary">
								{phrase}
							</p>
							{detail && (
								<p className="break-words text-xs text-th-text-muted">
									{detail}
								</p>
							)}
							{error && (
								<p className="break-words text-xs text-th-error" role="alert">
									{error}
								</p>
							)}
						</div>
					</div>
					{actions && <div className="flex justify-end gap-2">{actions}</div>}
					{updating && status && (
						<p className="text-right text-xs text-th-text-muted">
							Wait for the update to finish.
						</p>
					)}
				</>
			) : (
				<div className="space-y-2">
					<Skeleton
						className="h-5 w-40 rounded"
						label={`Checking ${label} sign-in status`}
					/>
					<div className="flex justify-end">
						<Skeleton className="h-11 w-20 rounded-lg" />
					</div>
				</div>
			)}

			<CliVersionRow
				agent={agent}
				check={check}
				checkError={checkError}
				statusVersion={readStatus?.version ?? settledStatus?.version}
				statusNotInstalled={readStatus?.state === "not_installed"}
				update={shownUpdate(record, check, seenEnding)}
				startedHere={updateStartedHere}
				followError={updateError}
				signingIn={signingIn}
				busy={updateBusy}
				error={updateActionError}
				onUpdate={openUpdate}
				onDismiss={(updateId) =>
					void runUpdateAction(() =>
						cliLoginActions.dismissUpdate(agent, updateId),
					)
				}
			/>

			{confirmingUpdate && (
				<ConfirmDialog
					title={`Update ${label}?`}
					message={updateMessage(label, check)}
					confirmLabel="Update"
					cancelLabel="Cancel"
					onConfirm={confirmUpdate}
					onCancel={() => setConfirmingUpdate(false)}
				/>
			)}

			{confirmingSignOut && (
				<ConfirmDialog
					title={`Sign out of ${label}?`}
					message={`Every session using ${label} on this server stops working until you sign in again. This includes other projects and cluster nodes on this machine.`}
					confirmLabel="Sign out"
					cancelLabel="Cancel"
					variant="danger"
					onConfirm={signOut}
					onCancel={() => setConfirmingSignOut(false)}
				/>
			)}
		</li>
	);
}

/**
 * What an update reaches and what it leaves alone (docs/cli-update-ui.md,
 * "Pressing Update"). No version in the title: the CLI installs whatever is
 * newest when it runs.
 */
function updateMessage(label: string, check: CliUpdateCheck | undefined) {
	const sentences: string[] = [];
	if (check?.state === "update_available" && check.latest_version) {
		sentences.push(
			check.version
				? `${check.latest_version} is available; this server has ${check.version}.`
				: `${check.latest_version} is available.`,
		);
	}
	sentences.push(
		`The update is for the whole machine: every project and cluster node here uses the same ${label}.`,
	);
	const kept = check?.version ?? "the version they started with";
	const count = check?.running_sessions ?? 0;
	if (count === 1) {
		sentences.push(
			`${label} is open in 1 session in this project. It isn't interrupted — it keeps ${kept} until it closes, and uses the new version from its next start.`,
		);
	} else if (count > 1) {
		sentences.push(
			`${label} is open in ${count} sessions in this project. They aren't interrupted — they keep ${kept} until they close, and use the new version from their next start.`,
		);
	} else {
		sentences.push(
			`Running sessions aren't interrupted — they keep ${kept} until they close, and use the new version from their next start.`,
		);
	}
	return sentences.join(" ");
}

function Dot({ className, filled }: { className: string; filled?: boolean }) {
	return (
		<span
			className={`inline-block h-2.5 w-2.5 rounded-full border-2 border-current ${
				filled ? "bg-current" : ""
			} ${className}`}
		/>
	);
}
