import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { AGENT_TYPES } from "../../../lib/agentType";
import { cliLoginActions, useCliLoginStore } from "../../../lib/cliLoginStore";
import { useWSStore } from "../../../lib/wsStore";
import type { AgentType } from "../../../types/settings";
import CliLoginSheet from "../../CliLogin/CliLoginSheet";
import { textButtonClass } from "../../CliLogin/loginParts";
import CliStatusCard from "./CliStatusCard";

function refresh() {
	void cliLoginActions.refreshStatus();
	void cliLoginActions.refreshCheck();
}

/**
 * Whether each AI CLI is signed in on the server machine, and whether it is up
 * to date. Nothing pushes either — a terminal, another node or the CLI's own
 * auto-updater can change them unseen — so both are read on mount, whenever the
 * page comes back into view, and on Refresh. They are separate requests, so a
 * slow registry never holds up the sign-in line, nor the other way round.
 */
export default function CliSignInSection() {
	const isConnected = useWSStore((s) => s.status === "connected");
	const reading = useCliLoginStore((s) =>
		AGENT_TYPES.some((agent) => s.reading[agent] || s.checking[agent]),
	);
	const [sheetAgent, setSheetAgent] = useState<AgentType | null>(null);

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
			<ul className="divide-y divide-th-border rounded-lg border border-th-border bg-th-bg-secondary">
				{AGENT_TYPES.map((agent) => (
					<CliStatusCard
						key={agent}
						agent={agent}
						onOpenSignIn={() => setSheetAgent(agent)}
					/>
				))}
			</ul>
			{sheetAgent && (
				<CliLoginSheet agent={sheetAgent} onClose={() => setSheetAgent(null)} />
			)}
		</div>
	);
}
