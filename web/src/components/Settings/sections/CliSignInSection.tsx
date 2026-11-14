import { Info, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useCliProfileSubscription } from "../../../hooks/useCliProfileSubscription";
import { AGENT_TYPES } from "../../../lib/agentType";
import { cliLoginActions, useCliLoginStore } from "../../../lib/cliLoginStore";
import {
	hasStoredProfiles,
	profileIdsOf,
	unavailableText,
} from "../../../lib/cliProfiles";
import { useWSStore } from "../../../lib/wsStore";
import type { AgentType } from "../../../types/settings";
import CliLoginSheet from "../../CliLogin/CliLoginSheet";
import { textButtonClass } from "../../CliLogin/loginParts";
import type { SignInAccount } from "./CliAccountList";
import CliAccountNameSheet from "./CliAccountNameSheet";
import CliStatusCard from "./CliStatusCard";

/** The section's one sheet: sheets don't nest, so one replaces another. */
type SectionSheet =
	| { kind: "sign_in"; agent: AgentType; account?: SignInAccount }
	| { kind: "add"; agent: AgentType }
	| { kind: "rename"; agent: AgentType; account: SignInAccount };

function refresh() {
	void cliLoginActions.refreshStatus();
	void cliLoginActions.refreshCheck();
	const { profiles } = useCliLoginStore.getState();
	for (const agent of AGENT_TYPES) {
		if (hasStoredProfiles(profiles, agent)) {
			void cliLoginActions.inspectProfiles(agent);
		}
	}
}

/**
 * Whether each AI CLI is signed in on the server machine — each of its
 * accounts, when it has several — and whether it is up to date. Nothing pushes
 * either — a terminal, another node or the CLI's own auto-updater can change
 * them unseen — so both are read on mount, whenever the page comes back into
 * view, and on Refresh. They are separate requests, so a slow registry never
 * holds up the sign-in line, nor the other way round; and each account is read
 * on its own, so a slow one never holds up the others.
 */
export default function CliSignInSection() {
	useCliProfileSubscription();
	const isConnected = useWSStore((s) => s.status === "connected");
	const reading = useCliLoginStore((s) =>
		AGENT_TYPES.some(
			(agent) =>
				s.reading[agent] ||
				s.checking[agent] ||
				Object.keys(s.inspecting[agent] ?? {}).length > 0,
		),
	);
	const overview = useCliLoginStore((s) => s.profiles);
	const profilesError = useCliLoginStore((s) => s.profilesError);
	const [sheet, setSheet] = useState<SectionSheet | null>(null);
	const closeSheet = () => setSheet(null);

	// "Updated" is shown until the user leaves Settings (docs/cli-update-ui.md).
	useEffect(() => cliLoginActions.forgetSeenUpdates, []);

	useEffect(() => {
		if (!isConnected) return;
		refresh();

		const onVisible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [isConnected]);

	// Accounts the page has not read yet: the first list to arrive, and an
	// account added since.
	const listed = AGENT_TYPES.map((agent) =>
		hasStoredProfiles(overview, agent)
			? profileIdsOf(overview, agent).join("\u0000")
			: "",
	).join("\u0001");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `listed` is what changes the accounts to read
	useEffect(() => {
		if (!isConnected) return;
		const { profiles } = useCliLoginStore.getState();
		for (const agent of AGENT_TYPES) {
			if (!hasStoredProfiles(profiles, agent)) continue;
			for (const id of profileIdsOf(profiles, agent)) {
				cliLoginActions.ensureInspection(agent, id);
			}
		}
	}, [isConnected, listed]);

	const machineNotice =
		overview &&
		!overview.available &&
		AGENT_TYPES.some((agent) => hasStoredProfiles(overview, agent));

	const addAccount = async (agent: AgentType, name: string) => {
		const profile = await cliLoginActions.addProfile(agent, name);
		setSheet({
			kind: "sign_in",
			agent,
			account: { id: profile.id, name: profile.name },
		});
	};

	const renameAccount = async (
		agent: AgentType,
		account: SignInAccount,
		name: string,
	) => {
		await cliLoginActions.renameProfile(agent, account.id, name);
		closeSheet();
	};

	return (
		<div className="space-y-2">
			<div className="flex justify-end">
				<button
					type="button"
					onClick={refresh}
					disabled={reading}
					className={`${textButtonClass} disabled:opacity-50`}
				>
					<RefreshCw
						className={`h-4 w-4 ${reading ? "animate-spin" : ""}`}
						aria-hidden="true"
					/>
					Refresh
				</button>
			</div>
			{machineNotice && (
				<p className="flex gap-2 text-xs text-th-text-secondary">
					<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					<span>{unavailableText(overview.unavailable_reason)}</span>
				</p>
			)}
			{profilesError && (
				<p className="text-xs text-th-error" role="alert">
					Couldn't load accounts: {profilesError}
				</p>
			)}
			<ul className="divide-y divide-th-border rounded-lg border border-th-border bg-th-bg-secondary">
				{AGENT_TYPES.map((agent) => (
					<CliStatusCard
						key={agent}
						agent={agent}
						onOpenSignIn={(account) =>
							setSheet({ kind: "sign_in", agent, account })
						}
						onAddAccount={() => setSheet({ kind: "add", agent })}
						onRename={(account) => setSheet({ kind: "rename", agent, account })}
					/>
				))}
			</ul>
			{sheet?.kind === "sign_in" && (
				<CliLoginSheet
					key={`${sheet.agent}\u0000${sheet.account?.id}`}
					agent={sheet.agent}
					account={sheet.account}
					onClose={closeSheet}
				/>
			)}
			{sheet?.kind === "add" &&
				(overview && !overview.available ? (
					<CliAccountNameSheet
						mode="unavailable"
						agent={sheet.agent}
						reason={overview.unavailable_reason}
						onClose={closeSheet}
					/>
				) : (
					<CliAccountNameSheet
						mode="add"
						agent={sheet.agent}
						onClose={closeSheet}
						onSubmit={(name) => addAccount(sheet.agent, name)}
					/>
				))}
			{sheet?.kind === "rename" && (
				<CliAccountNameSheet
					mode="rename"
					agent={sheet.agent}
					currentName={sheet.account.name}
					onClose={closeSheet}
					onSubmit={(name) => renameAccount(sheet.agent, sheet.account, name)}
				/>
			)}
		</div>
	);
}
