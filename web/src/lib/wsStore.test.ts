import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config module
vi.mock("../utils/config", () => ({
	getWebSocketUrl: vi.fn(() => "ws://localhost/ws"),
}));

const TEST_TOKEN = "test-token";

// Mirrors RECONNECT_MAX_DELAY_MS in wsStore; not exported, since the ceiling is
// an implementation detail everywhere except here.
const RECONNECT_MAX_DELAY = 30000;

// Track created WebSocket instances
let mockWsInstances: MockWebSocket[] = [];
let currentMockWs: MockWebSocket | null = null;

// Mock WebSocket as a proper class
class MockWebSocket {
	static OPEN = 1;
	static CLOSED = 3;
	static CONNECTING = 0;
	static CLOSING = 2;

	url: string;
	readyState: number = MockWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;

	send = vi.fn((data: string) => {
		// Auto-respond to JSON-RPC requests with success (synchronous for testing)
		const parsed = JSON.parse(data);
		if (parsed.id !== undefined) {
			// It's a request, send a response synchronously via queueMicrotask
			queueMicrotask(() => {
				let result: Record<string, unknown> = {};
				if (parsed.method === "auth") {
					result = { version: "test" };
				} else if (parsed.method === "chat.messages.subscribe") {
					result = { id: "sub-1", history: [], state: "ended" };
				}
				this.simulateMessage({
					jsonrpc: "2.0",
					id: parsed.id,
					result,
				});
			});
		}
	});
	close = vi.fn(() => {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	});

	constructor(url: string) {
		this.url = url;
		mockWsInstances.push(this);
		currentMockWs = this;
	}

	// Test helpers
	simulateOpen() {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.();
	}
	simulateMessage(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
	simulateError() {
		this.onerror?.();
	}
	simulateClose() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}
	mockAuthFailure() {
		this.send = vi.fn((data: string) => {
			const parsed = JSON.parse(data);
			if (parsed.id !== undefined && parsed.method === "auth") {
				queueMicrotask(() => {
					this.simulateMessage({
						jsonrpc: "2.0",
						id: parsed.id,
						error: { code: -32600, message: "Invalid token" },
					});
				});
			}
		});
	}
	simulateNotification(method: string, params: unknown) {
		this.simulateMessage({
			jsonrpc: "2.0",
			method,
			params,
		});
	}
}

const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	vi.useFakeTimers();
	mockWsInstances = [];
	currentMockWs = null;
	globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(async () => {
	const { resetWSStore } = await import("./wsStore");
	resetWSStore();

	vi.restoreAllMocks();

	vi.useRealTimers();
	globalThis.WebSocket = OriginalWebSocket;
});

async function getWsActions() {
	const module = await import("./wsStore");
	return module.wsActions;
}

async function getUseWSStore() {
	const module = await import("./wsStore");
	return module.useWSStore;
}

function getMockWs() {
	return currentMockWs;
}

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", {
		value: state,
		configurable: true,
	});
}

function fireRecoveryEvents() {
	window.dispatchEvent(new Event("online"));
	setVisibility("visible");
	document.dispatchEvent(new Event("visibilitychange"));
}

async function connectAndAuth(token = TEST_TOKEN) {
	const wsActions = await getWsActions();
	const useWSStore = await getUseWSStore();

	wsActions.connect(token);
	getMockWs()?.simulateOpen();
	await vi.runAllTimersAsync();
	expect(useWSStore.getState().status).toBe("connected");
}

describe("wsStore", () => {
	describe("connect", () => {
		it("sets status to connecting then connected after auth", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();
			const statusChanges: string[] = [];

			useWSStore.subscribe((state) => {
				statusChanges.push(state.status);
			});

			wsActions.connect(TEST_TOKEN);
			expect(statusChanges).toContain("connecting");

			getMockWs()?.simulateOpen();
			// After open, auth is sent and should auto-respond
			await vi.runAllTimersAsync();
			expect(useWSStore.getState().status).toBe("connected");
		});

		it("sends auth RPC request on open", async () => {
			const wsActions = await getWsActions();

			wsActions.connect(TEST_TOKEN);
			getMockWs()?.simulateOpen();

			expect(getMockWs()?.send).toHaveBeenCalled();
			const ws = getMockWs();
			const sentData = JSON.parse(ws?.send.mock.calls[0][0] ?? "{}");
			expect(sentData.jsonrpc).toBe("2.0");
			expect(sentData.method).toBe("auth");
			expect(sentData.params).toEqual({ token: TEST_TOKEN });
		});

		it("sets status to auth_failed on auth failure", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();

			wsActions.connect(TEST_TOKEN);
			const ws = getMockWs();
			ws?.mockAuthFailure();
			ws?.simulateOpen();

			await vi.runAllTimersAsync();
			expect(useWSStore.getState().status).toBe("auth_failed");
		});

		it("sets status to error when no token", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();

			wsActions.connect("");

			expect(useWSStore.getState().status).toBe("error");
		});

		it("ignores connect() when already connecting", async () => {
			const wsActions = await getWsActions();

			wsActions.connect(TEST_TOKEN);
			const firstWs = getMockWs();

			wsActions.connect(TEST_TOKEN);
			// Should not create a new WebSocket
			expect(mockWsInstances.length).toBe(1);
			expect(firstWs?.close).not.toHaveBeenCalled();
		});

		it("ignores connect() when already connected", async () => {
			await connectAndAuth();
			const connectedWs = getMockWs();

			const wsActions = await getWsActions();
			wsActions.connect(TEST_TOKEN);

			// Should not create a new WebSocket
			expect(mockWsInstances.length).toBe(1);
			expect(connectedWs?.close).not.toHaveBeenCalled();
		});

		it("ignores connect() when in error state", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();

			// Force error state by calling connect with empty token
			wsActions.connect("");
			expect(useWSStore.getState().status).toBe("error");

			// Attempting to connect should be ignored
			wsActions.connect(TEST_TOKEN);
			expect(useWSStore.getState().status).toBe("error");
			expect(mockWsInstances.length).toBe(0);
		});

		it("resets reconnect attempts on successful connection", async () => {
			const wsActions = await getWsActions();

			// First connection closes
			wsActions.connect(TEST_TOKEN);
			getMockWs()?.simulateOpen();
			await vi.runAllTimersAsync();
			getMockWs()?.simulateClose();

			// Auto-reconnect triggers (uses stored token)
			vi.advanceTimersByTime(3000);
			getMockWs()?.simulateOpen();
			await vi.runAllTimersAsync();

			// Should have reset attempts - can reconnect again if needed
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(3000);
			expect(mockWsInstances.length).toBe(3);
		});
	});

	describe("disconnect", () => {
		it("closes WebSocket and sets status to disconnected", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();

			await connectAndAuth();
			const ws = getMockWs();

			wsActions.disconnect();

			expect(ws?.close).toHaveBeenCalled();
			expect(useWSStore.getState().status).toBe("disconnected");
		});

		it("cancels pending reconnect", async () => {
			const wsActions = await getWsActions();

			await connectAndAuth();
			getMockWs()?.simulateClose();

			// Reconnect scheduled but not yet executed
			wsActions.disconnect();
			vi.advanceTimersByTime(3000);

			// Should not have reconnected
			expect(mockWsInstances.length).toBe(1);
		});
	});

	describe("RPC methods", () => {
		it("sendMessage sends RPC request", async () => {
			const wsActions = await getWsActions();

			await connectAndAuth();
			getMockWs()?.send.mockClear();

			await wsActions.sendMessage("test-session", "hello");

			expect(getMockWs()?.send).toHaveBeenCalled();
			const ws = getMockWs();
			const sentData = JSON.parse(ws?.send.mock.calls[0][0] ?? "{}");
			expect(sentData.method).toBe("chat.message");
			expect(sentData.params).toEqual({
				session_id: "test-session",
				content: "hello",
			});
		});

		it("throws when not connected", async () => {
			const wsActions = await getWsActions();

			await expect(wsActions.sendMessage("test", "hello")).rejects.toThrow(
				"Not connected",
			);
		});
	});

	describe("notification handling", () => {
		it("handles invalid JSON gracefully", async () => {
			await connectAndAuth();

			// Send raw invalid JSON - should not throw
			getMockWs()?.onmessage?.({ data: "not json" });
		});
	});

	describe("subscriptions", () => {
		it("unsubscribe removes listener", async () => {
			const useWSStore = await getUseWSStore();
			const wsActions = await getWsActions();
			const listener = vi.fn();

			const unsubscribe = useWSStore.subscribe(listener);
			wsActions.connect(TEST_TOKEN);
			expect(listener).toHaveBeenCalled();

			listener.mockClear();
			unsubscribe();

			getMockWs()?.simulateOpen();
			await vi.runAllTimersAsync();
			expect(listener).not.toHaveBeenCalled();
		});

		it("multiple listeners all receive updates", async () => {
			const useWSStore = await getUseWSStore();
			const wsActions = await getWsActions();
			const listener1 = vi.fn();
			const listener2 = vi.fn();

			useWSStore.subscribe(listener1);
			useWSStore.subscribe(listener2);

			wsActions.connect(TEST_TOKEN);

			expect(listener1).toHaveBeenCalled();
			expect(listener2).toHaveBeenCalled();
		});
	});

	describe("fs watch callbacks", () => {
		it("calls callback when fs.changed notification is received", async () => {
			const wsActions = await getWsActions();
			const callback = vi.fn();

			await connectAndAuth();
			const ws = getMockWs();
			if (!ws) throw new Error("WebSocket not found");

			// Mock fsSubscribe to return a known ID
			ws.send = vi.fn((data: string) => {
				const parsed = JSON.parse(data);
				if (parsed.method === "fs.subscribe") {
					queueMicrotask(() => {
						ws.simulateMessage({
							jsonrpc: "2.0",
							id: parsed.id,
							result: { id: "f_test123" },
						});
					});
				}
			});

			const result = await wsActions.fsSubscribe("/test/path", callback);
			expect(result.id).toBe("f_test123");

			ws.simulateNotification("fs.changed", {
				id: "f_test123",
				data: {},
			});

			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("ignores fs.changed for unknown ID", async () => {
			const wsActions = await getWsActions();
			const callback = vi.fn();

			await connectAndAuth();
			const ws = getMockWs();
			if (!ws) throw new Error("WebSocket not found");

			// Mock fsSubscribe
			ws.send = vi.fn((data: string) => {
				const parsed = JSON.parse(data);
				if (parsed.method === "fs.subscribe") {
					queueMicrotask(() => {
						ws.simulateMessage({
							jsonrpc: "2.0",
							id: parsed.id,
							result: { id: "f_known" },
						});
					});
				}
			});

			await wsActions.fsSubscribe("/test/path", callback);

			// Send notification with unknown ID
			ws.simulateNotification("fs.changed", {
				id: "f_unknown",
				data: {},
			});

			expect(callback).not.toHaveBeenCalled();
		});

		it("ignores fs.changed after unsubscribe", async () => {
			const wsActions = await getWsActions();
			const callback = vi.fn();

			await connectAndAuth();
			const ws = getMockWs();
			if (!ws) throw new Error("WebSocket not found");

			ws.send = vi.fn((data: string) => {
				const parsed = JSON.parse(data);
				if (parsed.method === "fs.subscribe") {
					queueMicrotask(() => {
						ws.simulateMessage({
							jsonrpc: "2.0",
							id: parsed.id,
							result: { id: "f_test123" },
						});
					});
				} else if (parsed.method === "fs.unsubscribe") {
					queueMicrotask(() => {
						ws.simulateMessage({
							jsonrpc: "2.0",
							id: parsed.id,
							result: {},
						});
					});
				}
			});

			const result = await wsActions.fsSubscribe("/test/path", callback);
			await wsActions.fsUnsubscribe(result.id);

			ws.simulateNotification("fs.changed", {
				id: "f_test123",
				data: {},
			});

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("auto-reconnect", () => {
		// Jitter is spread around the delay, so pinning Math.random to the middle
		// of its range makes the backoff exact. See "spreads each delay" below for
		// the jitter itself.
		function withoutJitter() {
			vi.spyOn(Math, "random").mockReturnValue(0.5);
		}

		// Drives the store into a backoff long enough that only an explicit retry
		// would end it, and returns the number of sockets opened so far.
		async function waitOutALongBackoff(): Promise<number> {
			await connectAndAuth();
			withoutJitter();
			for (let i = 0; i < 5; i++) {
				getMockWs()?.simulateClose();
				vi.advanceTimersByTime(RECONNECT_MAX_DELAY);
			}
			getMockWs()?.simulateClose();
			return mockWsInstances.length;
		}

		it("backs off exponentially and never stops trying", async () => {
			const useWSStore = await getUseWSStore();
			await connectAndAuth();
			withoutJitter();

			// More rounds than the retry limit this store used to have: a drop
			// lasting longer than a fixed count of attempts must not be terminal.
			const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

			for (const [round, delay] of delays.entries()) {
				getMockWs()?.simulateClose();
				expect(useWSStore.getState().status).toBe("reconnecting");

				vi.advanceTimersByTime(delay - 1);
				expect(mockWsInstances.length).toBe(round + 1);

				vi.advanceTimersByTime(1);
				expect(mockWsInstances.length).toBe(round + 2);
			}
		});

		// Every client of a restarting server begins its backoff at the same
		// instant; without jitter they would all retry in the same millisecond.
		it("spreads each delay with jitter", async () => {
			await connectAndAuth();

			vi.spyOn(Math, "random").mockReturnValue(0);
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(799);
			expect(mockWsInstances.length).toBe(1);
			vi.advanceTimersByTime(1);
			expect(mockWsInstances.length).toBe(2);

			vi.spyOn(Math, "random").mockReturnValue(1);
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(2399);
			expect(mockWsInstances.length).toBe(2);
			vi.advanceTimersByTime(1);
			expect(mockWsInstances.length).toBe(3);
		});

		it("restarts the backoff after a connection succeeds", async () => {
			const useWSStore = await getUseWSStore();
			await connectAndAuth();
			withoutJitter();

			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(1000);
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(2000);

			getMockWs()?.simulateOpen();
			await vi.runAllTimersAsync();
			expect(useWSStore.getState().status).toBe("connected");

			const opened = mockWsInstances.length;
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(1000);
			expect(mockWsInstances.length).toBe(opened + 1);
		});

		// "reconnecting" looks the same after one second and after an hour, so the
		// attempt count is what lets the UI escalate from a blip to an outage.
		it("counts consecutive failures and clears the count on success", async () => {
			const useWSStore = await getUseWSStore();
			await connectAndAuth();
			withoutJitter();
			expect(useWSStore.getState().reconnectAttempts).toBe(0);

			getMockWs()?.simulateClose();
			expect(useWSStore.getState().reconnectAttempts).toBe(1);
			vi.advanceTimersByTime(1000);
			getMockWs()?.simulateClose();
			expect(useWSStore.getState().reconnectAttempts).toBe(2);

			vi.advanceTimersByTime(2000);
			getMockWs()?.simulateOpen();
			await vi.runAllTimersAsync();
			expect(useWSStore.getState().reconnectAttempts).toBe(0);
		});

		// Waiting out the rest of a 30 second backoff is pointless once the
		// browser has told us the network is back.
		it("retries at once when connectivity returns", async () => {
			const waiting = await waitOutALongBackoff();

			window.dispatchEvent(new Event("online"));

			expect(mockWsInstances.length).toBe(waiting + 1);
		});

		// Otherwise a user flipping between tabs on a dead network resets the
		// budget on every flip, and the "backoff" degenerates into a tight retry
		// loop driven by how often they switch.
		it("resumes the backoff where it left off after an immediate retry", async () => {
			const waiting = await waitOutALongBackoff();

			window.dispatchEvent(new Event("online"));
			expect(mockWsInstances.length).toBe(waiting + 1);

			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(RECONNECT_MAX_DELAY - 1);
			expect(mockWsInstances.length).toBe(waiting + 1);
			vi.advanceTimersByTime(1);
			expect(mockWsInstances.length).toBe(waiting + 2);
		});

		// A phone wakes with the tab already in front; the user should not watch a
		// stale screen until the backoff happens to elapse.
		it("retries at once when a hidden tab becomes visible again", async () => {
			const waiting = await waitOutALongBackoff();

			setVisibility("hidden");
			document.dispatchEvent(new Event("visibilitychange"));
			expect(mockWsInstances.length).toBe(waiting);

			setVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
			expect(mockWsInstances.length).toBe(waiting + 1);
		});

		it("ignores recovery events while connected", async () => {
			await connectAndAuth();

			fireRecoveryEvents();

			expect(mockWsInstances.length).toBe(1);
		});

		// The state with teeth: connect() lets "auth_failed" through, and the
		// token survives the rejection, so nothing but the listeners' own guard
		// stops a waking browser from re-offering a token the server refused —
		// once per tab switch, indefinitely.
		it("ignores recovery events after auth was rejected", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();

			wsActions.connect(TEST_TOKEN);
			getMockWs()?.mockAuthFailure();
			getMockWs()?.simulateOpen();
			await vi.runAllTimersAsync();
			expect(useWSStore.getState().status).toBe("auth_failed");

			fireRecoveryEvents();

			expect(mockWsInstances.length).toBe(1);
		});

		it("handles socket error by letting onclose manage state", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();

			wsActions.connect(TEST_TOKEN);
			// onerror is always followed by onclose; onerror does not change status
			getMockWs()?.simulateError();
			expect(useWSStore.getState().status).toBe("connecting");

			// onclose triggers reconnection attempt
			getMockWs()?.simulateClose();
			expect(useWSStore.getState().status).toBe("reconnecting");
		});

		it("does not reconnect on auth failure", async () => {
			const wsActions = await getWsActions();
			const useWSStore = await getUseWSStore();

			wsActions.connect(TEST_TOKEN);
			getMockWs()?.mockAuthFailure();
			getMockWs()?.simulateOpen();

			await vi.runAllTimersAsync();
			expect(useWSStore.getState().status).toBe("auth_failed");

			// Simulate server closing connection
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(3000);

			// Should not have reconnected
			expect(mockWsInstances.length).toBe(1);
		});
	});
});
