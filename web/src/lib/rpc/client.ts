import type { JSONRPCRequester } from "json-rpc-2.0";

export function requireClient(
	getClient: () => JSONRPCRequester<void> | null,
): JSONRPCRequester<void> {
	const client = getClient();
	if (!client) {
		throw new Error("Not connected");
	}
	return client;
}
