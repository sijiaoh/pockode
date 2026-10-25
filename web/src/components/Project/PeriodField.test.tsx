import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PeriodField from "./PeriodField";

vi.mock("../../hooks/useDeviceTimeZone", () => ({
	useDeviceTimeZone: () => "Europe/London",
}));

const button = (name: string) => screen.getByRole("button", { name });
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

function renderField(initial: string) {
	const onChange = vi.fn();
	render(<PeriodField initial={initial} onChange={onChange} />);
	return onChange;
}

describe("PeriodField", () => {
	it("starts a new schedule on Daily at 09:00 and calls nothing on mount", () => {
		const onChange = renderField("");
		expect(button("Daily")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByLabelText("At")).toHaveValue("09:00");
		expect(screen.getByText("Daily at 09:00")).toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it.each([
		["15 */6 * * *", "Hourly"],
		["0 9 * * *", "Daily"],
		["0 9 * * MON-FRI", "Weekly"],
		["0 9 1 * *", "Custom"],
	])("opens %s in %s and calls nothing on mount", (cron, mode) => {
		const onChange = renderField(cron);
		expect(button(mode)).toHaveAttribute("aria-pressed", "true");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not count re-tapping the lit mode as an edit", async () => {
		const user = userEvent.setup();
		const onChange = renderField("0 9 * * MON-FRI");
		await user.click(button("Weekly"));
		expect(onChange).not.toHaveBeenCalled();
	});

	it("fills the preset's inputs from the stored cron", () => {
		renderField("0 9 * * MON-FRI");
		for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) {
			expect(button(day)).toHaveAttribute("aria-pressed", "true");
		}
		expect(button("Sat")).toHaveAttribute("aria-pressed", "false");
		expect(button("Sun")).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByText("Weekdays at 09:00")).toBeInTheDocument();
	});

	it("keeps an unrecognised cron as stored in Custom", () => {
		renderField("*/15 9-17 * * 1-5");
		expect(
			screen.getByRole("textbox", { name: "Cron expression" }),
		).toHaveValue("*/15 9-17 * * 1-5");
		expect(
			screen.getByText("Checked by the server when you save."),
		).toBeInTheDocument();
	});

	it("writes the hourly cron", async () => {
		const user = userEvent.setup();
		const onChange = renderField("0 * * * *");
		await user.selectOptions(screen.getByLabelText("Every"), "6");
		expect(lastCall(onChange)).toBe("0 */6 * * *");
		const minute = screen.getByLabelText("hours at minute");
		await user.clear(minute);
		expect(lastCall(onChange)).toBeNull();
		await user.type(minute, "15");
		expect(lastCall(onChange)).toBe("15 */6 * * *");
		expect(
			screen.getByText("Every 6 hours, at 00:15, 06:15, 12:15 and 18:15"),
		).toBeInTheDocument();
		await user.clear(minute);
		await user.type(minute, "60");
		expect(lastCall(onChange)).toBeNull();
		expect(
			screen.getByText("Enter a minute from 0 to 59."),
		).toBeInTheDocument();
	});

	it("writes the daily cron and reports null for an empty time", () => {
		const onChange = renderField("0 9 * * *");
		const time = screen.getByLabelText("At");
		fireEvent.change(time, { target: { value: "21:05" } });
		expect(lastCall(onChange)).toBe("5 21 * * *");
		fireEvent.change(time, { target: { value: "" } });
		expect(lastCall(onChange)).toBeNull();
		expect(screen.getByText("Pick a time.")).toBeInTheDocument();
	});

	it("rewrites a weekly cron in the canonical spelling once a day is toggled", async () => {
		const user = userEvent.setup();
		const onChange = renderField("0 9 * * MON-FRI");
		await user.click(button("Wed"));
		expect(lastCall(onChange)).toBe("0 9 * * 1,2,4,5");
		await user.click(button("Sun"));
		expect(lastCall(onChange)).toBe("0 9 * * 0,1,2,4,5");
	});

	it("reports null with no day ticked", async () => {
		const user = userEvent.setup();
		const onChange = renderField("0 9 * * 1");
		await user.click(button("Mon"));
		expect(lastCall(onChange)).toBeNull();
		expect(screen.getByText("Pick at least one day.")).toBeInTheDocument();
	});

	it("stays on Weekly when the seventh day writes a daily cron", async () => {
		const user = userEvent.setup();
		const onChange = renderField("0 9 * * 1-6");
		await user.click(button("Sun"));
		expect(lastCall(onChange)).toBe("0 9 * * *");
		expect(button("Weekly")).toHaveAttribute("aria-pressed", "true");
		expect(button("Sun")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Daily at 09:00")).toBeInTheDocument();
	});

	it("stays on Custom when the text reads as a preset", async () => {
		const user = userEvent.setup();
		const onChange = renderField("0 9 1 * *");
		const text = screen.getByRole("textbox", { name: "Cron expression" });
		await user.clear(text);
		await user.type(text, "  0 9 * * 1 ");
		expect(lastCall(onChange)).toBe("0 9 * * 1");
		expect(button("Custom")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Mondays at 09:00")).toBeInTheDocument();
	});

	it("reports null for a custom text without five fields", async () => {
		const user = userEvent.setup();
		const onChange = renderField("0 9 1 * *");
		const text = screen.getByRole("textbox", { name: "Cron expression" });
		await user.clear(text);
		await user.type(text, "0 9 1 *");
		expect(lastCall(onChange)).toBeNull();
	});

	describe("switching mode", () => {
		it("keeps the time between Daily and Weekly", async () => {
			const user = userEvent.setup();
			const onChange = renderField("30 7 * * *");
			await user.click(button("Weekly"));
			expect(screen.getByLabelText("At")).toHaveValue("07:30");
			expect(lastCall(onChange)).toBe("30 7 * * 1");
			await user.click(button("Daily"));
			expect(lastCall(onChange)).toBe("30 7 * * *");
		});

		it("takes the minute into Hourly and back with hour 09", async () => {
			const user = userEvent.setup();
			const onChange = renderField("30 7 * * *");
			await user.click(button("Hourly"));
			expect(lastCall(onChange)).toBe("30 * * * *");
			await user.click(button("Daily"));
			expect(lastCall(onChange)).toBe("30 9 * * *");
		});

		it("fills Custom with the cron the preset writes", async () => {
			const user = userEvent.setup();
			const onChange = renderField("0 9 * * MON-FRI");
			await user.click(button("Custom"));
			expect(
				screen.getByRole("textbox", { name: "Cron expression" }),
			).toHaveValue("0 9 * * 1,2,3,4,5");
			expect(lastCall(onChange)).toBe("0 9 * * 1,2,3,4,5");
		});

		it("keeps the ticked days through a look at Custom", async () => {
			const user = userEvent.setup();
			const onChange = renderField("0 9 * * 1-6");
			await user.click(button("Sun"));
			await user.click(button("Custom"));
			await user.click(button("Weekly"));
			expect(button("Mon")).toHaveAttribute("aria-pressed", "true");
			expect(button("Sun")).toHaveAttribute("aria-pressed", "true");
			expect(lastCall(onChange)).toBe("0 9 * * *");
		});

		it("ticks every day from Custom text that means every day", async () => {
			const user = userEvent.setup();
			const onChange = renderField("0 9 * * 2");
			await user.click(button("Custom"));
			const text = screen.getByRole("textbox", { name: "Cron expression" });
			await user.clear(text);
			await user.type(text, "30 7 * * *");
			await user.click(button("Weekly"));
			expect(button("Mon")).toHaveAttribute("aria-pressed", "true");
			expect(lastCall(onChange)).toBe("30 7 * * *");
		});

		it("fills a preset from Custom text that fits it", async () => {
			const user = userEvent.setup();
			const onChange = renderField("0 9 1 * *");
			const text = screen.getByRole("textbox", { name: "Cron expression" });
			await user.clear(text);
			await user.type(text, "45 18 * * sat,sun");
			await user.click(button("Weekly"));
			expect(button("Sat")).toHaveAttribute("aria-pressed", "true");
			expect(button("Sun")).toHaveAttribute("aria-pressed", "true");
			expect(button("Mon")).toHaveAttribute("aria-pressed", "false");
			expect(lastCall(onChange)).toBe("45 18 * * 0,6");
		});

		it("starts a preset at its defaults from Custom text that fits none", async () => {
			const user = userEvent.setup();
			const onChange = renderField("0 9 1 * *");
			await user.click(button("Weekly"));
			expect(lastCall(onChange)).toBe("0 9 * * 1");
			await user.click(button("Custom"));
			await user.click(button("Hourly"));
			expect(lastCall(onChange)).toBe("0 * * * *");
		});
	});

	describe("zone line", () => {
		it("is not drawn without a zone, as on the create sheet", () => {
			renderField("0 9 * * *");
			expect(screen.queryByText(/ time/)).not.toBeInTheDocument();
		});

		it("is not drawn while the schedule's zone is the device's", () => {
			render(
				<PeriodField
					initial="0 9 * * *"
					onChange={vi.fn()}
					timeZone="Europe/London"
				/>,
			);
			expect(screen.queryByText(/ time/)).not.toBeInTheDocument();
		});

		it("names the zone the inputs are typed in, on a line of its own", () => {
			render(
				<PeriodField
					initial="0 9 * * *"
					onChange={vi.fn()}
					timeZone="Asia/Tokyo"
				/>,
			);
			expect(screen.getByText("Daily at 09:00")).toBeInTheDocument();
			expect(
				screen.getByText(
					/^Tokyo time \(UTC\+9\)\. This device is on London time/,
				),
			).toBeInTheDocument();
		});
	});
});
