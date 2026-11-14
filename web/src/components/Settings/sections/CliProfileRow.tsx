import { AlertTriangle, Info } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { getAgentLabel } from "../../../lib/agentType";
import {
	cliLoginActions,
	isLoginEnded,
	isStaleRead,
	useCliLoginStore,
} from "../../../lib/cliLoginStore";
import {
	chosenProfileIdOf,
	liveProfileName,
	profileKey,
	profileName,
} from "../../../lib/cliProfiles";
import type { CliAuthStatus } from "../../../types/cliAuth";
import {
	type CliProfileInspection,
	DEFAULT_PROFILE_ID,
} from "../../../types/cliProfile";
import type { AgentType } from "../../../types/settings";
import { errorMessage } from "../../../utils/errorMessage";
import {
	accountSummary,
	ExternalSource,
	externalSourceLabel,
} from "../../CliLogin/cliAuthText";
import { Spinner } from "../../ui";
import Skeleton from "../../ui/Skeleton";
import Tag from "../../ui/Tag";
import CliRow, { CliRowNotice, Dot } from "./CliRow";

/**
 * One account of a CLI as a row draws it — the same in Settings' list and in
 * the chat's switch sheet (docs/cli-profiles-ui.md#several-accounts).
 */
export interface ProfileView {
	agent: AgentType;
	id: string;
	name: string;
	/** The list's current account — not necessarily the one the CLI runs as. */
	current: boolean;
	/**
	 * The status to draw: the live read, or while the CLI is busy with
	 * something else (`wait`) the last one that said something of this account.
	 */
	status: CliAuthStatus | undefined;
	/** As `status`, with what the account does not share. */
	inspection: CliProfileInspection | undefined;
	/** This account is the one the CLI is signing in. */
	signingInHere: boolean;
	/** The CLI is busy with another account's sign-in, or with an update. */
	wait: "sign_in" | "update" | null;
	/** The account signing in, when another one is. */
	signingInName: string | undefined;
	/** This page started the running sign-in. */
	startedHere: boolean;
	/** The machine runs only the default account (`available: false`). */
	unusable: boolean;
	/** A read of this account is out. */
	reading: boolean;
	notInstalled: boolean;
}

/**
 * Reads one account's row from the store. `updating` and `notInstalled` are
 * the card's: the CLI's install row decides them.
 */
export function useProfileView(
	agent: AgentType,
	id: string,
	{ updating, notInstalled }: { updating: boolean; notInstalled: boolean },
): ProfileView {
	const overview = useCliLoginStore((s) => s.profiles);
	const live = useCliLoginStore((s) => s.inspections[agent]?.[id]);
	const settled = useCliLoginStore((s) => s.settledInspections[agent]?.[id]);
	const update = useCliLoginStore((s) => s.updates[agent]);
	const login = useCliLoginStore((s) => s.logins[agent]);
	const startedHere = useCliLoginStore((s) =>
		login ? s.startedHere.includes(login.id) : false,
	);
	const reading = useCliLoginStore((s) => !!s.inspecting[agent]?.[id]);

	const liveRead = isStaleRead(live?.status, update) ? undefined : live;
	const liveStatus = liveRead?.status;
	const loginRunning = !!login && !isLoginEnded(login);
	const signingProfile = loginRunning
		? profileKey(login.profile_id)
		: liveStatus?.state === "signing_in"
			? profileKey(liveStatus.login_profile_id)
			: undefined;
	const signingInHere = signingProfile === id;
	const wait =
		updating || liveStatus?.state === "updating"
			? "update"
			: signingProfile !== undefined && !signingInHere
				? "sign_in"
				: null;
	// A read from before the CLI was installed, being read again: it is not
	// drawn, or the row would say "Not installed" under a CLI that is there.
	const preInstall =
		!notInstalled && reading && liveStatus?.state === "not_installed";
	const inspection = wait ? settled : preInstall ? undefined : liveRead;

	return {
		agent,
		id,
		name: profileName(overview, agent, id),
		current: chosenProfileIdOf(overview, agent) === id,
		status: inspection?.status,
		inspection,
		signingInHere,
		wait,
		signingInName:
			signingProfile !== undefined && !signingInHere
				? liveProfileName(overview, agent, signingProfile)
				: undefined,
		startedHere,
		unusable: !!overview && !overview.available && id !== DEFAULT_PROFILE_ID,
		notInstalled: notInstalled && wait !== "update",
		reading,
	};
}

/** What the row asks of the user next, if anything; the caller draws it. */
export type ProfileNeed = "continue" | "sign_in" | "retry" | null;

export function profileNeed(view: ProfileView): ProfileNeed {
	if (view.signingInHere) return "continue";
	if (view.wait || view.notInstalled || view.unusable) return null;
	switch (view.status?.state) {
		case "signed_out":
			return "sign_in";
		case "unavailable":
			return "retry";
		default:
			return null;
	}
}

/**
 * Whether the row offers Switch beside it: an account sessions could run as.
 * Switching to one that is not signed in is the menu's (the row says what is
 * missing instead).
 */
export function offersSwitch(view: ProfileView): boolean {
	return (
		!view.current &&
		(view.status?.state === "signed_in" || view.status?.state === "external")
	);
}

/**
 * Switching accounts, from a row's button or a menu: one switch at a time per
 * place it is offered, and its failure on the row it was pressed on. A switch
 * counts as running until the pushed list has moved "Current" — to it, or
 * anywhere else, should another switch have landed — or the list stops being
 * followed: "Current" moves only then, and a Switch pressable again before it
 * would invite a second. Not merely until the next push: the server sends the
 * unchanged list again whenever another page subscribes.
 */
export function useProfileSwitch(agent: AgentType) {
	const chosen = useCliLoginStore((s) => chosenProfileIdOf(s.profiles, agent));
	const listLost = useCliLoginStore((s) => !!s.profilesError);
	const [inFlight, setInFlight] = useState<string | null>(null);
	// The switch answered; "Current" is still where it was when it was pressed.
	const [awaiting, setAwaiting] = useState<{
		id: string;
		over: string | undefined;
	} | null>(null);
	const [error, setError] = useState<{ id: string; message: string } | null>(
		null,
	);
	// Settled once: "Current" coming back later — switched back elsewhere, or
	// a list followed again — is not this switch running.
	const settled = !!awaiting && (listLost || chosen !== awaiting.over);
	useEffect(() => {
		if (settled) setAwaiting(null);
	}, [settled]);
	const switchTo = async (id: string): Promise<boolean> => {
		const state = useCliLoginStore.getState();
		const over = chosenProfileIdOf(state.profiles, agent);
		setInFlight(id);
		setAwaiting(null);
		setError(null);
		try {
			await cliLoginActions.switchProfile(agent, id);
			// Without a list followed there is no push to wait for.
			if (state.profiles && over !== id) setAwaiting({ id, over });
			return true;
		} catch (err) {
			setError({ id, message: errorMessage(err) });
			return false;
		} finally {
			setInFlight(null);
		}
	};
	return {
		/** The account being switched to. */
		switching: inFlight ?? (awaiting && !settled ? awaiting.id : null),
		errorFor: (id: string) => (error?.id === id ? error.message : null),
		switchTo,
	};
}

interface Props {
	view: ProfileView;
	/** Every account reads the same `external`: the card says it once. */
	sharedExternal?: boolean;
	/** After the state, for a fact from elsewhere: "Turned away this turn". */
	subtitleSuffix?: string;
	/** The one button beside the line. */
	action?: ReactNode;
	/** The `⋯`, after `action`. */
	menu?: ReactNode;
	/** An action's error on this account. */
	error?: string | null;
	/** Why the running sign-in could not be followed. */
	loginError?: string;
	/** More said on the row, such as a refused removal. */
	extraNotice?: ReactNode;
}

/** One account of a CLI, in a box of the card's row height. */
export default function CliProfileRow({
	view,
	sharedExternal,
	subtitleSuffix,
	action,
	menu,
	error,
	loginError,
	extraNotice,
}: Props) {
	const label = getAgentLabel(view.agent);
	const { icon, subtitle, dimmed, notices } = describe(view, {
		label,
		sharedExternal: !!sharedExternal,
		loginError,
	});
	const slot =
		action || menu ? (
			<>
				{action}
				{menu}
			</>
		) : undefined;
	return (
		<CliRow
			icon={icon}
			title={view.name}
			tag={view.current ? <Tag label="Current" /> : undefined}
			subtitle={
				subtitle === undefined ? (
					<Skeleton
						className="my-0.5 h-3 w-40 max-w-full rounded"
						label={`Checking ${view.name} sign-in status`}
					/>
				) : subtitleSuffix ? (
					`${subtitle} · ${subtitleSuffix}`
				) : (
					subtitle
				)
			}
			dimmed={dimmed}
			action={slot}
			notice={
				<>
					{notices}
					{extraNotice}
					<CliRowNotice error={error} />
				</>
			}
		/>
	);
}

function describe(
	view: ProfileView,
	{
		label,
		sharedExternal,
		loginError,
	}: { label: string; sharedExternal: boolean; loginError?: string },
): {
	icon?: ReactNode;
	/** Undefined while the read is out. */
	subtitle: string | undefined;
	dimmed?: boolean;
	notices?: ReactNode;
} {
	if (view.notInstalled) {
		return {
			icon: <Dot className="text-th-text-muted" />,
			subtitle: `Available once ${label} is installed`,
			dimmed: true,
		};
	}
	if (view.signingInHere) {
		return {
			icon: <Spinner srText={null} />,
			subtitle: view.startedHere
				? "Signing in…"
				: "Signing in… · started earlier",
			notices: loginError ? (
				<CliRowNotice
					body={`Couldn't follow this sign-in: ${loginError}. Refresh to check.`}
				/>
			) : undefined,
		};
	}
	// Before the waits: such an account never runs the CLI, so it has nothing
	// to wait for.
	if (view.unusable) {
		return {
			icon: <Dot className="text-th-text-muted" />,
			subtitle: "Can't be used on this machine",
			dimmed: true,
		};
	}
	if (view.wait) {
		const after = view.wait === "update" ? "the update" : "the sign-in";
		// A reload mid-wait: there is no earlier read to keep.
		if (!view.status) return { subtitle: `Checked after ${after}.` };
		return {
			icon: stateIcon(view.status),
			subtitle: `Wait for ${after} to finish.`,
		};
	}
	const status = view.status;
	if (!status) return { subtitle: undefined };

	const notices: ReactNode[] = [];
	if (status.state === "external" && !sharedExternal) {
		notices.push(
			<CliRowNotice
				key="external"
				body={<ExternalSource agent={view.agent} external={status.external} />}
			/>,
		);
	}
	if (status.state === "unavailable" && status.error) {
		notices.push(<CliRowNotice key="error" body={status.error} />);
	}
	const conflicts = view.inspection?.conflicts ?? [];
	if (conflicts.length > 0) {
		const count =
			conflicts.length === 1 ? "1 item" : `${conflicts.length} items`;
		notices.push(
			<CliRowNotice
				key="conflicts"
				body={
					<>
						<AlertTriangle
							className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-th-warning"
							aria-hidden="true"
						/>
						{view.name} doesn't share {count} with your other accounts. Pockode
						found {view.name}'s own copy where a link belongs and left it alone.
						Move or delete the copy on the server, then Refresh.
					</>
				}
				details={conflicts.map((c) => `${c.name} · ${c.path}`).join("\n")}
			/>,
		);
	} else if (view.inspection?.conflicts_error) {
		notices.push(
			<CliRowNotice
				key="conflicts"
				body={`Couldn't check what ${view.name} shares: ${view.inspection.conflicts_error}`}
			/>,
		);
	}

	return {
		icon: stateIcon(status),
		subtitle: stateLine(status),
		notices,
	};
}

function stateIcon(status: CliAuthStatus): ReactNode {
	switch (status.state) {
		case "signed_in":
			return <Dot className="text-th-success" filled />;
		case "signed_out":
		case "not_installed":
			return <Dot className="text-th-text-muted" />;
		case "external":
			return <Info className="h-4 w-4 text-th-text-muted" />;
		default:
			return <AlertTriangle className="h-4 w-4 text-th-error" />;
	}
}

function stateLine(status: CliAuthStatus): string {
	switch (status.state) {
		case "signed_in":
			return accountSummary(status.account) || "Signed in";
		case "signed_out":
			return "Not signed in";
		case "external":
			return `Managed outside Pockode · ${externalSourceLabel(status.external)}`;
		case "not_installed":
			return "Not installed";
		default:
			return "Couldn't read sign-in status";
	}
}
