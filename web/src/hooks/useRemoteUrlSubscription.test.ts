import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWSStore } from "../lib/wsStore";
import type { RemoteUrlChangedNotification } from "../types/message";
import { useRemoteUrlSubscription } from "./useRemoteUrlSubscription";

const remoteUrlSubscribe = vi.fn();
const remoteUrlUnsubscribe = vi.fn();

const AUTH_URL = "https://abc123.cloud.pockode.com";
const NEW_URL = "https://def456.cloud.pockode.com";

function notify(params: RemoteUrlChangedNotification) {
	const callback = remoteUrlSubscribe.mock.calls[0][0];
	act(() => callback(params));
}

beforeEach(() => {
	vi.clearAllMocks();
	remoteUrlUnsubscribe.mockResolvedValue(undefined);
	remoteUrlSubscribe.mockResolvedValue({ id: "sub-1", initial: AUTH_URL });
	// The real store, so what is asserted is what the port preview reads; only
	// the wire is stubbed.
	useWSStore.setState((s) => ({
		status: "connected",
		remoteUrl: AUTH_URL,
		actions: { ...s.actions, remoteUrlSubscribe, remoteUrlUnsubscribe },
	}));
});

describe("useRemoteUrlSubscription", () => {
	// The URL auth reported can already be stale by the time the subscription
	// opens; the snapshot is the newer of the two.
	it("takes the remote URL from the snapshot", async () => {
		remoteUrlSubscribe.mockResolvedValue({ id: "sub-1", initial: NEW_URL });
		renderHook(() => useRemoteUrlSubscription(true));

		await waitFor(() => expect(useWSStore.getState().remoteUrl).toBe(NEW_URL));
	});

	it("follows the relay to a new subdomain without reconnecting", async () => {
		renderHook(() => useRemoteUrlSubscription(true));
		await waitFor(() => expect(remoteUrlSubscribe).toHaveBeenCalled());

		notify({ id: "sub-1", remote_url: NEW_URL });

		expect(useWSStore.getState().remoteUrl).toBe(NEW_URL);
	});

	// Empty is how the server says remote access has ended for good.
	it("clears the remote URL when remote access ends", async () => {
		renderHook(() => useRemoteUrlSubscription(true));
		await waitFor(() => expect(remoteUrlSubscribe).toHaveBeenCalled());

		notify({ id: "sub-1", remote_url: "" });

		expect(useWSStore.getState().remoteUrl).toBe("");
	});

	// Unlike most subscriptions; why is on `remoteUrl` in wsStore.
	it("keeps the remote URL when the subscription is torn down", async () => {
		remoteUrlSubscribe.mockResolvedValue({ id: "sub-1", initial: NEW_URL });
		const { rerender } = renderHook(
			({ enabled }) => useRemoteUrlSubscription(enabled),
			{ initialProps: { enabled: true } },
		);
		await waitFor(() => expect(useWSStore.getState().remoteUrl).toBe(NEW_URL));

		rerender({ enabled: false });

		await waitFor(() => expect(remoteUrlUnsubscribe).toHaveBeenCalled());
		expect(useWSStore.getState().remoteUrl).toBe(NEW_URL);
	});
});
