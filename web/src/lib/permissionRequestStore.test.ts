import { beforeEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "../types/message";
import {
	permissionRequestActions,
	resolvePermission,
	usePermissionRequestStore,
} from "./permissionRequestStore";

const request = (id: string): PermissionRequest => ({
	requestId: id,
	toolName: "Bash",
	toolInput: {},
	toolUseId: `tool-${id}`,
});

const resolve = (id: string) =>
	resolvePermission(id, new Map(), usePermissionRequestStore.getState());

describe("permissionRequestStore", () => {
	beforeEach(() => {
		usePermissionRequestStore.setState({
			sessionId: null,
			records: {},
			outcomes: {},
			unreadable: {},
		});
	});

	it("keeps an answer over a late expiry, and undoes a refused one", () => {
		permissionRequestActions.reset("s1", [request("a")]);
		permissionRequestActions.settle("s1", "a", { status: "allowed" });
		permissionRequestActions.settle("s1", "a", { status: "expired" });
		expect(resolve("a").status).toBe("allowed");

		permissionRequestActions.unsettle("s1", "a");
		expect(resolve("a")).toEqual({
			requestId: "a",
			request: request("a"),
			status: "pending",
		});
	});

	it("lets a refused answer's expiry through, as resetPrompt does", () => {
		permissionRequestActions.reset("s1", [request("a")]);
		permissionRequestActions.settle("s1", "a", { status: "denied" });
		permissionRequestActions.unsettle("s1", "a");
		permissionRequestActions.settle("s1", "a", { status: "expired" });
		expect(resolve("a").status).toBe("expired");
	});

	it("starts over for another session's record", () => {
		permissionRequestActions.reset("s1", [request("a")]);
		permissionRequestActions.add("s2", request("b"));
		expect(resolve("a").request).toBeNull();
		expect(resolve("b").request).toEqual(request("b"));
	});
});
