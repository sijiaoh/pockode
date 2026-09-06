import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "../../lib/wsStore";
import ReconnectBanner from "./ReconnectBanner";

const retryNow = vi.fn();
let state = { status: "connected" as ConnectionStatus, reconnectAttempts: 0 };

vi.mock("../../lib/wsStore", () => ({
	useWSStore: vi.fn((selector: (s: typeof state) => unknown) =>
		selector(state),
	),
	wsActions: {
		retryNow: () => retryNow(),
	},
}));

function reconnecting(attempts: number) {
	state = { status: "reconnecting", reconnectAttempts: attempts };
}

beforeEach(() => {
	retryNow.mockClear();
	state = { status: "connected", reconnectAttempts: 0 };
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
});
