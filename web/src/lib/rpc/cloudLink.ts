import type { CloudLinkFlow, CloudLinkUnlinked } from "@pockode/shared";
import type { JSONRPCRequester } from "json-rpc-2.0";
import { requireClient } from "./client";

export interface CloudLinkActions {
	/** The flow started, or the one already running: one per process. */
	cloudLinkStart: () => Promise<CloudLinkFlow>;
	/**
	 * The flow as it is afterwards: `canceled`, or the phase the approval
	 * reached first. Invalid params when `flowId` is no longer the latest flow.
	 */
	cloudLinkCancel: (flowId: string) => Promise<CloudLinkFlow>;
	cloudLinkUnlink: () => Promise<CloudLinkUnlinked>;
}

// `cloud_link.cancel` waits at most 10 s on the server and keeps the default
// timeout; `cloud_link.unlink` takes the client `getUnlinkClient` gives, whose
// timeout is wsStore's CLOUD_UNLINK_RPC_TIMEOUT_MS.
export function createCloudLinkActions(
	getClient: () => JSONRPCRequester<void> | null,
	getUnlinkClient: () => JSONRPCRequester<void> | null,
): CloudLinkActions {
	return {
		cloudLinkStart: async () => {
			const result: { flow: CloudLinkFlow } = await requireClient(
				getClient,
			).request("cloud_link.start", {});
			return result.flow;
		},

		cloudLinkCancel: async (flowId) => {
			const result: { flow: CloudLinkFlow } = await requireClient(
				getClient,
			).request("cloud_link.cancel", { flow_id: flowId });
			return result.flow;
		},

		cloudLinkUnlink: async () => {
			const result: { unlinked: CloudLinkUnlinked } = await requireClient(
				getUnlinkClient,
			).request("cloud_link.unlink", {});
			return result.unlinked;
		},
	};
}
