import { useEffect, useState } from "react";
import { useWSStore, wsActions } from "../lib/wsStore";
import type { AgentType, ForkSupport } from "../types/settings";

/**
 * What the given agent declares about being forked, or `null` until the server
 * has said.
 *
 * The declaration is the server's to make: keeping a copy here would give the
 * same fact two places to be told from, and they would disagree the day an agent
 * learns something new. The request is cached for the tab, so this costs one
 * round trip per page load rather than one per menu.
 *
 * Asked once the connection is up, and asked again after a reconnect while the
 * answer is still missing — a panel mounted during a reconnect would otherwise
 * go the rest of its life not knowing, which is exactly how long the wrong menu
 * would stay on screen.
 *
 * `null` only spans that wait. Treating it as "forking is available" is
 * deliberate: the menu would otherwise open a refusal it cannot explain, and a
 * fork that should not have been offered is still refused by the server, with a
 * message the sheet shows.
 */
export function useForkSupport(agentType: AgentType): ForkSupport | null {
	const status = useWSStore((state) => state.status);
	const [supports, setSupports] = useState<Record<string, ForkSupport> | null>(
		null,
	);

	useEffect(() => {
		if (status !== "connected" || supports) return;

		let active = true;
		wsActions
			.listAgents()
			.then((agents) => {
				if (!active) return;
				setSupports(
					Object.fromEntries(agents.map((a) => [a.type, a.fork_support])),
				);
			})
			.catch(() => {
				// Nothing to report: the capability only decides whether a menu row is
				// offered, and the request that acts on it answers for itself. An error
				// here would be a second, unprompted complaint about the connection the
				// app already shows the state of. The next reconnect retries.
			});
		return () => {
			active = false;
		};
	}, [status, supports]);

	return supports?.[agentType] ?? null;
}
