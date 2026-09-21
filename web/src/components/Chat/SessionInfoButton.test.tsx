import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeSessionDetail } from "../../test/sessionFixtures";
import type { SessionDetail, SessionUsage } from "../../types/message";
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

/**
 * The detail the panel describes. `usage` undefined stands for the round trip
 * that has not landed, which the panel says out loud; `detail` null is the same
 * gap one step earlier.
 */
function detailWith(
	usage?: SessionUsage,
	isForked = false,
	workId?: string,
): SessionDetail {
	return makeSessionDetail({
		id: "s1",
		usage,
		work_id: workId,
		...(isForked ? { forked_from: { session_id: "parent" } } : {}),
	});
}

async function open(usage?: SessionUsage, isForked = false, workId?: string) {
	const user = userEvent.setup();
	render(
		<SessionInfoButton
			detail={detailWith(usage, isForked, workId)}
			onOpenWorkDetail={vi.fn()}
		/>,
	);
	await user.click(screen.getByRole("button", { name: "Session info" }));
}

/** The panel's sections, in the order they are drawn. */
const sectionTitles = () =>
	screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

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
		const bar = screen.getByRole("progressbar", { name: "Context" });
		expect(bar).toHaveAttribute("aria-valuetext", "92,134 of 200,000 tokens");
		// The range is the window while the reading fits in it, so the bar reports
		// how full the window is and not merely that it is as full as itself.
		expect(bar).toHaveAttribute("aria-valuenow", "92134");
		expect(bar).toHaveAttribute("aria-valuemax", "200000");
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

	it("says the context is unmeasured rather than reporting it as empty", async () => {
		const { context_tokens: _unmeasured, ...noReading } = spent;
		await open(noReading);

		expect(screen.getByText("Context not measured yet.")).toBeInTheDocument();
		expect(
			screen.queryByRole("progressbar", { name: "Context" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("1,248,301")).toBeInTheDocument();
	});

	// A reading past the window is displayed as it is, so the bar's ARIA range has
	// to hold it: an out-of-range aria-valuenow is the one a screen reader may
	// drop, on the session that most needs reading out.
	it("keeps a reading past the window inside the bar's announced range", async () => {
		await open({ ...spent, context_tokens: 240_000 });

		const bar = screen.getByRole("progressbar", { name: "Context" });
		expect(bar).toHaveAttribute("aria-valuenow", "240000");
		expect(bar).toHaveAttribute("aria-valuemax", "240000");
		expect(bar).toHaveAttribute("aria-valuetext", "240,000 of 200,000 tokens");
		expect(screen.getByText("120%")).toBeInTheDocument();
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

	// What this session is comes before what it has spent, and the sections
	// themselves know nothing about where they sit.
	it("puts the work this session runs above its usage", async () => {
		await open(spent, false, "work-1");

		expect(sectionTitles()).toEqual(["Work", "Usage"]);
	});

	it("leaves usage first on a session that runs no work", async () => {
		await open(spent);

		expect(sectionTitles()).toEqual(["Usage"]);
	});

	// The panel is handed its detail rather than reading the store, because on a
	// session viewed out of another worktree the store has no entry for it — and
	// a work is the usual way onto that screen, so losing the way back would be
	// losing it exactly where it is needed.
	it("waits for a detail that has not arrived at all", async () => {
		const user = userEvent.setup();
		render(<SessionInfoButton detail={null} onOpenWorkDetail={vi.fn()} />);
		await user.click(screen.getByRole("button", { name: "Session info" }));

		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(sectionTitles()).toEqual(["Usage"]);
	});
});
