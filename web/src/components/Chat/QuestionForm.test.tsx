import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION } from "../../utils/questionAnswer";
import QuestionForm from "./QuestionForm";

const noop = () => {};

// The real MarkdownContent, deliberately: the claim under test is that what the
// agent wrote reaches the DOM as markup, which a stubbed renderer cannot make.
describe("QuestionForm", () => {
	it("renders the question and option descriptions as markdown, labels as written", () => {
		render(
			<QuestionForm
				question={{
					question: "Which **store** should back `cache`?\n\n- fast\n- durable",
					header: "Store",
					options: [
						{ label: "**Redis**", description: "Keeps it in `memory`" },
						{ label: "SQLite", description: "" },
					],
					multiSelect: false,
				}}
				name="q1"
				selection={EMPTY_SELECTION}
				disabled={false}
				onSelectOption={noop}
				onSelectOther={noop}
				onOtherTextChange={noop}
			/>,
		);

		expect(screen.getByText("store").tagName).toBe("STRONG");
		expect(screen.getByText("cache").tagName).toBe("CODE");
		expect(screen.getByText("durable").tagName).toBe("LI");
		expect(screen.getByText("memory").tagName).toBe("CODE");
		// A label is the answer the server matches verbatim, so its markdown is
		// left as the characters the agent will get back.
		expect(screen.getByRole("radio", { name: /\*\*Redis\*\*/ })).toBeVisible();
	});

	// Neither a header nor a label has a length limit, and jsdom lays nothing
	// out, so what keeps a long one inside the panel is read off its classes:
	// each sits in a box allowed to shrink, and breaks a word too long to fit.
	it("wraps a long header and a long option label rather than widening", () => {
		const header = "H".repeat(200);
		const label = "L".repeat(300);
		render(
			<QuestionForm
				question={{
					question: "Pick one",
					header,
					options: [{ label, description: "" }],
					multiSelect: false,
				}}
				askedAt="2026-01-02T14:02:00Z"
				name="q1"
				selection={EMPTY_SELECTION}
				disabled={false}
				onSelectOption={noop}
				onSelectOther={noop}
				onOtherTextChange={noop}
			/>,
		);

		expect(screen.getByText(header)).toHaveClass("min-w-0", "break-words");
		const labelText = screen.getByText(label);
		expect(labelText).toHaveClass("break-words");
		expect(labelText.parentElement).toHaveClass("min-w-0", "flex-1");
	});

	// A recommendation is the agent's opinion, said beside the option; it is
	// in the accessible name so a screen reader hears it while choosing.
	it("tags the recommended option and only that one", () => {
		render(
			<QuestionForm
				question={{
					question: "Which database?",
					header: "Database",
					options: [
						{ label: "Postgres", description: "", recommended: true },
						{ label: "SQLite", description: "" },
					],
					multiSelect: false,
				}}
				name="q1"
				selection={EMPTY_SELECTION}
				disabled={false}
				onSelectOption={noop}
				onSelectOther={noop}
				onOtherTextChange={noop}
			/>,
		);

		expect(
			screen.getByRole("radio", { name: /Postgres.*Recommended/ }),
		).not.toBeChecked();
		expect(screen.getByRole("radio", { name: "SQLite" })).toBeVisible();
		expect(screen.getAllByText("Recommended")).toHaveLength(1);
	});
});
