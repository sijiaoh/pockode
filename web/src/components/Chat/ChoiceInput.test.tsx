import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ChoiceInput, { type ChoiceTone } from "./ChoiceInput";

describe("ChoiceInput", () => {
	it("stays the real control: named by its label, toggled through it", async () => {
		const user = userEvent.setup();
		const onChange = vi.fn();
		render(
			<label>
				<ChoiceInput type="checkbox" tone="actionable" onChange={onChange} />
				Won't answer
			</label>,
		);

		await user.click(screen.getByText("Won't answer"));

		expect(
			screen.getByRole("checkbox", { name: "Won't answer" }),
		).toBeChecked();
		expect(onChange).toHaveBeenCalledOnce();
	});

	// Chromium under a dark color-scheme fills a native unpicked control grey,
	// which reads as disabled; only a drawn control with a clear ground is
	// hollow in every theme, and only picking may fill it.
	it.each(
		(["actionable", "settled", "withheld"] as ChoiceTone[]).flatMap((tone) =>
			(["radio", "checkbox"] as const).map((type) => [tone, type] as const),
		),
	)("draws a %s %s hollow until picked", (tone, type) => {
		render(<ChoiceInput type={type} tone={tone} aria-label="choice" />);

		const classes = screen
			.getByLabelText("choice")
			.className.split(/\s+/)
			.filter(Boolean);
		expect(classes).toContain("appearance-none");
		expect(classes).toContain("bg-transparent");
		expect(
			classes.filter((c) => c.startsWith("bg-") && c !== "bg-transparent"),
		).toEqual([]);
	});
});
