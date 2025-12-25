import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config module
vi.mock("../utils/config", () => ({
	getToken: vi.fn(() => "test-token"),
	getWebSocketUrl: vi.fn(() => "ws://localhost/ws"),
}));

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

	send = vi.fn();
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
}

// Store original WebSocket
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	vi.useFakeTimers();
	mockWsInstances = [];
	currentMockWs = null;
	// Replace WebSocket with mock class
	globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
	vi.useRealTimers();
	vi.resetModules();
	globalThis.WebSocket = OriginalWebSocket;
});

// Helper to get fresh wsStore for each test
async function getWsStore() {
	const module = await import("./wsStore");
	return module.wsStore;
}

// Helper to get the current WebSocket instance
function getMockWs() {
	return currentMockWs;
}

describe("wsStore", () => {
	describe("connect", () => {
		it("sets status to connecting then connected on open", async () => {
			const wsStore = await getWsStore();
			const statusChanges: string[] = [];
			wsStore.subscribeStatus(() => {
				statusChanges.push(wsStore.getStatusSnapshot());
			});

			wsStore.connect();
			expect(statusChanges).toContain("connecting");

			getMockWs()?.simulateOpen();
			expect(wsStore.getStatusSnapshot()).toBe("connected");
		});

		it("sets status to error when no token", async () => {
			const { getToken } = await import("../utils/config");
			vi.mocked(getToken).mockReturnValueOnce("");

			const wsStore = await getWsStore();
			wsStore.connect();

			expect(wsStore.getStatusSnapshot()).toBe("error");
		});

		it("closes existing connection before creating new one", async () => {
			const wsStore = await getWsStore();

			wsStore.connect();
			const firstWs = getMockWs();
			getMockWs()?.simulateOpen();

			wsStore.connect();
			expect(firstWs?.close).toHaveBeenCalled();
		});

		it("resets reconnect attempts on successful connection", async () => {
			const wsStore = await getWsStore();

			// First connection closes
			wsStore.connect();
			getMockWs()?.simulateOpen();
			getMockWs()?.simulateClose();

			// Auto-reconnect triggers
			vi.advanceTimersByTime(3000);
			getMockWs()?.simulateOpen();

			// Should have reset attempts - can reconnect again if needed
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(3000);
			expect(mockWsInstances.length).toBe(3);
		});
	});

	describe("disconnect", () => {
		it("closes WebSocket and sets status to disconnected", async () => {
			const wsStore = await getWsStore();

			wsStore.connect();
			getMockWs()?.simulateOpen();
			const ws = getMockWs();

			wsStore.disconnect();

			expect(ws?.close).toHaveBeenCalled();
			expect(wsStore.getStatusSnapshot()).toBe("disconnected");
		});

		it("cancels pending reconnect", async () => {
			const wsStore = await getWsStore();

			wsStore.connect();
			getMockWs()?.simulateOpen();
			getMockWs()?.simulateClose();

			// Reconnect scheduled but not yet executed
			wsStore.disconnect();
			vi.advanceTimersByTime(3000);

			// Should not have reconnected
			expect(mockWsInstances.length).toBe(1);
		});
	});

	describe("send", () => {
		it("sends JSON message when connected", async () => {
			const wsStore = await getWsStore();

			wsStore.connect();
			getMockWs()?.simulateOpen();

			const result = wsStore.send({
				type: "message",
				content: "hello",
				session_id: "test-session",
			});

			expect(result).toBe(true);
			expect(getMockWs()?.send).toHaveBeenCalledWith(
				JSON.stringify({
					type: "message",
					content: "hello",
					session_id: "test-session",
				}),
			);
		});

		it("returns false when not connected", async () => {
			const wsStore = await getWsStore();

			const result = wsStore.send({
				type: "message",
				content: "hello",
				session_id: "test-session",
			});

			expect(result).toBe(false);
		});

		it("returns false when WebSocket not open", async () => {
			const wsStore = await getWsStore();

			wsStore.connect();
			const ws = getMockWs();
			// Don't call simulateOpen - stays in connecting state
			if (ws) {
				ws.readyState = MockWebSocket.CLOSED;
			}

			const result = wsStore.send({
				type: "message",
				content: "hello",
				session_id: "test-session",
			});

			expect(result).toBe(false);
		});
	});

	describe("message handling", () => {
		it("notifies message listeners on valid JSON", async () => {
			const wsStore = await getWsStore();
			const listener = vi.fn();
			wsStore.subscribeMessage(listener);

			wsStore.connect();
			getMockWs()?.simulateOpen();
			getMockWs()?.simulateMessage({ type: "text", content: "hello" });

			expect(listener).toHaveBeenCalledWith({ type: "text", content: "hello" });
		});

		it("handles invalid JSON gracefully", async () => {
			const wsStore = await getWsStore();
			const listener = vi.fn();
			wsStore.subscribeMessage(listener);

			wsStore.connect();
			getMockWs()?.simulateOpen();

			// Send raw invalid JSON
			getMockWs()?.onmessage?.({ data: "not json" });

			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe("subscriptions", () => {
		it("unsubscribe removes listener", async () => {
			const wsStore = await getWsStore();
			const listener = vi.fn();

			const unsubscribe = wsStore.subscribeStatus(listener);
			wsStore.connect();
			expect(listener).toHaveBeenCalled();

			listener.mockClear();
			unsubscribe();

			getMockWs()?.simulateOpen();
			expect(listener).not.toHaveBeenCalled();
		});

		it("multiple listeners all receive updates", async () => {
			const wsStore = await getWsStore();
			const listener1 = vi.fn();
			const listener2 = vi.fn();

			wsStore.subscribeStatus(listener1);
			wsStore.subscribeStatus(listener2);

			wsStore.connect();

			expect(listener1).toHaveBeenCalled();
			expect(listener2).toHaveBeenCalled();
		});
	});

	describe("auto-reconnect", () => {
		it("reconnects up to 5 times on close", async () => {
			const wsStore = await getWsStore();

			wsStore.connect();
			getMockWs()?.simulateOpen();

			// Trigger 5 reconnects
			for (let i = 0; i < 5; i++) {
				getMockWs()?.simulateClose();
				vi.advanceTimersByTime(3000);
			}

			// Should have connected 6 times total (1 initial + 5 reconnects)
			expect(mockWsInstances.length).toBe(6);

			// 6th close should not trigger reconnect
			getMockWs()?.simulateClose();
			vi.advanceTimersByTime(3000);
			expect(mockWsInstances.length).toBe(6);
		});

		it("sets status to error on socket error", async () => {
			const wsStore = await getWsStore();

			wsStore.connect();
			getMockWs()?.simulateError();

			expect(wsStore.getStatusSnapshot()).toBe("error");
		});
	});
});
