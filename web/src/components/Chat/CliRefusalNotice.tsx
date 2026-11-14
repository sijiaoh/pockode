import { AlertTriangle } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { getAgentLabel } from "../../lib/agentType";
import { cliLoginActions, useCliLoginStore } from "../../lib/cliLoginStore";
import {
	currentProfileIdOf,
	hasStoredProfiles,
	profileIdsOf,
	profileName,
	profilesSharedExternal,
	recordedProfile,
} from "../../lib/cliProfiles";
import { DEFAULT_PROFILE_ID } from "../../types/cliProfile";
import type { CliRefusal } from "../../utils/cliRefusal";
import { ExternalSource } from "../CliLogin/cliAuthText";

export interface CliRefusalNoticeProps {
	/** The refusal in the CLI's own words. */
	message: string;
	refusal: CliRefusal;
	/**
	 * Opens the sign-in for `account`, or for the current one when the CLI
	 * has no accounts beyond its default one. Absent where nothing can be
	 * signed in from (a viewed session).
	 */
	onSignIn?: (account?: { id: string; name: string }) => void;
	/** Opens the switch sheet. A switch is global, not the session's. */
	onSwitchAccount?: () => void;
	/**
	 * What the record is drawn as when the notice has nothing to add: a usage
	 * limit on a CLI with one account, as it was before accounts.
	 */
	plain: ReactNode;
}

const buttonClass =
	"inline-flex min-h-9 items-center rounded-lg bg-th-bg-tertiary px-3 text-th-text-primary transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-th-accent pointer-coarse:min-h-11";

/**
 * A turn that failed — or is failing — because the CLI was turned away, for
 * its credentials or for rate limits, with the ways out: switching to another
 * account, or signing in (docs/cli-profiles-ui.md#the-notice).
 *
 * The record says which CLI and account were turned away, then. Everything
 * else — the account's name, which account is current, whether there is
 * anything to sign in to or switch to — is read live: a record that says
 * "current" would be stale the moment the user switched.
 */
export default function CliRefusalNotice({
	message,
	refusal,
	onSignIn,
	onSwitchAccount,
	plain,
}: CliRefusalNoticeProps) {
	const { agent, kind, profileId } = refusal;
	const label = getAgentLabel(agent);
	const overview = useCliLoginStore((s) => s.profiles);
	// A list that could not be had reads as one account: today's notice.
	const listKnown = useCliLoginStore((s) => !!s.profiles || !!s.profilesError);
	const multi = hasStoredProfiles(overview, agent);
	const available = overview?.available ?? false;
	const ids = profileIdsOf(overview, agent);
	const listed = ids.join("\u0000");

	// Who a sign-in is for: the account the record names while it exists and
	// this machine can run it, otherwise the one sessions use now — signing in
	// an account nothing runs as would not fix the next turn.
	const recorded = recordedProfile(overview, agent, profileId);
	const targetId =
		available && (recorded?.kind === "default" || recorded?.kind === "named")
			? profileId
			: currentProfileIdOf(overview, agent);
	const wantsSignIn = kind === "auth" && !!onSignIn;
	// Whether every account reads alike is only asked where a switch could be
	// offered; it needs each account read once.
	const judgesSwitch = multi && available && !!onSwitchAccount;

	useEffect(() => {
		if (!listKnown) return;
		if (!multi) {
			if (wantsSignIn) cliLoginActions.ensureStatus(agent);
			return;
		}
		// Once per account for every notice on screen: the store keeps the
		// reads, and the sheets read afresh when they open.
		if (judgesSwitch) {
			for (const id of listed.split("\u0000")) {
				cliLoginActions.ensureInspection(agent, id);
			}
		} else if (wantsSignIn && targetId !== undefined) {
			cliLoginActions.ensureInspection(agent, targetId);
		}
	}, [agent, listKnown, multi, wantsSignIn, judgesSwitch, listed, targetId]);

	const inspections = useCliLoginStore((s) => s.inspections[agent]);
	const currentStatus = useCliLoginStore((s) => s.statuses[agent]);
	const targetStatus = multi
		? targetId === undefined
			? undefined
			: inspections?.[targetId]?.status
		: currentStatus;
	const shared = judgesSwitch ? profilesSharedExternal(ids, inspections) : null;
	// Each button waits for what it depends on, so neither appears only to
	// vanish.
	const offerSwitch = judgesSwitch && shared === null;
	const external = shared ?? undefined;
	const targetExternal =
		!external && targetStatus?.state === "external"
			? targetStatus.external
			: undefined;
	const offerSignIn =
		wantsSignIn && listKnown && !!targetStatus && !shared && !targetExternal;

	// One account, or one usable here: a usage limit is the warning or error
	// it always was, with nothing to switch to.
	if (kind === "usage_limit" && !(multi && available)) return <>{plain}</>;

	// The account the record names, in today's sentence: nothing when the
	// record predates accounts (guessing the current one would read state out
	// of an event), nor for the default one of a CLI that has no other.
	const clause =
		overview &&
		profileId !== undefined &&
		(multi || profileId !== DEFAULT_PROFILE_ID)
			? ` as ${profileName(overview, agent, profileId)}`
			: "";

	const signIn = () => {
		if (!onSignIn) return;
		// Where accounts can't be used the sign-in is today's, of the account
		// the CLI runs as: naming it would offer switching to it, which changes
		// nothing here.
		if (multi && available && targetId !== undefined) {
			onSignIn({ id: targetId, name: profileName(overview, agent, targetId) });
		} else {
			onSignIn();
		}
	};

	return (
		<div className="flex items-start gap-2 rounded bg-th-warning/10 p-2 text-sm">
			<AlertTriangle className="size-4 shrink-0 text-th-warning" />
			<div className="min-w-0 flex-1 space-y-1">
				<p className="break-words text-th-warning">{message}</p>
				<p className="text-th-text-secondary">
					{kind === "auth"
						? `${label} couldn't authenticate${clause} when this turn ran.`
						: `${label}'s requests${clause} were turned away for rate limits when this turn ran.`}
					{kind === "usage_limit" &&
						offerSwitch &&
						" If it's the account's usage limit, switch to another account and send again."}
				</p>
				{(external || (kind === "auth" && targetExternal)) && (
					<p className="text-th-text-secondary">
						<ExternalSource
							agent={agent}
							external={external ?? targetExternal}
							shared={!!external}
						/>
					</p>
				)}
				{(offerSwitch || offerSignIn) && (
					<div className="flex flex-wrap justify-end gap-2">
						{offerSwitch && (
							<button
								type="button"
								onClick={onSwitchAccount}
								className={buttonClass}
							>
								Switch account
							</button>
						)}
						{offerSignIn && (
							<button type="button" onClick={signIn} className={buttonClass}>
								Sign in to {label}
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
