import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentModelStore } from "../lib/agentModelStore";
import type { AgentModels } from "../types/message";
import { useAgentModels } from "./useAgentModels";

const MODELS: AgentModels = {
	claude: [{ id: "opus", label: "Opus" }],
	codex: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
};

let mockStatus = "connected";
const mockListModels = vi.fn(async () => MODELS);

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({ status: mockStatus, actions: { listModels: mockListModels } }),
	),
}));

describe("useAgentModels", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStatus = "connected";
		mockListModels.mockImplementation(async () => MODELS);
		useAgentModelStore.setState({ models: null, error: null });
	});

	it("loads the lists once the connection is up", async () => {
		renderHook(() => useAgentModels(true));

		await waitFor(() => {
			expect(useAgentModelStore.getState().models).toEqual(MODELS);
		});
		expect(mockListModels).toHaveBeenCalledTimes(1);
	});

	it("waits for a connection, and for a reason to want the lists at all", () => {
		mockStatus = "connecting";
		const { rerender } = renderHook(({ enabled }) => useAgentModels(enabled), {
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
		const { rerender } = renderHook(() => useAgentModels(true));
		await waitFor(() => expect(mockListModels).toHaveBeenCalledTimes(1));

		mockStatus = "reconnecting";
		rerender();
		mockStatus = "connected";
		rerender();

		await waitFor(() => expect(mockListModels).toHaveBeenCalledTimes(2));
	});

	// The selector shows this reason and offers only Auto plus the session's
	// current model, so it must not be swallowed.
	it("records why the lists are missing", async () => {
		mockListModels.mockRejectedValueOnce(new Error("request timed out"));

		renderHook(() => useAgentModels(true));

		await waitFor(() => {
			expect(useAgentModelStore.getState().error).toBe("request timed out");
		});
	});

	// A failed re-fetch must not take away the lists already in hand — the
	// selector shows the error next to them rather than instead of them.
	it("keeps the lists it already has when a later fetch fails", async () => {
		renderHook(() => useAgentModels(true));
		await waitFor(() => {
			expect(useAgentModelStore.getState().models).toEqual(MODELS);
		});

		useAgentModelStore.getState().setError("request timed out");

		expect(useAgentModelStore.getState().models).toEqual(MODELS);
	});
});
