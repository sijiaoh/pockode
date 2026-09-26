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
});
