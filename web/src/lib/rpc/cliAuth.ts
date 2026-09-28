import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	CliAccountKind,
	CliAuthStatus,
	CliLogin,
} from "../../types/cliAuth";
import type { AgentType } from "../../types/settings";
import { requireClient } from "./client";

export interface CliAuthActions {
	/** Every CLI in display order, or just `agent`. Never fails for one CLI. */
	cliAuthStatus: (agent?: AgentType) => Promise<CliAuthStatus[]>;
	/** The status read after signing out. */
	cliAuthLogout: (agent: AgentType) => Promise<CliAuthStatus>;
	cliLoginStart: (
		agent: AgentType,
		accountKind?: CliAccountKind,
	) => Promise<CliLogin>;
	cliLoginSubmitCode: (loginId: string, code: string) => Promise<CliLogin>;
	cliLoginCancel: (loginId: string) => Promise<CliLogin>;
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
		cliAuthStatus: async (agent) => {
			const result: { statuses: CliAuthStatus[] } = await requireClient(
				getLongClient,
			).request("cli_auth.status", agent ? { agent } : {});
			return result.statuses;
		},

		cliAuthLogout: async (agent) => {
			const result: { status: CliAuthStatus } = await requireClient(
				getLongClient,
			).request("cli_auth.logout", { agent });
			return result.status;
		},

		cliLoginStart: async (agent, accountKind) => {
			const result: { login: CliLogin } = await requireClient(
				getClient,
			).request("cli_auth.login.start", {
				agent,
				...(accountKind ? { account_kind: accountKind } : {}),
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
