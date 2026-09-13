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
 * round trip per page load rather than one per session opened.
 *
 * Asked once the connection is up, and asked again after a reconnect while the
 * answer is still missing — a panel mounted during a reconnect would otherwise
 * go the rest of its life not knowing, which is exactly how long the wrong
 * answer would stay on screen.
 *
 * `null` only spans that wait. Treating it as "forking is available" is
 * deliberate, and this is the only place that decides it — a second copy of the
 * default in a component would one day disagree with this one. An agent that
 * turns out to answer `"none"` costs a fork icon that was on screen for a moment
 * and then left; starting from "unavailable" would instead pop a row into every
 * bubble once the answer landed, which is the more jarring of the two. A fork
 * that should not have been offered is refused by the server regardless, with a
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
				// Nothing to report: the capability only decides whether a fork icon is
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
