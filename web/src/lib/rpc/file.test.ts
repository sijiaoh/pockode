import { JSONRPCErrorException } from "json-rpc-2.0";
import { describe, expect, it } from "vitest";
import { fileMoveRefusedReason } from "./file";

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
