import { ConfirmDialog } from "@pockode/shared";
import { AlertTriangle, CircleSlash, Info } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useCliLoginSubscription } from "../../../hooks/useCliLoginSubscription";
import { getAgentLabel } from "../../../lib/agentType";
import { cliLoginActions, useCliLoginStore } from "../../../lib/cliLoginStore";
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

interface Props {
	agent: AgentType;
	/** Opens the sign-in sheet, which starts a sign-in or resumes the running one. */
	onOpenSignIn: () => void;
}

/** One CLI's sign-in status and what can be done about it from here. */
export default function CliStatusCard({ agent, onOpenSignIn }: Props) {
	// Follows the running sign-in, so the card moves on when it ends.
	useCliLoginSubscription(agent);
	const status = useCliLoginStore((s) => s.statuses[agent]);
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

	return (
		<li className="space-y-2 px-4 py-3">
			<div className="flex items-baseline justify-between gap-3">
				<h3 className="text-sm text-th-text-primary">{label}</h3>
				{status?.version && (
					<span className="text-xs text-th-text-muted">{status.version}</span>
				)}
			</div>

			{status ? (
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

function Dot({ className, filled }: { className: string; filled?: boolean }) {
	return (
		<span
			className={`inline-block h-2.5 w-2.5 rounded-full border-2 border-current ${
				filled ? "bg-current" : ""
			} ${className}`}
		/>
	);
}
