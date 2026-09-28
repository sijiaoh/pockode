import type { ReactNode } from "react";
import { AGENT_CLI_INFO, getAgentLabel } from "../../lib/agentType";
import type { CliLogin } from "../../types/cliAuth";
import type { AgentType } from "../../types/settings";
import { ExternalSource, NotInstalledHint } from "./cliAuthText";

export interface FailureCopy {
	title: string;
	/** What to do. Enough on its own, without opening the details. */
	body: ReactNode;
	/** The one way forward inside the sheet, if there is one. */
	retry: "Start again" | "Try again" | null;
	/** The CLI's own message, already stripped of links and codes by the server. */
	details?: string;
	detailsOpen?: boolean;
	/** The CLI is missing: point at its install page. */
	install?: boolean;
}

/**
 * Every way a sign-in ends badly, as one layout: a title saying what happened,
 * a body saying what to do (docs/cli-login-ui.md, "Failed").
 */
export function describeFailure(
	agent: AgentType,
	login: CliLogin,
): FailureCopy {
	const label = getAgentLabel(agent);
	const failure = login.failure;
	const detail = failure?.detail;

	switch (failure?.reason) {
		case "code_rejected":
			// The CLI ends the flow on a code it refuses, so this cannot stay
			// inline the way an incomplete code does.
			return {
				title: "That code wasn't accepted",
				body: "Check you pasted all of it, or start again for a new sign-in page.",
				retry: "Start again",
				details: detail,
			};
		case "expired":
			return {
				title: "This sign-in expired",
				body: "Sign-in codes only work for a few minutes. Start again to get a new one.",
				retry: "Start again",
			};
		case "device_auth_failed":
			// Codex does not say distinctly that device code sign-in is off for the
			// account, so its message is shown as it came, with the likely fix.
			return {
				title: `${label} couldn't finish the sign-in`,
				body: (
					<>
						{detail && <>{detail} </>}
						If this is a ChatGPT account, check that device code authorization
						is turned on in its security settings, then start again.
					</>
				),
				retry: "Start again",
			};
		case "not_installed":
			return {
				title: `${label} isn't installed`,
				body: <NotInstalledHint agent={agent} verb="try again" />,
				retry: null,
				install: true,
			};
		case "external":
			return {
				title: `${label} is managed outside Pockode`,
				body: <ExternalSource agent={agent} external={failure.external} />,
				retry: null,
				details: detail,
			};
		case "flow_broken":
			return {
				title: `Pockode couldn't run the sign-in for ${label}${
					login.version ? ` ${login.version}` : ""
				}`,
				body: (
					<>
						Its sign-in steps didn't look the way Pockode expects. This usually
						follows a CLI update. Update Pockode, or sign in once from a
						terminal on the server with{" "}
						<code className="font-mono">
							{AGENT_CLI_INFO[agent].loginCommand}
						</code>
						.
					</>
				),
				retry: null,
				details: detail,
				detailsOpen: true,
			};
		default:
			return {
				title: "Sign-in failed",
				body: detail ?? "The sign-in ended without saying why.",
				retry: "Try again",
			};
	}
}
