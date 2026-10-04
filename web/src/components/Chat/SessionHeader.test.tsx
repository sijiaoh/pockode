import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../lib/agentOptionsStore";
import {
	resetChatUIConfig,
	setChatUIConfig,
} from "../../lib/registries/chatUIRegistry";
import { makeSessionDetail } from "../../test/sessionFixtures";
import type { SessionDetail, SessionUsage } from "../../types/message";
import SessionHeader from "./SessionHeader";

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

type HeaderProps = React.ComponentProps<typeof SessionHeader>;

function headerProps(overrides: Partial<HeaderProps> = {}): HeaderProps {
	return {
		title: "Fix the login bug",
		detail: detailWith(),
		onOpenWorkDetail: vi.fn(),
		readOnly: false,
		agentType: "claude",
		model: "opus",
		effort: "",
		mode: "default",
		hasSessionSettings: true,
		isSessionActivated: false,
		turnOpen: false,
		onAgentTypeChange: vi.fn(() => Promise.resolve()),
		onModelChange: vi.fn(() => Promise.resolve()),
		onEffortChange: vi.fn(() => Promise.resolve()),
		onModeChange: vi.fn(() => Promise.resolve()),
		...overrides,
	};
}

const trigger = () => screen.getByRole("button", { name: /^Session:/ });
const panel = () => screen.queryByRole("dialog");

async function openHeader(overrides: Partial<HeaderProps> = {}) {
	const user = userEvent.setup();
	const props = headerProps(overrides);
	render(<SessionHeader {...props} />);
	await user.click(trigger());
	return { user, props };
}

async function open(usage?: SessionUsage, isForked = false, workId?: string) {
	await openHeader({ detail: detailWith(usage, isForked, workId) });
}

/** The panel's sections, in the order they are drawn. */
const sectionTitles = () =>
	screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

describe("SessionHeader", () => {
	beforeEach(() => {
		useAgentOptionsStore.setState({
			models: {
				claude: [
					{ id: "opus", label: "Opus" },
					{ id: "sonnet", label: "Sonnet" },
				],
				codex: [],
			},
			efforts: { claude: [{ id: "high", label: "High" }] },
			error: null,
		});
	});

	afterEach(() => {
		useAgentOptionsStore.setState({ models: null, efforts: null, error: null });
		resetChatUIConfig();
	});

	describe("the title", () => {
		it("names the session and what runs it", () => {
			render(<SessionHeader {...headerProps()} />);

			expect(trigger()).toHaveAccessibleName(
				"Session: Fix the login bug, Opus · Default",
			);
			expect(screen.getByRole("heading", { level: 1 })).toContainElement(
				trigger(),
			);
		});

		// "Auto · Default" would say only that the CLI decides; the agent at
		// least says which CLI that is.
		it("names the agent when the model is left to the CLI", () => {
			render(<SessionHeader {...headerProps({ model: "" })} />);

			expect(trigger()).toHaveAccessibleName(
				"Session: Fix the login bug, Claude · Default",
			);
		});

		// YOLO is many users' everyday mode: one spot of colour on the glyph,
		// never a warning-coloured word.
		it("marks the mode that skips permissions with its glyph alone", () => {
			render(<SessionHeader {...headerProps({ mode: "yolo" })} />);

			expect(trigger()).toHaveAccessibleName(
				"Session: Fix the login bug, Opus · YOLO",
			);
			const mode = screen.getByText("YOLO");
			expect(mode).not.toHaveClass("text-th-warning");
			expect(mode.querySelector("svg")).toHaveClass("text-th-warning");
		});

		// The placeholder mode is the calm one: a session running with no
		// prompts must not wear Default's name for a round trip.
		it("names neither engine nor mode before the session describes itself", () => {
			render(<SessionHeader {...headerProps({ hasSessionSettings: false })} />);

			expect(trigger()).toHaveAccessibleName(
				"Session: Fix the login bug, loading",
			);
			expect(screen.queryByText("Default")).not.toBeInTheDocument();
		});

		it("waits for a title that has not arrived", () => {
			render(<SessionHeader {...headerProps({ title: "" })} />);

			expect(trigger()).toHaveAccessibleName(
				"Session: loading, Opus · Default",
			);
		});

		it("says a viewed session is read-only instead of naming its engine", () => {
			render(<SessionHeader {...headerProps({ readOnly: true })} />);

			expect(trigger()).toHaveAccessibleName(
				"Session: Fix the login bug, Read-only",
			);
		});
	});

	describe("the panel", () => {
		it("gathers the settings and the facts in one place", async () => {
			await openHeader();

			expect(panel()).toBeInTheDocument();
			expect(sectionTitles()).toEqual(["Engine", "Permissions", "Usage"]);
			expect(
				screen.getByRole("button", { name: "Engine: Claude, Opus" }),
			).toBeInTheDocument();
			expect(screen.getByRole("radio", { name: /Default/ })).toBeChecked();
		});

		// Removed rather than disabled: what is missing on a viewed session is
		// the execution environment, not a moment's availability.
		it("offers no settings on a read-only session", async () => {
			await openHeader({ readOnly: true });

			expect(sectionTitles()).toEqual(["Usage"]);
		});

		it("drills into the engine and back, taking focus along", async () => {
			const { user } = await openHeader();

			await user.click(
				screen.getByRole("button", { name: "Engine: Claude, Opus" }),
			);
			const back = screen.getByRole("button", { name: "Engine" });
			expect(back).toHaveFocus();
			expect(screen.getByRole("group", { name: "Model" })).toBeInTheDocument();

			await user.click(back);
			expect(
				screen.getByRole("button", { name: "Engine: Claude, Opus" }),
			).toHaveFocus();
		});

		// One rule for Escape: the whole panel goes, from any depth — and the
		// focus that was in it goes back to the title rather than to `<body>`.
		it("closes from the engine view on Escape and reopens at the top", async () => {
			const { user } = await openHeader();
			await user.click(
				screen.getByRole("button", { name: "Engine: Claude, Opus" }),
			);

			await user.keyboard("{Escape}");
			expect(panel()).not.toBeInTheDocument();
			expect(trigger()).toHaveFocus();

			await user.click(trigger());
			expect(sectionTitles()).toContain("Permissions");
		});

		// A radio group selects as the arrow keys move through it, so closing
		// on selection would leave a keyboard user only the neighbouring option.
		it("sends a new mode and stays open", async () => {
			const { user, props } = await openHeader();

			await user.click(screen.getByRole("radio", { name: /YOLO/ }));

			expect(props.onModeChange).toHaveBeenCalledWith("yolo");
			expect(panel()).toBeInTheDocument();
		});

		// The reason is reported above the composer, which the drawer covers.
		it("closes on a refused mode so the reason is not covered", async () => {
			const { user } = await openHeader({
				onModeChange: vi.fn(() => Promise.reject(new Error("nope"))),
			});

			await user.click(screen.getByRole("radio", { name: /YOLO/ }));

			await vi.waitFor(() => expect(panel()).not.toBeInTheDocument());
		});

		// The server takes no setting while a turn is open. Kept and explained
		// rather than removed: a control that is not there teaches nothing.
		it("holds the settings while a turn is open, and says why", async () => {
			const { user, props } = await openHeader({ turnOpen: true });

			const engine = screen.getByRole("button", {
				name: "Engine: Claude, Opus",
			});
			expect(engine).toHaveAttribute("aria-disabled", "true");
			expect(engine).toHaveAccessibleDescription(
				"Available when the current turn ends",
			);
			await user.click(engine);
			expect(
				screen.queryByRole("group", { name: "Model" }),
			).not.toBeInTheDocument();

			expect(screen.getByRole("radio", { name: /YOLO/ })).toBeDisabled();
			expect(props.onModeChange).not.toHaveBeenCalled();
		});

		it("draws no mode as selected before the session describes itself", async () => {
			await openHeader({ hasSessionSettings: false });

			for (const radio of screen.getAllByRole("radio")) {
				expect(radio).not.toBeChecked();
				expect(radio).toBeDisabled();
			}
		});

		it("draws a registered mode selector in place of the mode list", async () => {
			setChatUIConfig({
				ModeSelector: ({ mode }) => <span>custom mode: {mode}</span>,
			});
			await openHeader();

			const section = screen.getByRole("region", { name: "Permissions" });
			expect(within(section).getByText("custom mode: default")).toBeVisible();
			expect(within(section).queryByRole("radio")).not.toBeInTheDocument();
		});

		it("drops a section whose selector is registered as null", async () => {
			setChatUIConfig({ EngineSelector: null, ModeSelector: null });
			await openHeader();

			expect(sectionTitles()).toEqual(["Usage"]);
		});
	});

	describe("session facts", () => {
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
			expect(bar).toHaveAttribute(
				"aria-valuetext",
				"240,000 of 200,000 tokens",
			);
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

			expect(sectionTitles()).toEqual([
				"Engine",
				"Permissions",
				"Work",
				"Usage",
			]);
		});

		it("leaves usage first on a session that runs no work", async () => {
			await open(spent);

			expect(sectionTitles()).toEqual(["Engine", "Permissions", "Usage"]);
		});

		// The panel is handed its detail rather than reading the store, because on a
		// session viewed out of another worktree the store has no entry for it — and
		// a work is the usual way onto that screen, so losing the way back would be
		// losing it exactly where it is needed.
		it("waits for a detail that has not arrived at all", async () => {
			await openHeader({ detail: null });

			expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
			expect(sectionTitles()).toEqual(["Engine", "Permissions", "Usage"]);
		});
	});
});
