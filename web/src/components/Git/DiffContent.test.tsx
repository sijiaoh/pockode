import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DiffContent from "./DiffContent";

describe("DiffContent", () => {
	it("explains a withheld diff the way the file viewer explains the file", () => {
		render(
			<DiffContent
				fileName="data/big.json"
				data={{
					diff: "",
					old_content: "",
					new_content: "",
					omitted: "too_large",
					size: 3 * 1024 * 1024,
					mime: "text/plain; charset=utf-8",
					limit: 2 * 1024 * 1024,
				}}
			/>,
		);

		expect(screen.getByText("File is too large to preview")).toBeTruthy();
		expect(
			screen.getByText(
				"This file is 3 MB. Files over 2 MB aren't loaded to keep the app responsive.",
			),
		).toBeTruthy();
		expect(screen.queryByText("No changes")).toBeNull();
		// There is no Edit button beside a diff for the footnote to explain.
		expect(screen.queryByText(/Editing is disabled/)).toBeNull();
	});
});
