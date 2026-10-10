import type { JSONRPCRequester } from "json-rpc-2.0";
import { requireClient } from "./client";

export interface PortPreviewActions {
	/**
	 * A one-time ticket that logs a preview tab in without the password: single
	 * use, about 60 seconds (docs/code/relay-system.md#ticket-login). Ask for it
	 * per tab, right before opening it.
	 */
	portPreviewTicket: () => Promise<string>;
}

export function createPortPreviewActions(
	getClient: () => JSONRPCRequester<void> | null,
): PortPreviewActions {
	return {
		portPreviewTicket: async () => {
			const result: { ticket: string } = await requireClient(getClient).request(
				"port_preview.ticket",
				{},
			);
			return result.ticket;
		},
	};
}
