import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSessionListItem } from "../test/sessionFixtures";
import { createSession } from "./sessionCreate";
import { useSessionStore } from "./sessionStore";
import { useWorktreeStore } from "./worktreeStore";

const request = vi.hoisted(() => vi.fn());
vi.mock("./wsStore", () => ({
	wsActions: { createSession: () => request() },
}));

describe("createSession", () => {
	beforeEach(() => {
		useWorktreeStore.setState({ current: "a" });
		useSessionStore.setState({ sessions: [] });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("joins callers in one worktree into one request, and lists the session", async () => {
		request.mockResolvedValue(makeSessionListItem({ id: "new" }));

		const [first, second] = await Promise.all([
			createSession(),
			createSession(),
		]);

		expect(first).toBe(second);
		expect(request).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual([
			"new",
		]);
	});

	// A create sent before a switch is answered in the worktree left behind.
	it("does not join a request made in another worktree", async () => {
		request
			.mockResolvedValueOnce(makeSessionListItem({ id: "in-a" }))
			.mockResolvedValueOnce(makeSessionListItem({ id: "in-b" }));

		const inA = createSession();
		useWorktreeStore.setState({ current: "b" });
		const inB = createSession();

		expect((await inA).id).toBe("in-a");
		expect((await inB).id).toBe("in-b");
	});

	it("asks again after a failure", async () => {
		request
			.mockRejectedValueOnce(new Error("Not connected"))
			.mockResolvedValueOnce(makeSessionListItem({ id: "new" }));

		await expect(createSession()).rejects.toThrow("Not connected");
		expect((await createSession()).id).toBe("new");
		expect(request).toHaveBeenCalledTimes(2);
	});
});
