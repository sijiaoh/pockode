import type { CliAuthStatus, CliExternal } from "../types/cliAuth";
import {
	type CliProfileOverview,
	type CliProfileRemoveRefusal,
	DEFAULT_PROFILE_ID,
} from "../types/cliProfile";
import type { AgentType } from "../types/settings";

// Reading the profile lists and the statuses read for them. Pure: the state
// is in cliLoginStore. The contract is docs/code/cli-profiles.md#the-rpc.

/** The profile an optional `profile_id` names: absent is the default one. */
export function profileKey(profileId: string | undefined): string {
	return profileId ?? DEFAULT_PROFILE_ID;
}

/** The CLI's profiles to show, the default one first; just it with no list. */
export function profileIdsOf(
	overview: CliProfileOverview | null,
	agent: AgentType,
): string[] {
	const list = overview?.clis.find((c) => c.agent === agent);
	return [DEFAULT_PROFILE_ID, ...(list?.profiles.map((p) => p.id) ?? [])];
}

/**
 * The profile chosen as the CLI's current one, or undefined until a list has
 * been heard. Where profiles cannot be used it is not the one the CLI runs as
 * (`currentProfileIdOf`), but it is still the choice: the list is shared with
 * every Pockode process of the OS user, and one that can use profiles follows
 * it.
 */
export function chosenProfileIdOf(
	overview: CliProfileOverview | null,
	agent: AgentType,
): string | undefined {
	if (!overview) return undefined;
	const list = overview.clis.find((c) => c.agent === agent);
	return profileKey(list?.current_profile_id);
}

/**
 * The profile the CLI runs as — what sessions use and what a status read for
 * "current" answers for: the chosen one, or the default one where profiles
 * cannot be used. Undefined until a list has been heard.
 */
export function currentProfileIdOf(
	overview: CliProfileOverview | null,
	agent: AgentType,
): string | undefined {
	if (overview && !overview.available) return DEFAULT_PROFILE_ID;
	return chosenProfileIdOf(overview, agent);
}

/** Whether the CLI has any profile beyond its default one. */
export function hasStoredProfiles(
	overview: CliProfileOverview | null,
	agent: AgentType,
): boolean {
	return profileIdsOf(overview, agent).length > 1;
}

/**
 * The account a record names, looked up now — a record keeps only the id.
 * - `unknown`: the record predates accounts (no `profile_id`).
 * - `removed`: an id the list no longer has.
 * - null: a stored profile's id, and no list heard yet to look it up in.
 */
export type RecordedProfile =
	| { kind: "unknown" }
	| { kind: "default" }
	| { kind: "named"; name: string }
	| { kind: "removed" };

export function recordedProfile(
	overview: CliProfileOverview | null,
	agent: AgentType,
	profileId: string | undefined,
): RecordedProfile | null {
	if (profileId === undefined) return { kind: "unknown" };
	if (profileId === DEFAULT_PROFILE_ID) return { kind: "default" };
	if (!overview) return null;
	const profile = overview.clis
		.find((c) => c.agent === agent)
		?.profiles.find((p) => p.id === profileId);
	return profile ? { kind: "named", name: profile.name } : { kind: "removed" };
}

/**
 * Whether this status's own profile is the one signing in. While a CLI signs
 * in, every profile of it reads `signing_in`; the others are only waiting for
 * it, and must not be drawn as signing in.
 */
export function isSigningInHere(status: CliAuthStatus): boolean {
	return (
		status.state === "signing_in" &&
		profileKey(status.login_profile_id) === profileKey(status.profile_id)
	);
}

/**
 * The credentials every profile of a CLI reads as alike, when they do: they
 * come from the environment or shared configuration, so whichever profile is
 * current, sessions use them and switching changes nothing. Null with fewer
 * than two profiles, or when any profile reads otherwise — `external` on one
 * profile only is that profile's own sign-in.
 */
export function sharedExternal(
	statuses: readonly CliAuthStatus[],
): CliExternal | null {
	if (statuses.length < 2) return null;
	const [first, ...rest] = statuses;
	if (first.state !== "external" || !first.external) return null;
	const same = (e: CliExternal | undefined) =>
		!!e &&
		e.kind === first.external?.kind &&
		e.source === first.external.source &&
		e.provider === first.external.provider &&
		e.method === first.external.method;
	return rest.every((s) => s.state === "external" && same(s.external))
		? first.external
		: null;
}

/**
 * `sharedExternal` over the CLI's profiles `ids` as last inspected.
 * Undefined while the answer depends on a read still out; a read that rules
 * "every profile alike" out settles it at once, so one slow profile does not
 * hold up the answer when another already differs.
 */
export function profilesSharedExternal(
	ids: readonly string[],
	inspections: Record<string, { status: CliAuthStatus }> | undefined,
): CliExternal | null | undefined {
	const answered = ids.flatMap((id) => {
		const status = inspections?.[id]?.status;
		return status ? [status] : [];
	});
	if (answered.length > 0 && !sharedExternal([answered[0], ...answered])) {
		return null;
	}
	if (answered.length < ids.length) return undefined;
	return sharedExternal(answered);
}

/** The word for the default profile, which has no name of its own. */
export const DEFAULT_PROFILE_NAME = "Default";

/**
 * The account's name for the screen: "Default", the stored name, or "a
 * removed account" for an id the list no longer has (or has not been heard).
 */
export function profileName(
	overview: CliProfileOverview | null,
	agent: AgentType,
	profileId: string,
): string {
	const recorded = recordedProfile(overview, agent, profileId);
	switch (recorded?.kind) {
		case "default":
			return DEFAULT_PROFILE_NAME;
		case "named":
			return recorded.name;
		default:
			return "a removed account";
	}
}

/**
 * The name of an account live state names — a running sign-in's. Undefined
 * when the list does not have it: changes another Pockode process makes are
 * not pushed, so an id missing here may well exist, and live state must not
 * call it removed.
 */
export function liveProfileName(
	overview: CliProfileOverview | null,
	agent: AgentType,
	profileId: string,
): string | undefined {
	const recorded = recordedProfile(overview, agent, profileId);
	return recorded?.kind === "default" || recorded?.kind === "named"
		? profileName(overview, agent, profileId)
		: undefined;
}

/** Why a machine has only the default accounts, for the user. */
export function unavailableText(reason: string | undefined): string {
	return ["This machine can only use each CLI's default account.", reason]
		.filter(Boolean)
		.join(" ");
}

/** What a refused `cli_profile.remove` says on the account's row. */
export interface RemoveRefusalCopy {
	body: string;
	/** The server's whole message, for a reason whose detail only it has. */
	details?: string;
}

/**
 * The words for each `-32014` reason (docs/cli-profiles-ui.md#removing). A
 * reason this build does not know is no `CliProfileRemoveRefusal`, so the
 * caller shows the server's message for it, as for any other error.
 *
 * @param signingIn The name of the account the CLI is signing in, when it is
 * another one than `name` and live status said which.
 * @param notInstalled The CLI's status reads `not_installed`.
 */
export function removeRefusalText(
	refusal: CliProfileRemoveRefusal,
	parts: {
		label: string;
		name: string;
		signingIn?: string;
		notInstalled?: boolean;
	},
): RemoveRefusalCopy {
	const { label, name } = parts;
	switch (refusal.reason) {
		case "current":
			return {
				body: `${name} is the current account. Switch to another account first, then remove it.`,
			};
		case "in_use": {
			const count = refusal.sessions.length;
			const sessions = count === 1 ? "1 session" : `${count} sessions`;
			return {
				body: `${name} is still running a turn in ${sessions}. Idle sessions on it were stopped. Try again once the turn finishes.`,
			};
		}
		case "signing_in":
			return {
				body: parts.signingIn
					? `${label} is signing in ${parts.signingIn}. Finish or cancel that sign-in, then try again.`
					: `${label} is signing in. Finish or cancel that sign-in, then try again.`,
			};
		case "updating":
			return { body: `${label} is being updated. Try again when it's done.` };
		case "removing":
			return { body: `${name} is already being removed.` };
		case "sign_out_failed":
			return parts.notInstalled
				? {
						body: `${label} isn't installed, so ${name} can't be signed out first. Install ${label}, then remove it.`,
					}
				: {
						body: `Pockode couldn't sign ${name} out, so it kept the account. Its sign-in has to be removed first, or it stays on this machine.`,
						details: refusal.message,
					};
		case "still_exiting":
			return {
				body: `Sessions on ${name} are still stopping. Try again in a few seconds.`,
			};
	}
}
