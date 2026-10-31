import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "../../lib/wsStore";
import ReconnectBanner from "./ReconnectBanner";

const retryNow = vi.fn();
let state = {
	status: "connected" as ConnectionStatus,
	reconnectAttempts: 0,
	restartRequestedAt: null as number | null,
};

vi.mock("../../lib/wsStore", () => ({
	useWSStore: vi.fn((selector: (s: typeof state) => unknown) =>
		selector(state),
	),
	wsActions: {
		retryNow: () => retryNow(),
	},
}));

function reconnecting(attempts: number) {
	state = { ...state, status: "reconnecting", reconnectAttempts: attempts };
}

beforeEach(() => {
	retryNow.mockClear();
	state = {
		status: "connected",
		reconnectAttempts: 0,
		restartRequestedAt: null,
	};
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ReconnectBanner", () => {
	it("stays out of the way while connected", () => {
		render(<ReconnectBanner />);

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("reports a brief drop without alarming the user", () => {
		reconnecting(1);
		render(<ReconnectBanner />);

		expect(screen.getByRole("status")).toHaveTextContent("Reconnecting...");
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});

	// Reconnection never gives up, so without this escalation an hour-long
	// outage would look exactly like a one-second blip.
	it("escalates once the drop has outlasted several attempts", async () => {
		reconnecting(9);
		render(<ReconnectBanner />);

		expect(screen.getByRole("status")).toHaveTextContent(
			"Can't reach the server",
		);

		await userEvent.click(screen.getByRole("button", { name: "Retry now" }));
		expect(retryNow).toHaveBeenCalledOnce();
	});

	describe("after this page asked for a restart", () => {
		it("says the drop is the restart", () => {
			state.restartRequestedAt = Date.now();
			reconnecting(1);
			render(<ReconnectBanner />);

			expect(screen.getByRole("status")).toHaveTextContent("Restarting...");
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
		});

		// A restart that needs few attempts but a long time — a relay tunnel
		// registering again — still escalates, on the clock.
		it("escalates a minute after the restart, however few the attempts", () => {
			vi.useFakeTimers();
			state.restartRequestedAt = Date.now();
			reconnecting(1);
			render(<ReconnectBanner />);

			act(() => vi.advanceTimersByTime(59_000));
			expect(screen.getByRole("status")).toHaveTextContent("Restarting...");

			act(() => vi.advanceTimersByTime(1_000));
			expect(screen.getByRole("status")).toHaveTextContent(
				"Pockode hasn't come back from the restart. Still trying...",
			);
			expect(
				screen.getByRole("button", { name: "Retry now" }),
			).toBeInTheDocument();
		});

		it("escalates with the attempts too", () => {
			state.restartRequestedAt = Date.now();
			reconnecting(9);
			render(<ReconnectBanner />);

			expect(screen.getByRole("status")).toHaveTextContent(
				"Pockode hasn't come back from the restart",
			);
		});
	});
});
