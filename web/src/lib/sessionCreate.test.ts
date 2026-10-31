import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSessionListItem } from "../test/sessionFixtures";
import { createSession } from "./sessionCreate";
import { useSessionStore } from "./sessionStore";
import { useWorktreeStore } from "./worktreeStore";

const request = vi.hoisted(() => vi.fn());
vi.mock("./wsStore", () => ({
	wsActions: { createSession: (params: unknown) => request(params) },
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

	it("leaves the next worktree's list alone when answered after a switch", async () => {
		request.mockResolvedValueOnce(makeSessionListItem({ id: "in-a" }));

		const inA = createSession();
		useWorktreeStore.setState({ current: "b" });

		expect((await inA).id).toBe("in-a");
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	// Absent rather than false, so a chat session is asked for as it always was.
	it("asks for a canvas session only when told to", async () => {
		request.mockResolvedValue(makeSessionListItem({ id: "new" }));

		await createSession();
		await createSession({ canvas: true });

		expect(request.mock.calls).toEqual([[{}], [{ canvas: true }]]);
	});

	// A chat session cannot become a canvas one later, so it is no answer to a
	// caller asking for a canvas while it is in flight.
	it("does not join a request for the other kind of session", async () => {
		request
			.mockResolvedValueOnce(makeSessionListItem({ id: "chat" }))
			.mockResolvedValueOnce(
				makeSessionListItem({ id: "canvas", canvas: true }),
			);

		const [chat, canvas] = await Promise.all([
			createSession(),
			createSession({ canvas: true }),
		]);

		expect(chat.id).toBe("chat");
		expect(canvas.id).toBe("canvas");
	});

	it("still joins a create of its own kind with one of the other in flight", async () => {
		request
			.mockResolvedValueOnce(makeSessionListItem({ id: "chat" }))
			.mockResolvedValueOnce(
				makeSessionListItem({ id: "canvas", canvas: true }),
			);

		const first = createSession();
		void createSession({ canvas: true });
		const second = createSession();

		expect(await second).toBe(await first);
		expect(request).toHaveBeenCalledTimes(2);
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
