import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { SessionMeta } from "../types/message";
import {
	prependSession,
	useFilteredSessions,
	useSessionStore,
} from "./sessionStore";
import { useSettingsStore } from "./settingsStore";

const mockSession = (
	id: string,
	title = "Test",
	sandbox = false,
): SessionMeta => ({
	id,
	title,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
	mode: "default",
	sandbox,
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

describe("useFilteredSessions", () => {
	beforeEach(() => {
		useSessionStore.setState({
			sessions: [],
			isLoading: false,
			isSuccess: true,
		});
		useSettingsStore.setState({ settings: { sandbox: false } });
	});

	it("returns only normal sessions when sandbox mode is off", () => {
		useSessionStore.setState({
			sessions: [
				mockSession("1", "Normal 1", false),
				mockSession("2", "Sandbox 1", true),
				mockSession("3", "Normal 2", false),
			],
		});
		useSettingsStore.setState({ settings: { sandbox: false } });

		const { result } = renderHook(() => useFilteredSessions());

		expect(result.current.length).toBe(2);
		expect(result.current.map((s) => s.id)).toEqual(["1", "3"]);
	});

	it("returns only sandbox sessions when sandbox mode is on", () => {
		useSessionStore.setState({
			sessions: [
				mockSession("1", "Normal 1", false),
				mockSession("2", "Sandbox 1", true),
				mockSession("3", "Sandbox 2", true),
			],
		});
		useSettingsStore.setState({ settings: { sandbox: true } });

		const { result } = renderHook(() => useFilteredSessions());

		expect(result.current.length).toBe(2);
		expect(result.current.map((s) => s.id)).toEqual(["2", "3"]);
	});

	it("returns empty array when no sessions match current mode", () => {
		useSessionStore.setState({
			sessions: [mockSession("1", "Normal", false)],
		});
		useSettingsStore.setState({ settings: { sandbox: true } });

		const { result } = renderHook(() => useFilteredSessions());

		expect(result.current.length).toBe(0);
	});

	it("defaults to normal mode when settings is null", () => {
		useSessionStore.setState({
			sessions: [
				mockSession("1", "Normal", false),
				mockSession("2", "Sandbox", true),
			],
		});
		useSettingsStore.setState({ settings: null });

		const { result } = renderHook(() => useFilteredSessions());

		expect(result.current.length).toBe(1);
		expect(result.current[0].id).toBe("1");
	});

	it("updates when sandbox mode changes", () => {
		useSessionStore.setState({
			sessions: [
				mockSession("1", "Normal", false),
				mockSession("2", "Sandbox", true),
			],
		});
		useSettingsStore.setState({ settings: { sandbox: false } });

		const { result } = renderHook(() => useFilteredSessions());

		expect(result.current.length).toBe(1);
		expect(result.current[0].id).toBe("1");

		act(() => {
			useSettingsStore.setState({ settings: { sandbox: true } });
		});

		expect(result.current.length).toBe(1);
		expect(result.current[0].id).toBe("2");
	});
});
