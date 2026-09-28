import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";
import { getAgentLabel } from "../../lib/agentType";
import { cliLoginActions, useCliLoginStore } from "../../lib/cliLoginStore";
import type { AgentType } from "../../types/settings";
import { ExternalSource } from "../CliLogin/cliAuthText";

interface Props {
	/** The failure in the CLI's own words. */
	message: string;
	agent: AgentType;
	/** Opens the sign-in; absent where nothing can be signed in from (a viewed session). */
	onSignIn?: () => void;
}

/**
 * A turn that failed — or is failing — because the CLI was refused for its
 * credentials, with the way to sign in (docs/cli-login-ui.md#the-notice).
 *
 * The record says only that this turn failed and for which CLI. Whether there
 * is anything to sign in to is read from live status: credentials the server's
 * environment supplies are not Pockode's to replace, so for those the notice
 * says where they come from instead of offering a button.
 */
export default function AuthFailureNotice({ message, agent, onSignIn }: Props) {
	const label = getAgentLabel(agent);
	const status = useCliLoginStore((s) => s.statuses[agent]);

	// Once per CLI, not per notice. The sheet reads afresh when it opens, and
	// signing in refreshes it.
	const canSignIn = !!onSignIn;
	useEffect(() => {
		if (canSignIn) cliLoginActions.ensureStatus(agent);
	}, [agent, canSignIn]);

	const external = status?.state === "external";
	// Held back until status has answered, so a button that is about to turn
	// out not to apply is never there to be pressed.
	const offerSignIn = onSignIn && status && !external;

	return (
		<div className="flex items-start gap-2 rounded bg-th-warning/10 p-2 text-sm">
			<AlertTriangle className="size-4 shrink-0 text-th-warning" />
			<div className="min-w-0 flex-1 space-y-1">
				<p className="break-words text-th-warning">{message}</p>
				<p className="text-th-text-secondary">
					{label} couldn't authenticate when this turn ran.
				</p>
				{external && (
					<p className="text-th-text-secondary">
						<ExternalSource agent={agent} external={status.external} />
					</p>
				)}
				{offerSignIn && (
					<div className="flex justify-end">
						<button
							type="button"
							onClick={onSignIn}
							className="inline-flex min-h-9 items-center rounded-lg bg-th-bg-tertiary px-3 text-th-text-primary transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11"
						>
							Sign in to {label}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
