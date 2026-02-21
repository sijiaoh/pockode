import type { JSONRPCRequester } from "json-rpc-2.0";
import type {
	Work,
	WorkCreateParams,
	WorkUpdateParams,
} from "../../types/work";

export interface WorkActions {
	createWork: (params: WorkCreateParams) => Promise<Work>;
	updateWork: (params: WorkUpdateParams) => Promise<void>;
	deleteWork: (id: string) => Promise<void>;
	startWork: (id: string) => Promise<Work>;
}

export function createWorkActions(
	getClient: () => JSONRPCRequester<void> | null,
): WorkActions {
	const requireClient = (): JSONRPCRequester<void> => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		createWork: async (params: WorkCreateParams): Promise<Work> => {
			return requireClient().request("work.create", params);
		},

		updateWork: async (params: WorkUpdateParams): Promise<void> => {
			await requireClient().request("work.update", params);
		},

		deleteWork: async (id: string): Promise<void> => {
			await requireClient().request("work.delete", { id });
		},

		startWork: async (id: string): Promise<Work> => {
			return requireClient().request("work.start", { id });
		},
	};
}
