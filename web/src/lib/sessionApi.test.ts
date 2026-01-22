import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock wsStore - must be defined before import
vi.mock("./wsStore", () => ({
	wsActions: {
		createSession: vi.fn(),
		deleteSession: vi.fn(),
		updateSessionTitle: vi.fn(),
	},
}));

import { createSession, deleteSession, updateSessionTitle } from "./sessionApi";
import { wsActions } from "./wsStore";

describe("sessionApi", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("createSession", () => {
		it("calls wsActions.createSession", async () => {
			const newSession = {
				id: "new-id",
				title: "New Chat",
				created_at: "",
				updated_at: "",
			};
			vi.mocked(wsActions.createSession).mockResolvedValue(newSession);

			const result = await createSession();

			expect(wsActions.createSession).toHaveBeenCalled();
			expect(result).toEqual(newSession);
		});
	});

	describe("deleteSession", () => {
		it("calls wsActions.deleteSession with sessionId", async () => {
			vi.mocked(wsActions.deleteSession).mockResolvedValue(undefined);

			await deleteSession("session-123");

			expect(wsActions.deleteSession).toHaveBeenCalledWith("session-123");
		});
	});

	describe("updateSessionTitle", () => {
		it("calls wsActions.updateSessionTitle with params", async () => {
			vi.mocked(wsActions.updateSessionTitle).mockResolvedValue(undefined);

			await updateSessionTitle("session-123", "New Title");

			expect(wsActions.updateSessionTitle).toHaveBeenCalledWith(
				"session-123",
				"New Title",
			);
		});
	});
});
