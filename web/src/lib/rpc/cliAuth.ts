import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	CliAccountKind,
	CliAuthStatus,
	CliLogin,
} from "../../types/cliAuth";
import type { AgentType } from "../../types/settings";
import { requireClient } from "./client";

/**
 * `profileId` on these names the profile (account) a call is for: absent is
 * the CLI's current one, resolved by the server when the call is made;
 * `DEFAULT_PROFILE_ID` is the default one. Every status and sign-in names the
 * profile it was for (docs/code/cli-auth.md#the-rpc).
 */
export interface CliAuthActions {
	/**
	 * Every CLI in display order, or just `agent`. Never fails for one CLI.
	 * `profileId` needs `agent`.
	 */
	cliAuthStatus: (
		agent?: AgentType,
		profileId?: string,
	) => Promise<CliAuthStatus[]>;
	/** The status read after signing out. */
	cliAuthLogout: (
		agent: AgentType,
		profileId?: string,
	) => Promise<CliAuthStatus>;
	cliLoginStart: (
		agent: AgentType,
		accountKind?: CliAccountKind,
		profileId?: string,
	) => Promise<CliLogin>;
	cliLoginSubmitCode: (loginId: string, code: string) => Promise<CliLogin>;
	cliLoginCancel: (loginId: string) => Promise<CliLogin>;
}

/**
 * `profile_id` when a profile is named. Absent and `""` mean different
 * profiles — the current one and the default one — so it is left out only
 * when undefined.
 */
export function profileParam(profileId: string | undefined): {
	profile_id?: string;
} {
	return profileId === undefined ? {} : { profile_id: profileId };
}

/**
 * @param getLongClient Requester for `cli_auth.status` and `cli_auth.logout`,
 * which run the CLI while the client waits: up to 45s of the server's own
 * budget plus 20s queued behind another command on the same CLI
 * (docs/code/cli-auth.md#timeouts). The default 30s would give up on a slow
 * Codex read the server is still going to answer. The `cli_auth.login.*`
 * methods run no CLI while waited on and keep the default.
 */
export function createCliAuthActions(
	getClient: () => JSONRPCRequester<void> | null,
	getLongClient: () => JSONRPCRequester<void> | null,
): CliAuthActions {
	return {
		cliAuthStatus: async (agent, profileId) => {
			const result: { statuses: CliAuthStatus[] } = await requireClient(
				getLongClient,
			).request("cli_auth.status", {
				...(agent ? { agent } : {}),
				...profileParam(profileId),
			});
			return result.statuses;
		},

		cliAuthLogout: async (agent, profileId) => {
			const result: { status: CliAuthStatus } = await requireClient(
				getLongClient,
			).request("cli_auth.logout", { agent, ...profileParam(profileId) });
			return result.status;
		},

		cliLoginStart: async (agent, accountKind, profileId) => {
			const result: { login: CliLogin } = await requireClient(
				getClient,
			).request("cli_auth.login.start", {
				agent,
				...(accountKind ? { account_kind: accountKind } : {}),
				...profileParam(profileId),
			});
			return result.login;
		},

		cliLoginSubmitCode: async (loginId, code) => {
			const result: { login: CliLogin } = await requireClient(
				getClient,
			).request("cli_auth.login.submit_code", { login_id: loginId, code });
			return result.login;
		},

		cliLoginCancel: async (loginId) => {
			const result: { login: CliLogin } = await requireClient(
				getClient,
			).request("cli_auth.login.cancel", { login_id: loginId });
			return result.login;
		},
	};
}
