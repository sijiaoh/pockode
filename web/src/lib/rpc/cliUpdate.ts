import type { JSONRPCRequester } from "json-rpc-2.0";
import type { CliUpdate, CliUpdateCheck } from "../../types/cliUpdate";
import type { AgentType } from "../../types/settings";
import { requireClient } from "./client";

export interface CliUpdateActions {
	/** Every CLI in display order, or just `agent`. Never fails for one CLI. */
	cliUpdateCheck: (agent?: AgentType) => Promise<CliUpdateCheck[]>;
	/** The update started, or the one already running for the CLI. */
	cliUpdateStart: (agent: AgentType) => Promise<CliUpdate>;
	cliUpdateDismiss: (updateId: string) => Promise<void>;
}

// The default timeout is enough: a check waits at most ~10s (the CLI's
// --version and the registry, read in parallel), and start and dismiss answer
// at once — the update itself runs on after the reply (docs/code/cli-update.md).
export function createCliUpdateActions(
	getClient: () => JSONRPCRequester<void> | null,
): CliUpdateActions {
	return {
		cliUpdateCheck: async (agent) => {
			const result: { checks: CliUpdateCheck[] } = await requireClient(
				getClient,
			).request("cli_update.check", agent ? { agent } : {});
			return result.checks;
		},

		cliUpdateStart: async (agent) => {
			const result: { update: CliUpdate } = await requireClient(
				getClient,
			).request("cli_update.start", { agent });
			return result.update;
		},

		cliUpdateDismiss: async (updateId) => {
			await requireClient(getClient).request("cli_update.dismiss", {
				update_id: updateId,
			});
		},
	};
}
