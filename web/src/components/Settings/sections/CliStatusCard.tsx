import { ConfirmDialog } from "@pockode/shared";
import { useState } from "react";
import { useCliLoginSubscription } from "../../../hooks/useCliLoginSubscription";
import { useCliUpdateSubscription } from "../../../hooks/useCliUpdateSubscription";
import { getAgentLabel } from "../../../lib/agentType";
import {
	cliLoginActions,
	isLoginEnded,
	isStaleRead,
	useCliLoginStore,
} from "../../../lib/cliLoginStore";
import { cliInstallRefusedReason } from "../../../lib/rpc";
import type {
	CliInstallRefusedReason,
	CliUpdateCheck,
} from "../../../types/cliUpdate";
import type { AgentType } from "../../../types/settings";
import { errorMessage } from "../../../utils/errorMessage";
import CliAccountRow from "./CliAccountRow";
import CliInstallRow, { shownUpdate } from "./CliInstallRow";

interface Props {
	agent: AgentType;
	/** Opens the sign-in sheet, which starts a sign-in or resumes the running one. */
	onOpenSignIn: () => void;
}

/**
 * One CLI's installation and account, and what can be done about either from
 * here: a header and two rows that are always there, so values arriving fill
 * the card in place (docs/cli-update-ui.md, "Where it lives").
 */
export default function CliStatusCard({ agent, onOpenSignIn }: Props) {
	// Follows the running sign-in and update, so the card moves on when they end.
	useCliLoginSubscription(agent);
	useCliUpdateSubscription(agent);
	const readStatus = useCliLoginStore((s) => s.statuses[agent]);
	const settledStatus = useCliLoginStore((s) => s.settledStatuses[agent]);
	const check = useCliLoginStore((s) => s.checks[agent]);
	const checkError = useCliLoginStore((s) => s.checkErrors[agent]);
	const checking = useCliLoginStore((s) => !!s.checking[agent]);
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

	// While the CLI is being replaced or installed its sign-in is not read: the
	// card keeps what it read before, and nothing that runs the CLI is offered.
	// Sign-in status says `updating` for both; the record tells them apart.
	// A read taken while the record ran says nothing once it has ended: the
	// store reads again, and until then the last settled reads stand in.
	const liveCheck = isStaleRead(check, record) ? undefined : check;
	const liveStatus = isStaleRead(readStatus, record) ? undefined : readStatus;
	const installing =
		liveCheck?.state === "installing" ||
		(record?.kind === "install" && record.phase === "running");
	const updating =
		liveStatus?.state === "updating" ||
		liveCheck?.state === "updating" ||
		installing ||
		record?.phase === "running";
	const status = updating || !liveStatus ? settledStatus : liveStatus;
	const signingIn = readStatus?.state === "signing_in" || loginRunning;
	const reading = useCliLoginStore((s) => !!s.reading[agent]);
	const startedHere = useCliLoginStore((s) =>
		status?.login_id ? s.startedHere.includes(status.login_id) : false,
	);
	const label = getAgentLabel(agent);

	const [signingOut, setSigningOut] = useState(false);
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

	const signOut = async () => {
		setConfirmingSignOut(false);
		setSigningOut(true);
		setError(null);
		try {
			await cliLoginActions.logout(agent);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSigningOut(false);
		}
	};

	const [updateBusy, setUpdateBusy] = useState(false);
	const [installPending, setInstallPending] = useState(false);
	const [updateActionError, setUpdateActionError] = useState<string | null>(
		null,
	);
	const [installRefusal, setInstallRefusal] =
		useState<CliInstallRefusedReason | null>(null);
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
		setInstallRefusal(null);
	}
	const [confirmingUpdate, setConfirmingUpdate] = useState(false);
	// Another device started one while the dialog was up (its re-read check or
	// the subscription says so): pressing would join that update, not start one.
	if (confirmingUpdate && updating) setConfirmingUpdate(false);

	const runUpdateAction = async (action: () => Promise<void>) => {
		setUpdateBusy(true);
		setUpdateActionError(null);
		setInstallRefusal(null);
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

	const shown = shownUpdate(record, liveCheck, seenEnding);
	// An install this page saw succeed outranks the reads from before it, which
	// are being read again.
	const installed = shown?.kind === "install" && shown.phase === "succeeded";
	// Before the check answers, sign-in status says whether there is a CLI. A
	// failure shown that found it missing is newer than the check held from
	// before it, which is still being read again.
	const notInstalled =
		!installed &&
		((shown?.phase === "failed" &&
			(shown.kind === "install" ||
				shown.failure?.reason === "not_installed")) ||
			(liveCheck
				? liveCheck.state === "not_installed"
				: status?.state === "not_installed"));

	const [confirmingInstall, setConfirmingInstall] = useState(false);
	// Started elsewhere, or found there after all, while the dialog was up.
	if (confirmingInstall && (updating || !notInstalled)) {
		setConfirmingInstall(false);
	}

	const openInstall = () => {
		setConfirmingInstall(true);
		void cliLoginActions.refreshCheck(agent);
	};

	const confirmInstall = () => {
		setConfirmingInstall(false);
		void runUpdateAction(async () => {
			setInstallPending(true);
			try {
				await cliLoginActions.startInstall(agent);
			} catch (err) {
				const reason = cliInstallRefusedReason(err);
				// The store reads the CLI again, and the row moves on by itself.
				if (reason === "already_installed") return;
				setInstallRefusal(reason);
				throw err;
			} finally {
				setInstallPending(false);
			}
		});
	};

	return (
		<li className="space-y-1 px-4 py-3">
			<h3 className="h-5 text-sm text-th-text-primary">{label}</h3>

			<CliInstallRow
				agent={agent}
				check={liveCheck}
				checkError={checkError}
				checking={checking}
				statusVersion={readStatus?.version ?? settledStatus?.version}
				notInstalled={notInstalled}
				update={shown}
				startedHere={updateStartedHere}
				followError={updateError}
				signingIn={signingIn}
				busy={updateBusy}
				installPending={installPending}
				error={updateActionError}
				installRefusal={installRefusal}
				onUpdate={openUpdate}
				onInstall={openInstall}
				onDismiss={(updateId) =>
					void runUpdateAction(() =>
						cliLoginActions.dismissUpdate(agent, updateId),
					)
				}
			/>

			<CliAccountRow
				agent={agent}
				status={status}
				updating={updating && !installing}
				notInstalled={notInstalled || installing}
				awaitingStatus={
					installed &&
					reading &&
					(!readStatus ||
						readStatus.state === "not_installed" ||
						readStatus.state === "updating")
				}
				startedHere={startedHere}
				loginError={loginError}
				signingOut={signingOut}
				error={error}
				onSignOut={() => setConfirmingSignOut(true)}
				onOpenSignIn={onOpenSignIn}
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

			{confirmingInstall && (
				<ConfirmDialog
					title={`Install ${label}?`}
					message={`Pockode runs npm install --global for the latest ${label} (${check?.channel || "latest"} channel) on the server, as the user running Pockode. It is for the whole machine: every project and cluster node here will use it.`}
					confirmLabel="Install"
					cancelLabel="Cancel"
					onConfirm={confirmInstall}
					onCancel={() => setConfirmingInstall(false)}
				/>
			)}

			{confirmingSignOut && (
				<ConfirmDialog
					title={`Sign out of ${label}?`}
					message={`Every session using ${label} on this server stops working until you sign in again. This includes other projects and cluster nodes on this machine.`}
					confirmLabel="Sign out"
					cancelLabel="Cancel"
					variant="danger"
					onConfirm={() => void signOut()}
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
