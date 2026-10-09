import { JSONRPCErrorException, type JSONRPCRequester } from "json-rpc-2.0";
import type {
	CliInstallRefusedReason,
	CliUpdate,
	CliUpdateCheck,
} from "../../types/cliUpdate";
import type { AgentType } from "../../types/settings";
import { requireClient } from "./client";

export interface CliUpdateActions {
	/** Every CLI in display order, or just `agent`. Never fails for one CLI. */
	cliUpdateCheck: (agent?: AgentType) => Promise<CliUpdateCheck[]>;
	/** The update started, or the one already running for the CLI. */
	cliUpdateStart: (agent: AgentType) => Promise<CliUpdate>;
	/**
	 * The install started — an update of kind "install" — or the one already
	 * running for the CLI. Followed through `cli_update.subscribe` like any update.
	 */
	cliUpdateInstall: (agent: AgentType) => Promise<CliUpdate>;
	cliUpdateDismiss: (updateId: string) => Promise<void>;
}

/** Where: server/rpc/types.go's CodeCLIInstallRefused. */
const CLI_INSTALL_REFUSED_CODE = -32003;

const INSTALL_REFUSED_REASONS: readonly string[] = [
	"already_installed",
	"npm_not_found",
	"busy",
] satisfies CliInstallRefusedReason[];

/**
 * Why the server refused to start an install, or null if the failure is
 * anything else. Recognised by the code and `data.reason`, never the message,
 * which is prose the server may reword.
 */
export function cliInstallRefusedReason(
	error: unknown,
): CliInstallRefusedReason | null {
	if (
		!(error instanceof JSONRPCErrorException) ||
		error.code !== CLI_INSTALL_REFUSED_CODE
	) {
		return null;
	}
	const reason = (error.data as { reason?: unknown } | undefined)?.reason;
	return typeof reason === "string" && INSTALL_REFUSED_REASONS.includes(reason)
		? (reason as CliInstallRefusedReason)
		: null;
}

// The default timeout is enough: a check waits at most ~10s (the CLI's
// --version and the registry, read in parallel), and start, install and
// dismiss answer at once — the update or install itself runs on after the
// reply (docs/code/cli-update.md).
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

		cliUpdateInstall: async (agent) => {
			const result: { update: CliUpdate } = await requireClient(
				getClient,
			).request("cli_update.install", { agent });
			return result.update;
		},

		cliUpdateDismiss: async (updateId) => {
			await requireClient(getClient).request("cli_update.dismiss", {
				update_id: updateId,
			});
		},
	};
}
