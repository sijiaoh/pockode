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

export function createWorkActions(
	getClient: () => JSONRPCRequester<void> | null,
): WorkActions {
	const client = () => requireClient(getClient);

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
			return client().request("work.start", { id });
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
