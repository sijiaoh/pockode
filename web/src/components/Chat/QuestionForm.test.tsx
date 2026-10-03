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

	describe("read-only", () => {
		const question = {
			question: "Which database?",
			header: "Database",
			options: [
				{ label: "Postgres", description: "" },
				{ label: "SQLite", description: "" },
			],
			multiSelect: false,
		};
		const renderLocked = (
			selection: { labels: string[]; otherText: string | null },
			withheld = false,
		) =>
			render(
				<QuestionForm
					question={question}
					name="q1"
					selection={selection}
					disabled
					withheld={withheld}
					onSelectOption={noop}
					onSelectOther={noop}
					onOtherTextChange={noop}
				/>,
			);
		const row = (label: string) =>
			screen.getByRole("radio", { name: label }).closest("label");

		// Receding is there to put the eye on an answer. With none to point at, it
		// would only leave every option hard to read.
		it("lets the unpicked options recede only beside an answer", () => {
			const { unmount } = renderLocked(EMPTY_SELECTION);
			expect(row("Postgres")).not.toHaveClass("opacity-45");
			unmount();

			renderLocked({ labels: ["SQLite"], otherText: null });
			expect(row("Postgres")).toHaveClass("opacity-45");
			expect(row("SQLite")).toHaveClass("border-th-success");
		});

		// A declined block keeps its picks without sending them, so they wear the
		// parked note's look — never the success and tick of a settled answer.
		it("draws a pick that is not going out as written, not sent", () => {
			renderLocked({ labels: ["SQLite"], otherText: null }, true);
			expect(row("SQLite")).toHaveClass("border-dashed");
			expect(row("SQLite")).not.toHaveClass("border-th-success");
			expect(row("SQLite")?.querySelector("svg")).toBeNull();
			expect(row("Postgres")).not.toHaveClass("opacity-45");
		});
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

	// The rows above and below `Add a note` are 8px away, so a hit-area
	// overlay around a 16px line reaches into one of them at either pointer's
	// floor. The box itself is the floor instead — 36 for a mouse, 44 for a
	// thumb — and the 8px stays between hit areas.
	it("makes Add a note its own hit area rather than overlaying one", () => {
		render(
			<QuestionForm
				question={{
					question: "Which database?",
					header: "Database",
					options: [{ label: "SQLite", description: "" }],
					multiSelect: false,
				}}
				name="q1"
				selection={{ labels: ["SQLite"], otherText: null }}
				disabled={false}
				onSelectOption={noop}
				onSelectOther={noop}
				onOtherTextChange={noop}
				onNoteChange={noop}
			/>,
		);

		const button = screen.getByRole("button", { name: "Add a note" });
		expect(button).toHaveClass("min-h-9", "pointer-coarse:min-h-11");
		expect(button).not.toHaveClass("touch-target");
	});
});
