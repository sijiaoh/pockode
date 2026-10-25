import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Period } from "../../types/schedule";
import PeriodField from "./PeriodField";

vi.mock("../../hooks/useDeviceTimeZone", () => ({
	useDeviceTimeZone: () => "Europe/London",
}));

// 08:00 in London (GMT by then), 17:00 in Tokyo.
const NOW = new Date("2026-10-25T08:00:00Z");

// `fireEvent` throughout: the clock is frozen, and `userEvent` deadlocks on a
// frozen fake clock (docs/testing.md).
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

const button = (name: string) => screen.getByRole("button", { name });
const mode = () => screen.getByLabelText("Period");
const pickMode = (value: string) =>
	fireEvent.change(mode(), { target: { value } });
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

function renderField(initial: Period | null, timeZone?: string) {
	const onChange = vi.fn();
	render(
		<PeriodField initial={initial} onChange={onChange} timeZone={timeZone} />,
	);
	return onChange;
}

describe("PeriodField", () => {
	it("starts a new schedule on Daily at 09:00 and calls nothing on mount", () => {
		const onChange = renderField(null);
		expect(mode()).toHaveValue("daily");
		expect(screen.getByLabelText("At")).toHaveValue("09:00");
		expect(screen.getByText("Daily at 09:00")).toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("offers the five kinds, Once first, and nothing to type an expression in", () => {
		renderField(null);
		expect(
			screen
				.getAllByRole("option")
				.slice(0, 5)
				.map((o) => o.textContent),
		).toEqual(["Once", "Hourly", "Daily", "Weekly", "Monthly"]);
		expect(screen.queryByText(/cron/i)).not.toBeInTheDocument();
	});

	it.each<[Period, string]>([
		[{ kind: "once", at: "2026-11-03T09:00" }, "once"],
		[{ kind: "hourly", every: 6, minute: 15 }, "hourly"],
		[{ kind: "daily", time: "09:00" }, "daily"],
		[{ kind: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:00" }, "weekly"],
		[{ kind: "monthly", day: 1, time: "09:00" }, "monthly"],
	])("opens %j in its mode and calls nothing on mount", (period, kind) => {
		const onChange = renderField(period);
		expect(mode()).toHaveValue(kind);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not count picking the mode already shown as an edit", () => {
		const onChange = renderField({ kind: "daily", time: "09:00" });
		pickMode("daily");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("fills the inputs from the stored period", () => {
		renderField({ kind: "weekly", weekdays: [1, 2, 3, 4, 5], time: "09:00" });
		for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
			expect(button(day)).toHaveAttribute("aria-pressed", "true");
		}
		expect(button("Sat")).toHaveAttribute("aria-pressed", "false");
		expect(button("Sun")).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByText("Weekdays at 09:00")).toBeInTheDocument();
	});

	it("writes an hourly period", () => {
		const onChange = renderField({ kind: "hourly", every: 1 });
		expect(screen.getByLabelText("at minute")).toHaveValue("00");
		fireEvent.change(screen.getByLabelText("Every"), {
			target: { value: "6" },
		});
		expect(lastCall(onChange)).toEqual({ kind: "hourly", every: 6, minute: 0 });
		const minute = screen.getByLabelText("at minute");
		fireEvent.change(minute, { target: { value: "" } });
		expect(lastCall(onChange)).toBeNull();
		fireEvent.change(minute, { target: { value: "15" } });
		expect(lastCall(onChange)).toEqual({
			kind: "hourly",
			every: 6,
			minute: 15,
		});
		expect(
			screen.getByText("Every 6 hours, at 00:15, 06:15, 12:15 and 18:15"),
		).toBeInTheDocument();
		fireEvent.change(minute, { target: { value: "60" } });
		expect(lastCall(onChange)).toBeNull();
		expect(
			screen.getByText("Enter a minute from 0 to 59."),
		).toBeInTheDocument();
	});

	it("names the unit in every interval", () => {
		renderField({ kind: "hourly" });
		expect(screen.getByRole("option", { name: "1 hour" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "6 hours" })).toBeInTheDocument();
		expect(
			screen.queryByRole("option", { name: "5 hours" }),
		).not.toBeInTheDocument();
	});

	it("writes a daily period and reports null for an empty time", () => {
		const onChange = renderField({ kind: "daily", time: "09:00" });
		const time = screen.getByLabelText("At");
		fireEvent.change(time, { target: { value: "21:05" } });
		expect(lastCall(onChange)).toEqual({ kind: "daily", time: "21:05" });
		fireEvent.change(time, { target: { value: "" } });
		expect(lastCall(onChange)).toBeNull();
		expect(screen.getByText("Pick a time.")).toBeInTheDocument();
	});

	it("writes the weekdays ascending, Sunday as 0", () => {
		const onChange = renderField({
			kind: "weekly",
			weekdays: [1, 2, 3, 4, 5],
			time: "09:00",
		});
		fireEvent.click(button("Wed"));
		fireEvent.click(button("Sun"));
		expect(lastCall(onChange)).toEqual({
			kind: "weekly",
			weekdays: [0, 1, 2, 4, 5],
			time: "09:00",
		});
	});

	it("reports null with no day ticked", () => {
		const onChange = renderField({
			kind: "weekly",
			weekdays: [1],
			time: "09:00",
		});
		fireEvent.click(button("Mon"));
		expect(lastCall(onChange)).toBeNull();
		expect(screen.getByText("Pick at least one day.")).toBeInTheDocument();
	});

	it("stays on Weekly when the seventh day writes a daily period", () => {
		const onChange = renderField({
			kind: "weekly",
			weekdays: [1, 2, 3, 4, 5, 6],
			time: "09:00",
		});
		fireEvent.click(button("Sun"));
		expect(lastCall(onChange)).toEqual({ kind: "daily", time: "09:00" });
		expect(mode()).toHaveValue("weekly");
		expect(button("Sun")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Daily at 09:00")).toBeInTheDocument();
	});

	describe("monthly", () => {
		it("offers 1st to 30th and then Last day, which is day 31", () => {
			const onChange = renderField({ kind: "monthly", day: 1, time: "09:00" });
			const day = screen.getByLabelText("On the");
			expect(screen.getByRole("option", { name: "30th" })).toBeInTheDocument();
			expect(
				screen.queryByRole("option", { name: "31st" }),
			).not.toBeInTheDocument();
			fireEvent.change(day, { target: { value: "31" } });
			expect(lastCall(onChange)).toEqual({
				kind: "monthly",
				day: 31,
				time: "09:00",
			});
			expect(
				screen.getByText("Monthly on the last day at 09:00"),
			).toBeInTheDocument();
		});

		it("says what the 29th and the 30th do in a shorter month, and only then", () => {
			renderField({ kind: "monthly", day: 28, time: "09:00" });
			const line = "In shorter months, runs on the last day.";
			expect(screen.queryByText(line)).not.toBeInTheDocument();
			fireEvent.change(screen.getByLabelText("On the"), {
				target: { value: "30" },
			});
			expect(screen.getByText(line)).toBeInTheDocument();
			fireEvent.change(screen.getByLabelText("On the"), {
				target: { value: "31" },
			});
			expect(screen.queryByText(line)).not.toBeInTheDocument();
		});
	});

	describe("once", () => {
		it("writes the date and time as one wall-clock reading", () => {
			const onChange = renderField({ kind: "once", at: "2026-11-03T09:00" });
			fireEvent.change(screen.getByLabelText("On"), {
				target: { value: "2026-11-04" },
			});
			expect(lastCall(onChange)).toEqual({
				kind: "once",
				at: "2026-11-04T09:00",
			});
			expect(
				screen.getByText("Once on Wed 4 Nov at 09:00"),
			).toBeInTheDocument();
			fireEvent.change(screen.getByLabelText("On"), { target: { value: "" } });
			expect(lastCall(onChange)).toBeNull();
			expect(screen.getByText("Pick a date.")).toBeInTheDocument();
		});

		it("starts on today when the carried time is still ahead", () => {
			const onChange = renderField({ kind: "daily", time: "09:00" });
			pickMode("once");
			expect(screen.getByLabelText("On")).toHaveValue("2026-10-25");
			expect(lastCall(onChange)).toEqual({
				kind: "once",
				at: "2026-10-25T09:00",
			});
		});

		it("starts on tomorrow when the carried time has gone by today", () => {
			const onChange = renderField({ kind: "daily", time: "07:30" });
			pickMode("once");
			expect(lastCall(onChange)).toEqual({
				kind: "once",
				at: "2026-10-26T07:30",
			});
		});

		it("counts today in the schedule's zone, not the device's", () => {
			// 09:00 is still ahead in London, but Tokyo is at 17:00.
			const onChange = renderField(
				{ kind: "daily", time: "09:00" },
				"Asia/Tokyo",
			);
			pickMode("once");
			expect(lastCall(onChange)).toEqual({
				kind: "once",
				at: "2026-10-26T09:00",
			});
		});

		it("judges a passed time in the schedule's zone, not the device's", () => {
			const period: Period = { kind: "once", at: "2026-10-25T12:00" };
			const { unmount } = render(
				<PeriodField
					initial={period}
					onChange={vi.fn()}
					timeZone="Asia/Tokyo"
				/>,
			);
			expect(
				screen.getByText("That time has passed. Pick a later one."),
			).toBeInTheDocument();
			unmount();
			render(
				<PeriodField
					initial={period}
					onChange={vi.fn()}
					timeZone="Europe/London"
				/>,
			);
			expect(
				screen.getByText("Once on Sun 25 Oct at 12:00"),
			).toBeInTheDocument();
		});

		it("reports null when an edited time passes while the field is open", () => {
			const onChange = renderField({ kind: "once", at: "2026-11-03T09:00" });
			fireEvent.change(screen.getByLabelText("On"), {
				target: { value: "2026-10-25" },
			});
			fireEvent.change(screen.getByLabelText("at"), {
				target: { value: "08:01" },
			});
			expect(lastCall(onChange)).toEqual({
				kind: "once",
				at: "2026-10-25T08:01",
			});
			act(() => {
				vi.advanceTimersByTime(60_000);
			});
			expect(lastCall(onChange)).toBeNull();
			expect(
				screen.getByText("That time has passed. Pick a later one."),
			).toBeInTheDocument();
		});

		it("does not report a stored time that has passed until it is edited", () => {
			const onChange = renderField({ kind: "once", at: "2026-10-01T09:00" });
			act(() => {
				vi.advanceTimersByTime(60_000);
			});
			expect(onChange).not.toHaveBeenCalled();
		});
	});

	describe("switching mode", () => {
		it("carries the time between Daily, Weekly, Monthly and Once", () => {
			const onChange = renderField({ kind: "daily", time: "21:30" });
			pickMode("weekly");
			expect(lastCall(onChange)).toEqual({
				kind: "weekly",
				weekdays: [1],
				time: "21:30",
			});
			pickMode("monthly");
			expect(lastCall(onChange)).toEqual({
				kind: "monthly",
				day: 1,
				time: "21:30",
			});
			pickMode("once");
			expect(lastCall(onChange)).toEqual({
				kind: "once",
				at: "2026-10-25T21:30",
			});
		});

		it("takes the minute into Hourly and gives back hour 09", () => {
			const onChange = renderField({ kind: "daily", time: "07:30" });
			pickMode("hourly");
			expect(lastCall(onChange)).toEqual({
				kind: "hourly",
				every: 1,
				minute: 30,
			});
			pickMode("daily");
			expect(lastCall(onChange)).toEqual({ kind: "daily", time: "09:30" });
		});

		it("keeps the days, the day of month and the date through a look elsewhere", () => {
			const onChange = renderField({
				kind: "weekly",
				weekdays: [0, 6],
				time: "09:00",
			});
			pickMode("monthly");
			fireEvent.change(screen.getByLabelText("On the"), {
				target: { value: "15" },
			});
			pickMode("once");
			fireEvent.change(screen.getByLabelText("On"), {
				target: { value: "2026-12-24" },
			});
			pickMode("weekly");
			expect(lastCall(onChange)).toEqual({
				kind: "weekly",
				weekdays: [0, 6],
				time: "09:00",
			});
			pickMode("monthly");
			expect(lastCall(onChange)).toEqual({
				kind: "monthly",
				day: 15,
				time: "09:00",
			});
			pickMode("once");
			expect(lastCall(onChange)).toEqual({
				kind: "once",
				at: "2026-12-24T09:00",
			});
		});
	});

	it("opens a kind this build does not know on Daily 09:00, and says saving replaces it", () => {
		const onChange = renderField({ kind: "yearly" } as unknown as Period);
		expect(mode()).toHaveValue("daily");
		expect(
			screen.getByText(
				"This period was set by a newer version of Pockode. Saving replaces it.",
			),
		).toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("says a period with no kind could not be read, rather than blaming a newer version", () => {
		renderField({ kind: "" } as unknown as Period);
		expect(mode()).toHaveValue("daily");
		expect(
			screen.getByText("This period could not be read. Saving replaces it."),
		).toBeInTheDocument();
	});

	describe("zone line", () => {
		it("is not drawn without a zone, as on the create sheet", () => {
			renderField({ kind: "daily", time: "09:00" });
			expect(screen.queryByText(/ time/)).not.toBeInTheDocument();
		});

		it("is not drawn while the schedule's zone is the device's", () => {
			renderField({ kind: "daily", time: "09:00" }, "Europe/London");
			expect(screen.queryByText(/ time/)).not.toBeInTheDocument();
		});

		it("names the zone the inputs are typed in, on a line of its own", () => {
			renderField({ kind: "daily", time: "09:00" }, "Asia/Tokyo");
			expect(screen.getByText("Daily at 09:00")).toBeInTheDocument();
			expect(
				screen.getByText(
					/^Tokyo time \(UTC\+9\)\. This device is on London time/,
				),
			).toBeInTheDocument();
		});
	});
});
