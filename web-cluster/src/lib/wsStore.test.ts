import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pockode/shared", () => ({
	getWebSocketUrl: () => "ws://localhost/ws",
}));

const TEST_TOKEN = "test-token";

let mockWsInstances: MockWebSocket[] = [];
let currentMockWs: MockWebSocket | null = null;

// Minimal WebSocket stand-in that auto-answers the auth RPC so connect() can
// reach the "connected" state without a real server.
class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	url: string;
	readyState = MockWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;

	send = vi.fn((data: string) => {
		const parsed = JSON.parse(data);
		if (parsed.id !== undefined && parsed.method === "auth") {
			queueMicrotask(() => {
				this.simulateMessage({
					jsonrpc: "2.0",
					id: parsed.id,
					result: { version: "test" },
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

	simulateOpen() {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.();
	}
	simulateMessage(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
	simulateClose() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}
	// close() is not instant in a browser: it starts a handshake, and against a
	// dead cluster onclose lands seconds later. The default mock fires it
	// synchronously, which hides every bug that needs a socket to outlive its
	// own close() call.
	mockSlowClose() {
		this.close = vi.fn(() => {
			this.readyState = MockWebSocket.CLOSING;
		});
	}
	finishClose() {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.();
	}
}

const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	mockWsInstances = [];
	currentMockWs = null;
	globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
	return () => {
		vi.useRealTimers();
		globalThis.WebSocket = OriginalWebSocket;
	};
});

async function getStore() {
	const module = await import("./wsStore");
	return module.useWSStore;
}

async function connectAndAuth(token = TEST_TOKEN) {
	const useWSStore = await getStore();
	useWSStore.getState().actions.connect(token);
	currentMockWs?.simulateOpen();
	await vi.runAllTimersAsync();
	expect(useWSStore.getState().status).toBe("connected");
	return useWSStore;
}

describe("wsStore reconnect", () => {
	it("shows connecting on the initial connect", async () => {
		const useWSStore = await getStore();
		useWSStore.getState().actions.connect(TEST_TOKEN);
		expect(useWSStore.getState().status).toBe("connecting");
	});

	it("goes to reconnecting (not disconnected) when a connected socket closes", async () => {
		const useWSStore = await connectAndAuth();

		currentMockWs?.simulateClose();

		// "disconnected" would make App auto-reconnect via connect() and flash the
		// spinner; the connected UI must stay mounted during automatic reconnects.
		expect(useWSStore.getState().status).toBe("reconnecting");
	});

	it("keeps reconnecting (not connecting) while re-establishing the socket", async () => {
		const useWSStore = await connectAndAuth();
		currentMockWs?.simulateClose();
		expect(mockWsInstances.length).toBe(1);

		// Fire the scheduled reconnect: a new socket opens but the status must not
		// flip to "connecting", which would remount NodeList and flash the spinner.
		await vi.advanceTimersByTimeAsync(3000);
		expect(mockWsInstances.length).toBe(2);
		expect(useWSStore.getState().status).toBe("reconnecting");

		currentMockWs?.simulateOpen();
		await vi.runAllTimersAsync();
		expect(useWSStore.getState().status).toBe("connected");
	});

	it("ignores a re-entrant connect while already connecting", async () => {
		const useWSStore = await getStore();

		// Simulates React StrictMode double-invoking App's connect effect: the
		// second call must be a no-op, not open a second socket that orphans and
		// leaks the first while flashing the UI.
		useWSStore.getState().actions.connect(TEST_TOKEN);
		useWSStore.getState().actions.connect(TEST_TOKEN);
		expect(mockWsInstances.length).toBe(1);

		currentMockWs?.simulateOpen();
		await vi.runAllTimersAsync();

		expect(useWSStore.getState().status).toBe("connected");
		// A single clean socket, no stray reconnect timer from a superseded one.
		expect(mockWsInstances.length).toBe(1);
	});

	it("ignores a connect while already connected", async () => {
		const useWSStore = await connectAndAuth();

		useWSStore.getState().actions.connect(TEST_TOKEN);

		expect(mockWsInstances.length).toBe(1);
		expect(useWSStore.getState().status).toBe("connected");
	});

	// A relay outage lasts far longer than a handful of quick retries: the server
	// alone needs ~20s to notice the tunnel is dead. Giving up would leave the
	// page on the error screen until the user acts.
	it("keeps retrying through a long outage and recovers on its own", async () => {
		const useWSStore = await connectAndAuth();

		for (let i = 0; i < 10; i++) {
			currentMockWs?.simulateClose();
			expect(useWSStore.getState().status).toBe("reconnecting");
			// Longer than the capped backoff, so every attempt gets to fire.
			await vi.advanceTimersByTimeAsync(60000);
		}
		expect(mockWsInstances.length).toBe(11);

		currentMockWs?.simulateOpen();
		await vi.runAllTimersAsync();
		expect(useWSStore.getState().status).toBe("connected");
	});

	// The cloud can accept the browser's socket while the tunnel behind it is
	// dead, so auth is sent and never answered. That is a network problem, not a
	// credential problem: "auth_failed" would put the user on the token screen.
	it("retries when auth is never answered instead of failing auth", async () => {
		const useWSStore = await getStore();

		useWSStore.getState().actions.connect(TEST_TOKEN);
		if (currentMockWs) {
			currentMockWs.send = vi.fn();
		}
		currentMockWs?.simulateOpen();

		// Past the RPC timeout.
		await vi.advanceTimersByTimeAsync(30000);

		expect(useWSStore.getState().status).toBe("reconnecting");
		await vi.advanceTimersByTimeAsync(1000);
		expect(mockWsInstances.length).toBe(2);
	});

	// The unreachable screen's Retry button stays on screen for the whole
	// reconnect, so connect() can land while an attempt is still opening its
	// socket. That socket has to be dropped rather than orphaned: still attached,
	// its eventual close would clear the newer connection's state and schedule a
	// reconnect on top of it.
	it("drops an in-flight socket when connect() supersedes it", async () => {
		const useWSStore = await connectAndAuth();

		currentMockWs?.simulateClose();
		await vi.advanceTimersByTimeAsync(1000);
		const superseded = currentMockWs;
		expect(mockWsInstances.length).toBe(2);

		useWSStore.getState().actions.connect(TEST_TOKEN);
		expect(superseded?.close).toHaveBeenCalled();
		expect(mockWsInstances.length).toBe(3);

		currentMockWs?.simulateOpen();
		await vi.runAllTimersAsync();
		expect(useWSStore.getState().status).toBe("connected");

		// The superseded socket giving up later must not disturb the live one.
		superseded?.simulateClose();
		await vi.runAllTimersAsync();
		expect(useWSStore.getState().status).toBe("connected");
		expect(mockWsInstances.length).toBe(3);
	});

	// disconnect() drops its socket reference before the close handshake
	// finishes, so a socket closed against a dead cluster can still be closing
	// when the next connect() opens its replacement. It must not take that
	// replacement down when it finally lands.
	it("ignores the close of a socket that has already been replaced", async () => {
		const useWSStore = await connectAndAuth();

		const superseded = currentMockWs;
		superseded?.mockSlowClose();

		useWSStore.getState().actions.disconnect();
		useWSStore.getState().actions.connect(TEST_TOKEN);

		const replacement = currentMockWs;
		expect(replacement).not.toBe(superseded);
		replacement?.simulateOpen();
		await vi.runAllTimersAsync();
		expect(useWSStore.getState().status).toBe("connected");

		superseded?.finishClose();
		await vi.runAllTimersAsync();

		expect(useWSStore.getState().status).toBe("connected");
		// No reconnect was scheduled on top of the healthy connection.
		expect(mockWsInstances.length).toBe(2);
	});

	it("does not reconnect after an intentional disconnect", async () => {
		const useWSStore = await connectAndAuth();

		const seenStatuses: string[] = [];
		const unsubscribe = useWSStore.subscribe((state) => {
			seenStatuses.push(state.status);
		});

		useWSStore.getState().actions.disconnect();
		unsubscribe();

		// disconnect() must go straight to "disconnected". Closing the socket
		// before setting the status would make onclose see "connected" and briefly
		// schedule a reconnect ("reconnecting" + a stray no-op timer).
		expect(seenStatuses).not.toContain("reconnecting");
		expect(useWSStore.getState().status).toBe("disconnected");

		// No stray reconnect timer should remain.
		await vi.advanceTimersByTimeAsync(3000);
		expect(mockWsInstances.length).toBe(1);
		expect(useWSStore.getState().status).toBe("disconnected");
	});
});
