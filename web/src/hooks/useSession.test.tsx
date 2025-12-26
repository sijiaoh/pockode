import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../types/message";
import { useSession } from "./useSession";

// Mock sessionApi
vi.mock("../lib/sessionApi", () => ({
	listSessions: vi.fn(),
	createSession: vi.fn(),
	deleteSession: vi.fn(),
	updateSessionTitle: vi.fn(),
}));

import * as sessionApi from "../lib/sessionApi";

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	};
}

const mockSession = (id: string, title = "Test Session"): SessionMeta => ({
	id,
	title,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
});

// Mock window.location and window.history
const mockPushState = vi.fn();
const originalLocation = window.location;
const originalHistory = window.history;

function setUrlPath(path: string) {
	Object.defineProperty(window, "location", {
		value: { ...originalLocation, pathname: path },
		writable: true,
	});
}

describe("useSession", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = createTestQueryClient();
		vi.clearAllMocks();
		// Reset URL to root
		setUrlPath("/");
		// Mock pushState
		Object.defineProperty(window, "history", {
			value: { ...originalHistory, pushState: mockPushState },
			writable: true,
		});
		mockPushState.mockClear();
	});

	afterEach(() => {
		queryClient.clear();
		// Restore originals
		Object.defineProperty(window, "location", {
			value: originalLocation,
			writable: true,
		});
		Object.defineProperty(window, "history", {
			value: originalHistory,
			writable: true,
		});
	});

	describe("initial load", () => {
		it("loads sessions and selects first one", async () => {
			const sessions = [mockSession("1"), mockSession("2")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.sessions).toEqual(sessions);
			});

			expect(result.current.currentSessionId).toBe("1");
		});

		it("creates new session when list is empty", async () => {
			vi.mocked(sessionApi.listSessions).mockResolvedValue([]);
			vi.mocked(sessionApi.createSession).mockResolvedValue(
				mockSession("new-id", "New Chat"),
			);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("new-id");
			});

			expect(sessionApi.createSession).toHaveBeenCalled();
		});

		it("does not load when disabled", async () => {
			vi.mocked(sessionApi.listSessions).mockResolvedValue([]);

			const { result } = renderHook(() => useSession({ enabled: false }), {
				wrapper: createWrapper(queryClient),
			});

			// Give it time to potentially make a call
			await new Promise((r) => setTimeout(r, 50));

			expect(result.current.isLoading).toBe(false);
			expect(sessionApi.listSessions).not.toHaveBeenCalled();
		});
	});

	describe("selectSession", () => {
		it("changes currentSessionId", async () => {
			const sessions = [mockSession("1"), mockSession("2")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("1");
			});

			act(() => {
				result.current.selectSession("2");
			});

			expect(result.current.currentSessionId).toBe("2");
		});
	});

	describe("createSession", () => {
		it("adds new session and sets as current", async () => {
			vi.mocked(sessionApi.listSessions).mockResolvedValue([mockSession("1")]);
			vi.mocked(sessionApi.createSession).mockResolvedValue(
				mockSession("new-id"),
			);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.sessions.length).toBe(1);
			});

			await act(async () => {
				await result.current.createSession();
			});

			await waitFor(() => {
				expect(result.current.sessions.length).toBe(2);
			});
			expect(result.current.currentSessionId).toBe("new-id");
		});
	});

	describe("deleteSession", () => {
		it("deletes and switches to next session", async () => {
			const sessions = [mockSession("1"), mockSession("2")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);
			vi.mocked(sessionApi.deleteSession).mockResolvedValue(undefined);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("1");
			});

			await result.current.deleteSession("1");

			await waitFor(() => {
				expect(result.current.sessions.length).toBe(1);
			});
			expect(result.current.currentSessionId).toBe("2");
		});

		it("creates new session when deleting last one", async () => {
			vi.mocked(sessionApi.listSessions).mockResolvedValue([mockSession("1")]);
			vi.mocked(sessionApi.deleteSession).mockResolvedValue(undefined);
			vi.mocked(sessionApi.createSession).mockResolvedValue(
				mockSession("new-id", "New Chat"),
			);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("1");
			});

			await result.current.deleteSession("1");

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("new-id");
			});
			expect(sessionApi.createSession).toHaveBeenCalled();
		});

		it("deletes non-current session without switching", async () => {
			const sessions = [mockSession("1"), mockSession("2")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);
			vi.mocked(sessionApi.deleteSession).mockResolvedValue(undefined);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("1");
			});

			await result.current.deleteSession("2");

			await waitFor(() => {
				expect(result.current.sessions.length).toBe(1);
			});
			expect(result.current.currentSessionId).toBe("1");
		});
	});

	describe("updateTitle", () => {
		it("updates session title in cache", async () => {
			vi.mocked(sessionApi.listSessions).mockResolvedValue([
				mockSession("1", "Old Title"),
			]);
			vi.mocked(sessionApi.updateSessionTitle).mockResolvedValue(undefined);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.sessions.length).toBe(1);
			});

			result.current.updateTitle("1", "New Title");

			await waitFor(() => {
				expect(result.current.sessions[0].title).toBe("New Title");
			});
		});
	});

	describe("currentSession", () => {
		it("returns the current session object", async () => {
			const sessions = [mockSession("1", "First"), mockSession("2", "Second")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSession?.title).toBe("First");
			});

			act(() => {
				result.current.selectSession("2");
			});

			expect(result.current.currentSession?.title).toBe("Second");
		});
	});

	describe("URL sync", () => {
		it("uses session ID from URL if valid", async () => {
			setUrlPath("/s/2");
			const sessions = [mockSession("1"), mockSession("2")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.sessions.length).toBe(2);
			});

			// Should use session from URL, not first one
			expect(result.current.currentSessionId).toBe("2");
		});

		it("falls back to first session if URL session ID is invalid", async () => {
			setUrlPath("/s/invalid-id");
			const sessions = [mockSession("1"), mockSession("2")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("1");
			});
		});

		it("updates URL when session changes", async () => {
			const sessions = [mockSession("1"), mockSession("2")];
			vi.mocked(sessionApi.listSessions).mockResolvedValue(sessions);

			const { result } = renderHook(() => useSession(), {
				wrapper: createWrapper(queryClient),
			});

			await waitFor(() => {
				expect(result.current.currentSessionId).toBe("1");
			});

			// URL should be updated to /s/1
			expect(mockPushState).toHaveBeenCalledWith(null, "", "/s/1");

			mockPushState.mockClear();

			act(() => {
				result.current.selectSession("2");
			});

			// URL should be updated to /s/2
			expect(mockPushState).toHaveBeenCalledWith(null, "", "/s/2");
		});
	});
});
