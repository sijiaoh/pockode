import { AlertTriangle, Info } from "lucide-react";
import { getAgentLabel } from "../../../lib/agentType";
import { cliLoginActions } from "../../../lib/cliLoginStore";
import type { CliAuthStatus } from "../../../types/cliAuth";
import type { AgentType } from "../../../types/settings";
import {
	accountSummary,
	ExternalSource,
	externalSourceLabel,
} from "../../CliLogin/cliAuthText";
import {
	cardTextButtonClass,
	primaryButtonClass,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";
import Skeleton from "../../ui/Skeleton";
import CliRow, { CliRowNotice, type CliRowState as RowState } from "./CliRow";

interface Props {
	agent: AgentType;
	/** The status to draw: while the CLI is being replaced, the one read before. */
	status: CliAuthStatus | undefined;
	/** The CLI is being replaced: nothing that runs it is offered. */
	updating: boolean;
	/** There is no CLI to sign in to. */
	notInstalled: boolean;
	/**
	 * The CLI was just installed and its status is being read: what is held
	 * is from before it was there.
	 */
	awaitingStatus: boolean;
	/** Whether this page started the running sign-in. */
	startedHere: boolean;
	/** Why the running sign-in could not be followed. */
	loginError: string | undefined;
	signingOut: boolean;
	/** A refused action, in the server's words. */
	error: string | null;
	onSignOut: () => void;
	/** Opens the sign-in sheet, which starts a sign-in or resumes the running one. */
	onOpenSignIn: () => void;
}

/** The card's account row: whether the CLI is signed in, and the way to change it. */
export default function CliAccountRow(props: Props) {
	const { notice, ...row } = accountState(props);
	return (
		<CliRow
			{...row}
			loadingLabel={`Checking ${getAgentLabel(props.agent)} sign-in status`}
			notice={<CliRowNotice {...notice} error={props.error} />}
		/>
	);
}

function accountState(props: Props): RowState {
	const {
		agent,
		status,
		updating,
		notInstalled,
		startedHere,
		loginError,
		signingOut,
		onSignOut,
		onOpenSignIn,
	} = props;
	const label = getAgentLabel(agent);

	if (props.awaitingStatus) {
		return {
			title: "Sign-in",
			subtitle: (
				<Skeleton
					className="my-0.5 h-3 w-40 max-w-full rounded"
					label={`Checking ${label} sign-in status`}
				/>
			),
		};
	}

	// A status read since the check may have found the CLI gone too.
	if ((notInstalled || status?.state === "not_installed") && !updating) {
		return {
			icon: <Dot className="text-th-text-muted" />,
			title: "Sign-in",
			subtitle: `Available once ${label} is installed`,
			dimmed: true,
		};
	}

	if (updating) {
		// A reload mid-update: there is no earlier read to keep.
		if (!status)
			return { title: "Sign-in", subtitle: "Checked after the update." };
		// The last read's line, with nothing that would run the CLI.
		return {
			...accountState({ ...props, updating: false }),
			subtitle: "Wait for the update to finish.",
			action: undefined,
			notice: undefined,
		};
	}

	switch (status?.state) {
		case undefined:
			return { title: undefined };
		case "signed_in":
			return {
				icon: <Dot className="text-th-success" filled />,
				title: "Signed in",
				subtitle: accountSummary(status.account),
				action: (
					<button
						type="button"
						onClick={onSignOut}
						disabled={signingOut}
						className={`${cardTextButtonClass} text-th-error`}
					>
						{signingOut && <Spinner variant="current" srText={null} />}
						{signingOut ? "Signing out…" : "Sign out"}
					</button>
				),
			};
		case "signed_out":
			return {
				icon: <Dot className="text-th-text-muted" />,
				title: "Not signed in",
				subtitle: `Sign in to use ${label}`,
				action: (
					<button
						type="button"
						onClick={onOpenSignIn}
						className={primaryButtonClass}
					>
						Sign in
					</button>
				),
			};
		case "external":
			return {
				icon: <Info className="h-4 w-4 text-th-text-muted" />,
				title: "Managed outside Pockode",
				subtitle: externalSourceLabel(status.external),
				notice: {
					body: <ExternalSource agent={agent} external={status.external} />,
				},
			};
		case "signing_in":
			return {
				icon: <Spinner srText={null} />,
				title: "Signing in…",
				subtitle: startedHere ? undefined : "Started earlier.",
				// Cancel is the sheet's: two buttons don't fit beside the line on a
				// phone.
				action: (
					<button
						type="button"
						onClick={onOpenSignIn}
						className={primaryButtonClass}
					>
						Continue
					</button>
				),
				// Otherwise "Signing in…" would stay up after the sign-in ended.
				notice: loginError
					? {
							body: `Couldn't follow this sign-in: ${loginError}. Refresh to check.`,
						}
					: undefined,
			};
		default:
			// unavailable, and any state this build does not know: never drawn as
			// "Not signed in", which would send the user into a sign-in that cannot
			// fix what is wrong.
			return {
				icon: <AlertTriangle className="h-4 w-4 text-th-error" />,
				title: "Couldn't read sign-in status",
				wrap: true,
				subtitle: "Retry, or refresh",
				action: (
					<button
						type="button"
						onClick={() => void cliLoginActions.refreshStatus(agent)}
						className={primaryButtonClass}
					>
						Retry
					</button>
				),
				notice: { body: status?.error },
			};
	}
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
