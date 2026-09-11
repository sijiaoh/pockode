import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../lib/agentOptionsStore";
import type { AgentEfforts, AgentModels } from "../types/message";
import { useAgentOptions } from "./useAgentOptions";

const MODELS: AgentModels = {
	claude: [{ id: "opus", label: "Opus" }],
	codex: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
};

const EFFORTS: AgentEfforts = {
	claude: [{ id: "high", label: "High" }],
};

let mockStatus = "connected";
const mockListModels = vi.fn(async () => MODELS);
const mockListEfforts = vi.fn(async () => EFFORTS);

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({
			status: mockStatus,
			actions: { listModels: mockListModels, listEfforts: mockListEfforts },
		}),
	),
}));

describe("useAgentOptions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStatus = "connected";
		mockListModels.mockImplementation(async () => MODELS);
		mockListEfforts.mockImplementation(async () => EFFORTS);
		useAgentOptionsStore.setState({ models: null, efforts: null, error: null });
	});

	it("loads the lists once the connection is up", async () => {
		renderHook(() => useAgentOptions(true));

		await waitFor(() => {
			expect(useAgentOptionsStore.getState().models).toEqual(MODELS);
		});
		expect(useAgentOptionsStore.getState().efforts).toEqual(EFFORTS);
		expect(mockListModels).toHaveBeenCalledTimes(1);
		expect(mockListEfforts).toHaveBeenCalledTimes(1);
	});

	it("waits for a connection, and for a reason to want the lists at all", () => {
		mockStatus = "connecting";
		const { rerender } = renderHook(({ enabled }) => useAgentOptions(enabled), {
			initialProps: { enabled: true },
		});
		expect(mockListModels).not.toHaveBeenCalled();

		mockStatus = "connected";
		rerender({ enabled: false });
		expect(mockListModels).not.toHaveBeenCalled();
	});

	// The whole reason this is a plain fetch rather than a subscription: the
	// lists are compiled into the server, so the one event that can change the
	// answer is landing on a server that was upgraded while we were away.
	it("asks again after a reconnect, in case the server was upgraded", async () => {
		const { rerender } = renderHook(() => useAgentOptions(true));
		await waitFor(() => expect(mockListModels).toHaveBeenCalledTimes(1));

		mockStatus = "reconnecting";
		rerender();
		mockStatus = "connected";
		rerender();

		await waitFor(() => expect(mockListModels).toHaveBeenCalledTimes(2));
		expect(mockListEfforts).toHaveBeenCalledTimes(2);
	});

	// The selector shows this reason and offers only Auto plus the session's
	// current values, so it must not be swallowed.
	it("records why the lists are missing", async () => {
		mockListModels.mockRejectedValueOnce(new Error("request timed out"));
		mockListEfforts.mockRejectedValueOnce(new Error("request timed out"));

		renderHook(() => useAgentOptions(true));

		await waitFor(() => {
			expect(useAgentOptionsStore.getState().error).toBe("request timed out");
		});
	});

	// One list failing must not throw away the other: the panel can still offer
	// the half that arrived.
	it("keeps the list that arrived when only the other one failed", async () => {
		mockListEfforts.mockRejectedValueOnce(new Error("request timed out"));

		renderHook(() => useAgentOptions(true));

		await waitFor(() => {
			expect(useAgentOptionsStore.getState().error).toBe("request timed out");
		});
		expect(useAgentOptionsStore.getState().models).toEqual(MODELS);
		expect(useAgentOptionsStore.getState().efforts).toBeNull();
	});

	// A failed re-fetch must not take away the lists already in hand — the
	// selector shows the error next to them rather than instead of them.
	it("keeps the lists it already has when a later fetch fails", async () => {
		renderHook(() => useAgentOptions(true));
		await waitFor(() => {
			expect(useAgentOptionsStore.getState().models).toEqual(MODELS);
		});

		useAgentOptionsStore.getState().setError("request timed out");

		expect(useAgentOptionsStore.getState().models).toEqual(MODELS);
		expect(useAgentOptionsStore.getState().efforts).toEqual(EFFORTS);
	});
});
