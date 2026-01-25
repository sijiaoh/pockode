import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../lib/sessionStore";
import type {
	SessionListChangedNotification,
	SessionMeta,
} from "../types/message";
import { useSession } from "./useSession";

const mockSession = (id: string, title = "Test Session"): SessionMeta => ({
	id,
	title,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-01T00:00:00Z",
});

let notificationCallback: ((p: SessionListChangedNotification) => void) | null =
	null;
let mockSessions: SessionMeta[] = [];
let mockStatus = "connected";

const mockSubscribe = vi.fn(
	async (callback: (p: SessionListChangedNotification) => void) => {
		notificationCallback = callback;
		return { id: "watch-1", initial: mockSessions };
	},
);
const mockUnsubscribe = vi.fn();
const mockCreateSession = vi.fn();
const mockDeleteSession = vi.fn();
const mockUpdateSessionTitle = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) => {
		const state = {
			status: mockStatus,
			actions: {
				sessionListSubscribe: mockSubscribe,
				sessionListUnsubscribe: mockUnsubscribe,
			},
		};
		return selector(state);
	}),
	wsActions: {
		createSession: () => mockCreateSession(),
		deleteSession: (id: string) => mockDeleteSession(id),
		updateSessionTitle: (id: string, title: string) =>
			mockUpdateSessionTitle(id, title),
	},
}));

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		);
	};
}

describe("useSession", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		vi.clearAllMocks();
		notificationCallback = null;
		mockSessions = [];
		mockStatus = "connected";
		useSessionStore.setState({
			sessions: [],
			isLoading: true,
			isSuccess: false,
		});
	});

	afterEach(() => {
		queryClient.clear();
	});

	describe("derived state", () => {
		describe("currentSession", () => {
			it("returns session matching routeSessionId", async () => {
				mockSessions = [mockSession("1"), mockSession("2", "Second")];

				const { result } = renderHook(
					() => useSession({ routeSessionId: "2" }),
					{ wrapper: createWrapper(queryClient) },
				);

				await waitFor(() => {
					expect(result.current.currentSession?.title).toBe("Second");
				});
			});

			it("is undefined when routeSessionId is invalid", async () => {
				mockSessions = [mockSession("1")];

				const { result } = renderHook(
					() => useSession({ routeSessionId: "invalid" }),
					{ wrapper: createWrapper(queryClient) },
				);

				await waitFor(() => {
					expect(result.current.isSuccess).toBe(true);
				});

				expect(result.current.currentSession).toBeUndefined();
			});
		});

		describe("redirectSessionId", () => {
			it("returns first session when no routeSessionId", async () => {
				mockSessions = [mockSession("1"), mockSession("2")];

				const { result } = renderHook(() => useSession(), {
					wrapper: createWrapper(queryClient),
				});

				await waitFor(() => {
					expect(result.current.isSuccess).toBe(true);
				});

				expect(result.current.redirectSessionId).toBe("1");
			});

			it("returns null when routeSessionId is valid", async () => {
				mockSessions = [mockSession("1"), mockSession("2")];

				const { result } = renderHook(
					() => useSession({ routeSessionId: "2" }),
					{ wrapper: createWrapper(queryClient) },
				);

				await waitFor(() => {
					expect(result.current.isSuccess).toBe(true);
				});

				expect(result.current.redirectSessionId).toBeNull();
			});

			it("returns first session when routeSessionId is invalid", async () => {
				mockSessions = [mockSession("1")];

				const { result } = renderHook(
					() => useSession({ routeSessionId: "invalid" }),
					{ wrapper: createWrapper(queryClient) },
				);

				await waitFor(() => {
					expect(result.current.isSuccess).toBe(true);
				});

				expect(result.current.redirectSessionId).toBe("1");
			});

			it("updates when current session is deleted", async () => {
				mockSessions = [mockSession("1"), mockSession("2")];

				const { result } = renderHook(
					() => useSession({ routeSessionId: "1" }),
					{ wrapper: createWrapper(queryClient) },
				);

				await waitFor(() => {
					expect(result.current.currentSession?.id).toBe("1");
				});

				act(() => {
					notificationCallback?.({
						id: "watch-1",
						operation: "delete",
						sessionId: "1",
					});
				});

				await waitFor(() => {
					expect(result.current.redirectSessionId).toBe("2");
				});
			});
		});

		describe("needsNewSession", () => {
			it("is true when session list is empty", async () => {
				mockSessions = [];

				const { result } = renderHook(() => useSession(), {
					wrapper: createWrapper(queryClient),
				});

				await waitFor(() => {
					expect(result.current.isSuccess).toBe(true);
				});

				expect(result.current.needsNewSession).toBe(true);
			});

			it("is false when sessions exist", async () => {
				mockSessions = [mockSession("1")];

				const { result } = renderHook(() => useSession(), {
					wrapper: createWrapper(queryClient),
				});

				await waitFor(() => {
					expect(result.current.isSuccess).toBe(true);
				});

				expect(result.current.needsNewSession).toBe(false);
			});
		});
	});

	describe("mutations", () => {
		describe("createSession", () => {
			it("optimistically adds session", async () => {
				const newSession = mockSession("new-id", "New");
				mockCreateSession.mockResolvedValue(newSession);

				mockSessions = [mockSession("1")];

				const { result } = renderHook(
					() => useSession({ routeSessionId: "1" }),
					{ wrapper: createWrapper(queryClient) },
				);

				await waitFor(() => {
					expect(result.current.sessions.length).toBe(1);
				});

				await act(async () => {
					await result.current.createSession();
				});

				expect(result.current.sessions.length).toBe(2);
				expect(result.current.sessions[0].id).toBe("new-id");
			});
		});
	});
});
