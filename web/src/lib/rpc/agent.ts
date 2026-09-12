import type { JSONRPCRequester } from "json-rpc-2.0";
import type { AgentType, ForkSupport } from "../../types/settings";
import { requireClient } from "./client";

/** One registered agent, as the server declares it. */
export interface AgentInfo {
	type: AgentType;
	fork_support: ForkSupport;
}

interface AgentListResult {
	agents: AgentInfo[];
}

export interface AgentActions {
	/**
	 * What every agent the server has registered declares about itself.
	 *
	 * Cached for the tab's lifetime: the answers come from the agent
	 * implementations compiled into the server, so they cannot change while it
	 * runs. A server replaced under a live tab keeps answering from the old table
	 * until the page is reloaded — the same staleness the bundle itself has.
	 */
	listAgents: () => Promise<AgentInfo[]>;
}

export function createAgentActions(
	getClient: () => JSONRPCRequester<void> | null,
): AgentActions {
	let cached: Promise<AgentInfo[]> | null = null;

	return {
		listAgents: async (): Promise<AgentInfo[]> => {
			const client = requireClient(getClient);
			// The promise is cached rather than the result, so components asking at
			// once share one request instead of racing to fill the cache.
			if (!cached) {
				const pending = Promise.resolve<AgentListResult>(
					client.request("agent.list", {}),
				).then((result) => result.agents);
				// A failed request is dropped from the cache so the next caller retries,
				// without swallowing the rejection this caller is waiting on.
				pending.catch(() => {
					if (cached === pending) cached = null;
				});
				cached = pending;
			}
			return cached;
		},
	};
}
