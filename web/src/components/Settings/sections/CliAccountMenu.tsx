import { ArrowLeftRight, LogIn, LogOut, Pencil, Trash2 } from "lucide-react";
import { getAgentLabel } from "../../../lib/agentType";
import { DEFAULT_PROFILE_ID } from "../../../types/cliProfile";
import MenuRow from "../../common/MenuRow";
import { Sheet } from "../../ui";
import type { ProfileView } from "./CliProfileRow";

interface Props {
	view: ProfileView;
	/** A switch is running on the card. */
	switching: boolean;
	onClose: () => void;
	onSwitch: () => void;
	onSignIn: () => void;
	onSignOut: () => void;
	onRename: () => void;
	onRemove: () => void;
}

/**
 * An account's `⋯` (docs/cli-profiles-ui.md#the-accounts-menu-): a sheet that
 * closes on whichever action is taken. An item that never applies is absent;
 * one that applies but not now says why.
 */
export default function CliAccountMenu({
	view,
	switching,
	onClose,
	onSwitch,
	onSignIn,
	onSignOut,
	onRename,
	onRemove,
}: Props) {
	const act = (run: () => void) => () => {
		onClose();
		run();
	};
	const state = view.status?.state;
	const stored = view.id !== DEFAULT_PROFILE_ID;
	// Anything that runs the CLI waits for what is holding it.
	const busyReason =
		view.wait === "update"
			? "Wait for the update to finish."
			: view.wait === "sign_in"
				? view.signingInName
					? `Wait for ${view.signingInName}'s sign-in to finish.`
					: "Wait for the sign-in to finish."
				: undefined;

	return (
		<Sheet
			title={`${getAgentLabel(view.agent)} · ${view.name}`}
			onClose={onClose}
		>
			<div className="py-1">
				{!view.current && (
					<MenuRow
						icon={ArrowLeftRight}
						label="Switch to this account"
						description={
							switching ? "Wait for the switch to finish." : undefined
						}
						disabled={switching}
						onClick={act(onSwitch)}
					/>
				)}
				{state === "signed_out" && !view.signingInHere && (
					<MenuRow
						icon={LogIn}
						label="Sign in"
						description={busyReason}
						disabled={!!busyReason}
						onClick={act(onSignIn)}
					/>
				)}
				{state === "signed_in" && (
					<MenuRow
						icon={LogOut}
						label="Sign out"
						description={
							view.wait === "sign_in"
								? "Wait for the sign-in to finish."
								: busyReason
						}
						disabled={!!busyReason}
						onClick={act(onSignOut)}
					/>
				)}
				{stored && (
					<>
						<MenuRow icon={Pencil} label="Rename…" onClick={act(onRename)} />
						<div className="my-1 border-t border-th-border" />
						<MenuRow
							icon={Trash2}
							label="Remove account…"
							danger
							description={
								view.current ? "Switch to another account first." : undefined
							}
							disabled={view.current}
							onClick={act(onRemove)}
						/>
					</>
				)}
			</div>
		</Sheet>
	);
}
