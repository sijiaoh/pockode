import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { SessionUsage } from "../../types/message";
import SessionInfoButton from "./SessionInfoButton";

const empty: SessionUsage = {
	input_tokens: 0,
	output_tokens: 0,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
};

const spent: SessionUsage = {
	input_tokens: 88_412,
	output_tokens: 31_203,
	cache_read_tokens: 1_116_274,
	cache_write_tokens: 12_412,
	cost_usd: 3.42,
	context_tokens: 92_134,
	context_window: 200_000,
};

async function open(usage?: SessionUsage, isForked = false) {
	const user = userEvent.setup();
	render(<SessionInfoButton usage={usage} isForked={isForked} />);
	await user.click(screen.getByRole("button", { name: "Session info" }));
}

describe("SessionInfoButton", () => {
	it("opens before anything has been reported, and says so", async () => {
		await open(empty);

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByText("Nothing reported yet.")).toBeInTheDocument();
	});

	it("waits for the session's detail without an empty panel", async () => {
		await open(undefined);

		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});

	it("reports the exact figures, not the abbreviated ones", async () => {
		await open(spent);

		expect(screen.getByText("1,248,301")).toBeInTheDocument();
		expect(screen.getByText("1,116,274")).toBeInTheDocument();
		expect(screen.getByText("$3.42")).toBeInTheDocument();
		expect(
			screen.getByRole("progressbar", { name: "Context" }),
		).toHaveAttribute("aria-valuetext", "92,134 of 200,000 tokens");
	});

	it("leaves out the counters the agent never filled", async () => {
		await open({ ...spent, cache_write_tokens: 0 });

		expect(screen.queryByText("Cache write")).not.toBeInTheDocument();
	});

	it("shows no cost at all when the agent reports none", async () => {
		const { cost_usd: _unpriced, ...noCost } = spent;
		await open(noCost);

		expect(screen.queryByText("Cost")).not.toBeInTheDocument();
		expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
	});

	it("says the window is missing rather than dropping the panel", async () => {
		const { context_window: _none, ...noWindow } = spent;
		await open(noWindow);

		expect(
			screen.getByText("Context window not reported by this agent."),
		).toBeInTheDocument();
		expect(screen.getByText("1,248,301")).toBeInTheDocument();
	});

	it("explains a fork's total, which starts at zero", async () => {
		await open(spent, true);

		expect(
			screen.getByText("Since this session was forked."),
		).toBeInTheDocument();
	});

	// The moment a fork is worst read: a long copied conversation sits behind the
	// panel, and the total it reports is nothing at all.
	it("explains a fresh fork, whose total is still empty", async () => {
		await open(empty, true);

		expect(screen.getByText("Nothing reported yet.")).toBeInTheDocument();
		expect(
			screen.getByText("Since this session was forked."),
		).toBeInTheDocument();
	});

	it("says nothing about forking on a session that was created", async () => {
		await open(spent);

		expect(
			screen.queryByText("Since this session was forked."),
		).not.toBeInTheDocument();
	});
});
