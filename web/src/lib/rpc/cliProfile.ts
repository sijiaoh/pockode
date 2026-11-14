import { JSONRPCErrorException, type JSONRPCRequester } from "json-rpc-2.0";
import type {
	CliProfile,
	CliProfileInspection,
	CliProfileRemoveRefusal,
	CliProfileRemoveRefusedReason,
	CliProfileUser,
} from "../../types/cliProfile";
import type { AgentType } from "../../types/settings";
import { profileParam } from "./cliAuth";
import { requireClient } from "./client";

/**
 * The `cli_profile.*` requests but the subscription, which is in wsStore with
 * the others. A change answers `{}`: the lists come back through
 * `cli_profile.changed`, read afresh by the server after the change.
 */
export interface CliProfileActions {
	/**
	 * Every profile of every CLI, or of `agent`, read afresh — or only
	 * `profileId` of `agent` (`DEFAULT_PROFILE_ID` for the default one), so
	 * that each profile's answer can land on its own.
	 */
	cliProfileInspect: (
		agent?: AgentType,
		profileId?: string,
	) => Promise<CliProfileInspection[]>;
	/** Adds a profile; it does not become current. */
	cliProfileAdd: (agent: AgentType, name: string) => Promise<CliProfile>;
	cliProfileRename: (
		agent: AgentType,
		profileId: string,
		name: string,
	) => Promise<void>;
	/** `DEFAULT_PROFILE_ID` switches to the default profile. */
	cliProfileSwitch: (agent: AgentType, profileId: string) => Promise<void>;
	/**
	 * Signs the profile out, then deletes it. Rejects with a refusal that
	 * `cliProfileRemoveRefusal` reads when the user can do something about it.
	 */
	cliProfileRemove: (agent: AgentType, profileId: string) => Promise<void>;
}

/** Where: server/rpc/types.go's CodeCLIProfileRemoveRefused. */
const CLI_PROFILE_REMOVE_REFUSED_CODE = -32014;

const REMOVE_REFUSED_REASONS: readonly string[] = [
	"current",
	"in_use",
	"signing_in",
	"updating",
	"removing",
	"sign_out_failed",
	"still_exiting",
] satisfies CliProfileRemoveRefusedReason[];

/**
 * Why the server refused to remove a profile, or null if the failure is
 * anything else. Recognised by the code and `data.reason`, never the message,
 * which is prose the server may reword — and which is kept for the reasons
 * whose detail only it has (`sign_out_failed` carries the CLI's error).
 */
export function cliProfileRemoveRefusal(
	error: unknown,
): CliProfileRemoveRefusal | null {
	if (
		!(error instanceof JSONRPCErrorException) ||
		error.code !== CLI_PROFILE_REMOVE_REFUSED_CODE
	) {
		return null;
	}
	const data = error.data as
		| { reason?: unknown; sessions?: unknown }
		| undefined;
	const reason = data?.reason;
	if (typeof reason !== "string" || !REMOVE_REFUSED_REASONS.includes(reason)) {
		return null;
	}
	return {
		reason: reason as CliProfileRemoveRefusedReason,
		sessions: Array.isArray(data?.sessions)
			? (data.sessions as CliProfileUser[])
			: [],
		message: error.message,
	};
}

/** Where: the JSON-RPC 2.0 internal-error code server/ws answers with. */
const INTERNAL_ERROR_CODE = -32603;

/**
 * Whether a failed removal may have taken the profile off the list first: the
 * server answers a directory it could not delete with an internal error
 * (docs/code/cli-profiles.md#removing-a-profile). A lost connection or a
 * refused request says nothing of the kind, even when the profile is gone
 * from the list by the time the failure is drawn.
 */
export function removalMayHaveLeftDirectory(error: unknown): boolean {
	return (
		error instanceof JSONRPCErrorException && error.code === INTERNAL_ERROR_CODE
	);
}

/**
 * @param getLongClient Requester for `inspect` and `remove`, for the reason
 * `cli_auth.status` and `cli_auth.logout` use it (lib/rpc/cliAuth.ts):
 * `inspect` is that status read, and `remove` waits for the profile's lock,
 * stops the CLIs running as it and signs it out — up to 65s
 * (docs/code/cli-profiles.md#removing-a-profile). The list changes answer at
 * once and keep the default.
 */
export function createCliProfileActions(
	getClient: () => JSONRPCRequester<void> | null,
	getLongClient: () => JSONRPCRequester<void> | null,
): CliProfileActions {
	return {
		cliProfileInspect: async (agent, profileId) => {
			const result: { profiles: CliProfileInspection[] } = await requireClient(
				getLongClient,
			).request("cli_profile.inspect", {
				...(agent ? { agent } : {}),
				...profileParam(profileId),
			});
			return result.profiles;
		},

		cliProfileAdd: async (agent, name) => {
			const result: { profile: CliProfile } = await requireClient(
				getClient,
			).request("cli_profile.add", { agent, name });
			return result.profile;
		},

		cliProfileRename: async (agent, profileId, name) => {
			await requireClient(getClient).request("cli_profile.rename", {
				agent,
				profile_id: profileId,
				name,
			});
		},

		cliProfileSwitch: async (agent, profileId) => {
			await requireClient(getClient).request("cli_profile.switch", {
				agent,
				profile_id: profileId,
			});
		},

		cliProfileRemove: async (agent, profileId) => {
			await requireClient(getLongClient).request("cli_profile.remove", {
				agent,
				profile_id: profileId,
			});
		},
	};
}
