import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { AGENT_TYPES } from "../../../lib/agentType";
import { cliLoginActions, useCliLoginStore } from "../../../lib/cliLoginStore";
import { useWSStore } from "../../../lib/wsStore";
import type { AgentType } from "../../../types/settings";
import CliLoginSheet from "../../CliLogin/CliLoginSheet";
import { textButtonClass } from "../../CliLogin/loginParts";
import CliStatusCard from "./CliStatusCard";

/**
 * Whether each AI CLI is signed in on the server machine. Nothing pushes
 * status — a terminal or another node can change it unseen — so it is read on
 * mount, whenever the page comes back into view, and on Refresh.
 */
export default function CliSignInSection() {
	const isConnected = useWSStore((s) => s.status === "connected");
	const reading = useCliLoginStore((s) =>
		AGENT_TYPES.some((agent) => s.reading[agent]),
	);
	const [sheetAgent, setSheetAgent] = useState<AgentType | null>(null);

	useEffect(() => {
		if (!isConnected) return;
		void cliLoginActions.refreshStatus();

		const onVisible = () => {
			if (document.visibilityState === "visible") {
				void cliLoginActions.refreshStatus();
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [isConnected]);

	return (
		<div className="space-y-2">
			<div className="flex justify-end">
				<button
					type="button"
					onClick={() => void cliLoginActions.refreshStatus()}
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
