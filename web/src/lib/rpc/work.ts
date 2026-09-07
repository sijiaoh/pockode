import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	Comment,
	CommentUpdateParams,
	Work,
	WorkCreateParams,
	WorkUpdateParams,
} from "../../types/work";
import { requireClient } from "./client";

export interface WorkActions {
	createWork: (params: WorkCreateParams) => Promise<Work>;
	updateWork: (params: WorkUpdateParams) => Promise<void>;
	deleteWork: (id: string) => Promise<void>;
	startWork: (id: string) => Promise<Work>;
	stopWork: (id: string) => Promise<void>;
	reopenWork: (id: string) => Promise<void>;
	updateComment: (params: CommentUpdateParams) => Promise<Comment>;
}

/**
 * @param getAgentStartClient Requester for `work.start` alone, whose kickoff (or
 * restart) message may have to wait out an agent CLI cold start. See
 * AGENT_START_RPC_TIMEOUT_MS in wsStore.
 */
export function createWorkActions(
	getClient: () => JSONRPCRequester<void> | null,
	getAgentStartClient: () => JSONRPCRequester<void> | null,
): WorkActions {
	const client = (get: () => JSONRPCRequester<void> | null = getClient) =>
		requireClient(get);

	return {
		createWork: async (params: WorkCreateParams): Promise<Work> => {
			return client().request("work.create", params);
		},

		updateWork: async (params: WorkUpdateParams): Promise<void> => {
			await client().request("work.update", params);
		},

		deleteWork: async (id: string): Promise<void> => {
			await client().request("work.delete", { id });
		},

		startWork: async (id: string): Promise<Work> => {
			return client(getAgentStartClient).request("work.start", { id });
		},

		stopWork: async (id: string): Promise<void> => {
			await client().request("work.stop", { id });
		},

		reopenWork: async (id: string): Promise<void> => {
			await client().request("work.reopen", { id });
		},

		updateComment: async (params: CommentUpdateParams): Promise<Comment> => {
			return client().request("work.comment.update", params);
		},
	};
}
