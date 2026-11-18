import { JSONRPCErrorException, type JSONRPCRequester } from "json-rpc-2.0";
import { describe, expect, it } from "vitest";
import { createFileActions, fileMoveRefusedReason } from "./file";

describe("fileMoveRefusedReason", () => {
	it("reads the reason the server attaches to a refused move", () => {
		const error = new JSONRPCErrorException(
			"cannot move a directory into itself: docs into docs/sub",
			-32602,
			{ reason: "into_itself" },
		);
		expect(fileMoveRefusedReason(error)).toBe("into_itself");
	});

	it("is null for any other failure", () => {
		expect(
			fileMoveRefusedReason(
				new JSONRPCErrorException("boom", -32602, { reason: "disk_full" }),
			),
		).toBeNull();
		expect(
			fileMoveRefusedReason(
				new JSONRPCErrorException("boom", -32603, { reason: "exists" }),
			),
		).toBeNull();
		expect(fileMoveRefusedReason(new Error("Not connected"))).toBeNull();
	});
});

describe("searchFiles", () => {
	function pendingClient() {
		const replies: Array<{
			resolve: (value: unknown) => void;
			reject: (error: unknown) => void;
		}> = [];
		const client = {
			request: () =>
				new Promise((resolve, reject) => replies.push({ resolve, reject })),
		} as unknown as JSONRPCRequester<void>;
		return { actions: createFileActions(() => client), replies };
	}

	const params = { query: "app" };

	it("answers with the server's result", async () => {
		const { actions, replies } = pendingClient();
		const search = actions.searchFiles(params, new AbortController().signal);
		replies[0].resolve({ matches: [], truncated: false });
		await expect(search).resolves.toEqual({ matches: [], truncated: false });
	});

	it("lets go at once when aborted, before the server's refusal arrives", async () => {
		const { actions, replies } = pendingClient();
		const controller = new AbortController();
		const search = actions.searchFiles(params, controller.signal);

		controller.abort();
		await expect(search).rejects.toBe(controller.signal.reason);
		// The refusal of a superseded search lands on nothing.
		replies[0].reject(
			new JSONRPCErrorException("superseded by a newer file search", -32015),
		);
	});

	it("sends nothing once already aborted", async () => {
		const { actions, replies } = pendingClient();
		const controller = new AbortController();
		controller.abort();
		await expect(actions.searchFiles(params, controller.signal)).rejects.toBe(
			controller.signal.reason,
		);
		expect(replies).toHaveLength(0);
	});
});
