import type { CloudLinkFlow, CloudLinkUnlinked } from "@pockode/shared";
import type { JSONRPCClient } from "json-rpc-2.0";

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

// No timeout of their own, as with the node RPCs: an answer comes or the
// connection goes. That matters for `cloud_link.unlink`, which can take a
// minute on the server (docs/code/cloud-account.md#the-cloud_link-rpc) and
// must not be reported failed just before it succeeds.
export function createCloudLinkActions(
	getClient: () => JSONRPCClient | null,
): CloudLinkActions {
	const requireClient = (): JSONRPCClient => {
		const client = getClient();
		if (!client) {
			throw new Error("Not connected");
		}
		return client;
	};

	return {
		cloudLinkStart: async () => {
			const result: { flow: CloudLinkFlow } = await requireClient().request(
				"cloud_link.start",
				{},
			);
			return result.flow;
		},

		cloudLinkCancel: async (flowId) => {
			const result: { flow: CloudLinkFlow } = await requireClient().request(
				"cloud_link.cancel",
				{ flow_id: flowId },
			);
			return result.flow;
		},

		cloudLinkUnlink: async () => {
			const result: { unlinked: CloudLinkUnlinked } =
				await requireClient().request("cloud_link.unlink", {});
			return result.unlinked;
		},
	};
}
