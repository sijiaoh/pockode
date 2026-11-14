import { ConfirmDialog } from "@pockode/shared";
import { Ellipsis, Info } from "lucide-react";
import { useState } from "react";
import { getAgentLabel } from "../../../lib/agentType";
import {
	cliLoginActions,
	isLoginEnded,
	useCliLoginStore,
} from "../../../lib/cliLoginStore";
import {
	chosenProfileIdOf,
	liveProfileName,
	profileIdsOf,
	profileKey,
	profilesSharedExternal,
	removeRefusalText,
} from "../../../lib/cliProfiles";
import {
	cliProfileRemoveRefusal,
	removalMayHaveLeftDirectory,
} from "../../../lib/rpc";
import { DEFAULT_PROFILE_ID } from "../../../types/cliProfile";
import type { AgentType } from "../../../types/settings";
import { errorMessage } from "../../../utils/errorMessage";
import { ExternalSource } from "../../CliLogin/cliAuthText";
import {
	cardTextButtonClass,
	primaryButtonClass,
	secondaryButtonClass,
} from "../../CliLogin/loginParts";
import { Spinner } from "../../ui";
import { iconButtonClass } from "../../ui/iconButtonClass";
import CliAccountMenu from "./CliAccountMenu";
import CliProfileRow, {
	offersSwitch,
	type ProfileView,
	profileNeed,
	useProfileSwitch,
	useProfileView,
} from "./CliProfileRow";
import { CliRowNotice } from "./CliRow";

export interface SignInAccount {
	id: string;
	name: string;
}

interface Props {
	agent: AgentType;
	/** The CLI is being replaced: nothing that runs it is offered. */
	updating: boolean;
	/** There is no CLI to sign in to. */
	notInstalled: boolean;
	/** Opens the sign-in sheet for the account. */
	onOpenSignIn: (account: SignInAccount) => void;
	/** Opens the name sheet to rename the account. */
	onRename: (account: SignInAccount) => void;
}

/**
 * An action's failure on an account. `basis` is the row's state when it was
 * pressed: once that has moved on, a "sign-out failed" under "Not signed in"
 * would lie, so it is no longer drawn.
 */
type RowError = { name: string; basis: string } & (
	| { kind: "message"; text: string }
	| { kind: "refusal"; body: string; details?: string }
	/** A removal that failed after taking the account off the list. */
	| { kind: "remove_failed"; text: string }
);

function basisOf(view: ProfileView): string {
	// The wait too: a "signing in" or "updating" refusal is stale once the
	// sign-in or update is over, even when the account reads as it did.
	return `${view.status?.state}|${view.current}|${view.wait}`;
}

function withId(set: ReadonlySet<string>, id: string, on: boolean) {
	const next = new Set(set);
	if (on) next.add(id);
	else next.delete(id);
	return next;
}

/**
 * The accounts of a CLI with stored profiles, one row each, in place of the
 * one-account card's row (docs/cli-profiles-ui.md#several-accounts). Every
 * call it makes names its account: an action pressed on a row must not land
 * on another one because the current account moved meanwhile.
 */
export default function CliAccountList({
	agent,
	updating,
	notInstalled,
	onOpenSignIn,
	onRename,
}: Props) {
	const label = getAgentLabel(agent);
	const overview = useCliLoginStore((s) => s.profiles);
	const ids = profileIdsOf(overview, agent);
	const available = overview?.available ?? true;
	const loginError = useCliLoginStore((s) => s.loginErrors[agent]);
	// Live reads only, and all of them: the judgement waits for every row.
	const liveStatuses = useCliLoginStore((s) => s.inspections[agent]);
	const shared = profilesSharedExternal(ids, liveStatuses) ?? null;

	const { switching, errorFor, switchTo } = useProfileSwitch(agent);
	// Per account: removals take up to 65s, and another may start meanwhile.
	const [signingOut, setSigningOut] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	// Kept after a removal succeeds, until the pushed list drops the account:
	// the row is not drawn as an account again in between.
	const [removing, setRemoving] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [errors, setErrors] = useState<Record<string, RowError>>({});
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [confirmingSignOut, setConfirmingSignOut] =
		useState<ProfileView | null>(null);
	const [confirmingRemove, setConfirmingRemove] = useState<ProfileView | null>(
		null,
	);

	const setError = (id: string, error: RowError | null) =>
		setErrors((all) => {
			const next = { ...all };
			if (error) next[id] = error;
			else delete next[id];
			return next;
		});

	const signOut = async (view: ProfileView) => {
		setConfirmingSignOut(null);
		setSigningOut((all) => withId(all, view.id, true));
		setError(view.id, null);
		try {
			await cliLoginActions.logout(agent, view.id);
		} catch (err) {
			setError(view.id, {
				kind: "message",
				text: errorMessage(err),
				name: view.name,
				basis: basisOf(view),
			});
		} finally {
			setSigningOut((all) => withId(all, view.id, false));
		}
	};

	const remove = async (view: ProfileView) => {
		setConfirmingRemove(null);
		setRemoving((all) => withId(all, view.id, true));
		setError(view.id, null);
		const basis = basisOf(view);
		try {
			await cliLoginActions.removeProfile(agent, view.id);
		} catch (err) {
			setRemoving((all) => withId(all, view.id, false));
			const refusal = cliProfileRemoveRefusal(err);
			if (refusal) {
				const state = useCliLoginStore.getState();
				const status = state.statuses[agent];
				const login = state.logins[agent];
				const signingId =
					login && !isLoginEnded(login)
						? profileKey(login.profile_id)
						: status?.state === "signing_in"
							? profileKey(status.login_profile_id)
							: undefined;
				setError(view.id, {
					kind: "refusal",
					name: view.name,
					basis,
					...removeRefusalText(refusal, {
						label,
						name: view.name,
						signingIn:
							signingId !== undefined && signingId !== view.id
								? liveProfileName(state.profiles, agent, signingId)
								: undefined,
						notInstalled: notInstalled || status?.state === "not_installed",
					}),
				});
			} else if (removalMayHaveLeftDirectory(err)) {
				// The server may have taken the account off the list before
				// failing, and its push lands after this reply. Where it is drawn
				// is decided by the list when drawing.
				setError(view.id, {
					kind: "remove_failed",
					text: errorMessage(err),
					name: view.name,
					basis,
				});
			} else {
				setError(view.id, {
					kind: "message",
					text: errorMessage(err),
					name: view.name,
					basis,
				});
			}
		}
	};

	const current = chosenProfileIdOf(overview, agent);

	return (
		<div className="space-y-1">
			{ids.map((id) => (
				<AccountRow
					key={id}
					agent={agent}
					id={id}
					updating={updating}
					notInstalled={notInstalled}
					sharedExternal={!!shared}
					switching={switching}
					signingOut={signingOut.has(id)}
					removing={removing.has(id)}
					error={errors[id]}
					switchError={errorFor(id)}
					loginError={loginError}
					onSwitch={() => void switchTo(id)}
					onSignIn={(view) => onOpenSignIn({ id, name: view.name })}
					onOpenMenu={() => setMenuFor(id)}
				/>
			))}

			{shared && (
				<p className="flex gap-2 pt-1 text-xs text-th-text-secondary">
					<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					<span>
						<ExternalSource agent={agent} external={shared} shared />
					</span>
				</p>
			)}
			{Object.entries(errors).map(
				([id, error]) =>
					error.kind === "remove_failed" &&
					!ids.includes(id) && (
						<CliRowNotice
							key={id}
							error={`${error.name} was removed, but its folder couldn't be deleted: ${error.text}`}
						/>
					),
			)}
			<p className="pt-1 text-xs text-th-text-muted">
				{!available && current !== DEFAULT_PROFILE_ID
					? "This machine uses Default whatever is current."
					: "New sessions and each session's next message use the current account, in every project here."}
			</p>

			{menuFor !== null && ids.includes(menuFor) && (
				<MenuFor
					agent={agent}
					id={menuFor}
					updating={updating}
					notInstalled={notInstalled}
					switching={switching !== null}
					onClose={() => setMenuFor(null)}
					onSwitch={() => void switchTo(menuFor)}
					onSignIn={(view) => onOpenSignIn({ id: view.id, name: view.name })}
					onSignOut={setConfirmingSignOut}
					onRename={(view) => onRename({ id: view.id, name: view.name })}
					onRemove={setConfirmingRemove}
				/>
			)}

			{confirmingSignOut && (
				<ConfirmDialog
					title={`Sign out of ${confirmingSignOut.name}?`}
					message={
						confirmingSignOut.current
							? `${confirmingSignOut.name} is the current ${label} account, so sessions using ${label} stop working until you sign in again or switch to another account. This includes other projects and cluster nodes on this machine.`
							: `Sessions don't use ${confirmingSignOut.name} while it isn't the current account. A turn still running as ${confirmingSignOut.name} may fail. You'll need to sign in again before switching back to it.`
					}
					confirmLabel="Sign out"
					cancelLabel="Cancel"
					variant="danger"
					onConfirm={() => void signOut(confirmingSignOut)}
					onCancel={() => setConfirmingSignOut(null)}
				/>
			)}

			{confirmingRemove && (
				<ConfirmDialog
					title={`Remove ${confirmingRemove.name}?`}
					message={`Pockode signs ${confirmingRemove.name} out of ${label} and deletes its sign-in from this machine. Conversations are kept — they belong to every account. Sessions idle on ${confirmingRemove.name} are stopped; if one is still running a turn, nothing is removed.`}
					confirmLabel="Remove"
					cancelLabel="Cancel"
					variant="danger"
					onConfirm={() => void remove(confirmingRemove)}
					onCancel={() => setConfirmingRemove(null)}
				/>
			)}
		</div>
	);
}

/** The menu of one account, following its live state while it is up. */
function MenuFor({
	agent,
	id,
	updating,
	notInstalled,
	switching,
	onClose,
	onSwitch,
	onSignIn,
	onSignOut,
	onRename,
	onRemove,
}: {
	agent: AgentType;
	id: string;
	updating: boolean;
	notInstalled: boolean;
	switching: boolean;
	onClose: () => void;
	onSwitch: () => void;
	onSignIn: (view: ProfileView) => void;
	onSignOut: (view: ProfileView) => void;
	onRename: (view: ProfileView) => void;
	onRemove: (view: ProfileView) => void;
}) {
	const view = useProfileView(agent, id, { updating, notInstalled });
	return (
		<CliAccountMenu
			view={view}
			switching={switching}
			onClose={onClose}
			onSwitch={onSwitch}
			onSignIn={() => onSignIn(view)}
			onSignOut={() => onSignOut(view)}
			onRename={() => onRename(view)}
			onRemove={() => onRemove(view)}
		/>
	);
}

function AccountRow({
	agent,
	id,
	updating,
	notInstalled,
	sharedExternal,
	switching,
	signingOut,
	removing,
	error,
	switchError,
	loginError,
	onSwitch,
	onSignIn,
	onOpenMenu,
}: {
	agent: AgentType;
	id: string;
	updating: boolean;
	notInstalled: boolean;
	sharedExternal: boolean;
	/** The account a switch on this card is running to. */
	switching: string | null;
	signingOut: boolean;
	removing: boolean;
	error: RowError | undefined;
	switchError: string | null;
	loginError: string | undefined;
	onSwitch: () => void;
	onSignIn: (view: ProfileView) => void;
	onOpenMenu: () => void;
}) {
	const view = useProfileView(agent, id, { updating, notInstalled });

	const busy = (text: string) => (
		<span
			className={`${cardTextButtonClass} cursor-default text-th-text-muted`}
		>
			<Spinner variant="current" srText={null} />
			{text}
		</span>
	);

	let action: React.ReactNode;
	if (removing) action = busy("Removing…");
	else if (signingOut) action = busy("Signing out…");
	else if (switching === id) action = busy("Switching…");
	else {
		// Several rows carry the same words, so each button names its account.
		switch (profileNeed(view)) {
			case "continue":
				action = (
					<button
						type="button"
						onClick={() => onSignIn(view)}
						aria-label={`Continue signing in ${view.name}`}
						className={primaryButtonClass}
					>
						Continue
					</button>
				);
				break;
			case "sign_in":
				action = (
					<button
						type="button"
						onClick={() => onSignIn(view)}
						aria-label={`Sign in ${view.name}`}
						className={primaryButtonClass}
					>
						Sign in
					</button>
				);
				break;
			case "retry":
				action = view.reading ? (
					busy("Checking…")
				) : (
					<button
						type="button"
						onClick={() => void cliLoginActions.inspectProfile(agent, id)}
						aria-label={`Retry reading ${view.name}`}
						className={primaryButtonClass}
					>
						Retry
					</button>
				);
				break;
			default:
				if (offersSwitch(view)) {
					action = (
						<button
							type="button"
							onClick={onSwitch}
							disabled={switching !== null}
							aria-label={`Switch to ${view.name}`}
							className={secondaryButtonClass}
						>
							Switch
						</button>
					);
				}
		}
	}
	// What the account's state has moved on from is no longer true of it.
	const shownError = error && error.basis === basisOf(view) ? error : undefined;

	return (
		<CliProfileRow
			view={view}
			sharedExternal={sharedExternal}
			action={action}
			menu={
				<button
					type="button"
					onClick={onOpenMenu}
					disabled={removing}
					aria-label={`Actions for ${view.name}`}
					className={iconButtonClass({ busy: removing })}
				>
					<Ellipsis className="h-4 w-4" aria-hidden="true" />
				</button>
			}
			loginError={view.signingInHere ? loginError : undefined}
			error={
				switchError ??
				(shownError && shownError.kind !== "refusal" ? shownError.text : null)
			}
			extraNotice={
				shownError?.kind === "refusal" ? (
					<CliRowNotice error={shownError.body} details={shownError.details} />
				) : undefined
			}
		/>
	);
}
