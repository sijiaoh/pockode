import { type ReactNode, useEffect } from "react";
import { useCliLoginSubscription } from "../../hooks/useCliLoginSubscription";
import { useCliProfileSubscription } from "../../hooks/useCliProfileSubscription";
import { getAgentLabel } from "../../lib/agentType";
import { cliLoginActions, useCliLoginStore } from "../../lib/cliLoginStore";
import {
	chosenProfileIdOf,
	profileIdsOf,
	recordedProfile,
} from "../../lib/cliProfiles";
import type { AgentType } from "../../types/settings";
import CliProfileRow, {
	profileNeed,
	useProfileSwitch,
	useProfileView,
} from "../Settings/sections/CliProfileRow";
import { Sheet, Spinner } from "../ui";
import type { SendAgainOffer } from "./CliLoginSheet";
import {
	primaryButtonClass,
	secondaryButtonClass,
	useSendAgainParts,
} from "./loginParts";

export interface CliAccountSwitchSheetProps {
	agent: AgentType;
	/**
	 * The account a record names — the one a turn was refused as; undefined
	 * for a record kept before accounts were. While it still exists its row
	 * carries `recordedNote` after its state.
	 */
	recordedProfileId?: string;
	/** A fact from the record, in the past: "Turned away this turn". */
	recordedNote?: string;
	onClose: () => void;
	/**
	 * Signs an account in. Sheets don't nest, so the caller replaces this
	 * sheet with `CliLoginSheet` for the account. Absent where nothing is
	 * signed in from (a viewed session): the rows then offer Use alone.
	 */
	onSignIn?: (account: { id: string; name: string }) => void;
	/**
	 * The chat's Send again, for the turn the sheet was opened from when its
	 * message can be put back. Offered only once the current account could
	 * take it: signed in, and not the account the record names — sending again
	 * as the account just turned away is what the user came here to avoid.
	 */
	sendAgain?: SendAgainOffer;
}

/**
 * Picks the CLI's current account, and does nothing else
 * (docs/cli-profiles-ui.md#the-switch-sheet): the rows are Settings', with
 * **Use** instead of a menu. Nothing switches on opening, and closing changes
 * nothing. A switch is global — every session on this machine — so the sheet
 * says so before anything can be pressed.
 */
export default function CliAccountSwitchSheet({
	agent,
	recordedProfileId,
	recordedNote,
	onClose,
	onSignIn,
	sendAgain,
}: CliAccountSwitchSheetProps) {
	useCliProfileSubscription();
	useCliLoginSubscription(agent);
	const label = getAgentLabel(agent);
	const listed = useCliLoginStore((s) =>
		profileIdsOf(s.profiles, agent).join("\u0000"),
	);
	const ids = listed.split("\u0000");
	const updating = useCliLoginStore(
		(s) => s.updates[agent]?.phase === "running",
	);
	const { switching, errorFor, switchTo } = useProfileSwitch(agent);
	// A removed account is no row to note, and no account to keep from: the
	// sheet then works as for a record that names none.
	const recordedId = useCliLoginStore((s) => {
		const recorded = recordedProfile(s.profiles, agent, recordedProfileId);
		return recorded?.kind === "default" || recorded?.kind === "named"
			? recordedProfileId
			: undefined;
	});
	const currentReady = useCliLoginStore((s) => {
		const current = chosenProfileIdOf(s.profiles, agent);
		if (current === undefined || current === recordedId) return false;
		const state = s.inspections[agent]?.[current]?.status.state;
		return state === "signed_in" || state === "external";
	});
	const sendAgainParts = useSendAgainParts(
		currentReady ? sendAgain : undefined,
	);

	// Live state, read as the sheet opens: what it offers is a choice made now.
	useEffect(() => {
		void cliLoginActions.inspectProfiles(agent);
	}, [agent]);
	// And an account the list names only now — the first list to arrive.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `listed` is what changes the accounts to read
	useEffect(() => {
		for (const id of profileIdsOf(
			useCliLoginStore.getState().profiles,
			agent,
		)) {
			cliLoginActions.ensureInspection(agent, id);
		}
	}, [agent, listed]);

	return (
		<Sheet
			title={`Switch ${label} account`}
			onClose={onClose}
			footer={
				<>
					<button
						type="button"
						onClick={onClose}
						className={`${sendAgainParts.button ? secondaryButtonClass : primaryButtonClass} flex-1`}
					>
						Done
					</button>
					{sendAgainParts.button}
				</>
			}
		>
			<div className="space-y-2 p-4">
				<p className="text-sm text-th-text-secondary">
					Sessions use the current account from their next message, in every
					project on this machine.
				</p>
				<div className="space-y-1">
					{ids.map((id) => (
						<SwitchRow
							key={id}
							agent={agent}
							id={id}
							updating={updating}
							note={id === recordedId ? recordedNote : undefined}
							switching={switching}
							error={errorFor(id)}
							onUse={() => void switchTo(id)}
							onSignIn={onSignIn}
						/>
					))}
				</div>
				{sendAgainParts.note}
			</div>
		</Sheet>
	);
}

function SwitchRow({
	agent,
	id,
	updating,
	note,
	switching,
	error,
	onUse,
	onSignIn,
}: {
	agent: AgentType;
	id: string;
	updating: boolean;
	note: string | undefined;
	switching: string | null;
	error: string | null;
	onUse: () => void;
	onSignIn?: (account: { id: string; name: string }) => void;
}) {
	const view = useProfileView(agent, id, { updating, notInstalled: false });
	const need = profileNeed(view);

	let action: ReactNode;
	if (switching === id) {
		action = <Spinner srText={`Switching to ${view.name}`} />;
	} else if (!view.current) {
		action = (
			<button
				type="button"
				onClick={onUse}
				aria-label={`Use ${view.name}`}
				disabled={switching !== null}
				className={secondaryButtonClass}
			>
				Use
			</button>
		);
	} else if (onSignIn && (need === "sign_in" || need === "continue")) {
		action = (
			<button
				type="button"
				onClick={() => onSignIn({ id, name: view.name })}
				aria-label={`${need === "continue" ? "Continue signing in" : "Sign in"} ${view.name}`}
				className={primaryButtonClass}
			>
				{need === "continue" ? "Continue" : "Sign in"}
			</button>
		);
	} else if (need === "retry") {
		action = (
			<button
				type="button"
				onClick={() => void cliLoginActions.inspectProfile(agent, id)}
				disabled={view.reading}
				aria-label={`Retry reading ${view.name}`}
				className={primaryButtonClass}
			>
				Retry
			</button>
		);
	}

	return (
		<CliProfileRow
			view={view}
			subtitleSuffix={note}
			action={action}
			error={error}
		/>
	);
}
