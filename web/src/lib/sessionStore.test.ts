import { beforeEach, describe, expect, it } from "vitest";
import type { SessionListItem } from "../types/message";
import { prependSession, useSessionStore } from "./sessionStore";

const mockSession = (id: string, title = "Test"): SessionListItem => ({
	id,
	title,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
	mode: "default",
	state: "ended",
	needs_input: false,
	unread: false,
});

describe("prependSession", () => {
	it("adds session to the beginning", () => {
		const sessions = [mockSession("1"), mockSession("2")];
		const newSession = mockSession("3");

		const result = prependSession(sessions, newSession);

		expect(result[0].id).toBe("3");
		expect(result.length).toBe(3);
	});

	it("removes duplicate and prepends", () => {
		const sessions = [mockSession("1"), mockSession("2")];
		const updatedSession = mockSession("2", "Updated");

		const result = prependSession(sessions, updatedSession);

		expect(result.length).toBe(2);
		expect(result[0].id).toBe("2");
		expect(result[0].title).toBe("Updated");
	});

	it("handles empty list", () => {
		const result = prependSession([], mockSession("1"));

		expect(result.length).toBe(1);
		expect(result[0].id).toBe("1");
	});
});

describe("useSessionStore", () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
	});

	describe("setSessions", () => {
		it("sets sessions and updates loading state", () => {
			const sessions = [mockSession("1")];

			useSessionStore.getState().setSessions(sessions);

			const state = useSessionStore.getState();
			expect(state.sessions).toEqual(sessions);
			expect(state.isLoading).toBe(false);
			expect(state.isSuccess).toBe(true);
		});
	});

	describe("updateSessions", () => {
		it("updates sessions with updater function", () => {
			useSessionStore.setState({ sessions: [mockSession("1")] });

			useSessionStore
				.getState()
				.updateSessions((old) => [...old, mockSession("2")]);

			expect(useSessionStore.getState().sessions.length).toBe(2);
		});
	});

	describe("reset", () => {
		it("resets to initial state", () => {
			useSessionStore.setState({
				sessions: [mockSession("1")],
				isLoading: false,
				isSuccess: true,
			});

			useSessionStore.getState().reset();

			const state = useSessionStore.getState();
			expect(state.sessions).toEqual([]);
			expect(state.isLoading).toBe(false);
			expect(state.isSuccess).toBe(false);
		});
	});
});
