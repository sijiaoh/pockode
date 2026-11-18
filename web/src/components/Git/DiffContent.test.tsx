import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDiffSettingsStore } from "../../lib/diffSettingsStore";
import { asOneFileDiff } from "../../lib/drawablePatch";
import { TYPE_CHANGE_DIFF } from "../../test/gitFixtures";
import DiffContent from "./DiffContent";

// What reaches the viewer is not the point here; what is said around it is.
vi.mock("../ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ui")>()),
	DiffViewer: () => <div>diff</div>,
}));

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

	describe("an empty diff", () => {
		beforeEach(() => {
			useDiffSettingsStore.setState({ hideWhitespace: true });
		});

		it("says when hiding whitespace is what emptied it, and offers it back", async () => {
			const user = userEvent.setup();
			render(
				<DiffContent
					fileName="a.ts"
					data={{
						diff: "",
						old_content: "const a = 1;\n",
						new_content: "const a  =  1;\n",
					}}
				/>,
			);

			expect(screen.getByText("Only whitespace changed")).toBeTruthy();
			await user.click(screen.getByRole("button", { name: "Show whitespace" }));
			expect(useDiffSettingsStore.getState().hideWhitespace).toBe(false);
		});

		it("says there is no content change when the content is the same", () => {
			render(
				<DiffContent
					fileName="run.sh"
					data={{ diff: "", old_content: "echo\n", new_content: "echo\n" }}
				/>,
			);

			expect(screen.getByText("No content changes")).toBeTruthy();
			expect(screen.queryByText("Only whitespace changed")).toBeNull();
		});

		it.each([
			[
				"a mode change",
				"diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n",
			],
			[
				"a rename with no edit",
				"diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n",
			],
		])("says there is no content change for %s, whose diff has no hunk", (_, diff) => {
			render(
				<DiffContent
					fileName="run.sh"
					data={{ diff, old_content: "echo\n", new_content: "echo\n" }}
				/>,
			);

			expect(screen.getByText("No content changes")).toBeTruthy();
		});
	});

	describe("a symlink", () => {
		it("says a file turned into a symlink above its diff", () => {
			render(
				<DiffContent
					data={asOneFileDiff(TYPE_CHANGE_DIFF, "a.txt")}
					fileName="a.txt"
				/>,
			);
			expect(screen.getByText("Symlink")).toBeInTheDocument();
			expect(
				screen.getByText("Type changed: file → symlink"),
			).toBeInTheDocument();
			expect(screen.getByText("diff")).toBeInTheDocument();
		});

		it("marks a symlink's own diff, and nothing else", () => {
			const link = {
				diff: "diff --git a/l b/l\nindex 1111111..2222222 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-a\n+b\n",
				old_content: "a",
				new_content: "b",
			};
			const { rerender } = render(<DiffContent data={link} fileName="l" />);
			expect(screen.getByText("Symlink")).toBeInTheDocument();
			expect(screen.queryByText(/Type changed/)).not.toBeInTheDocument();

			rerender(
				<DiffContent
					data={{ ...link, diff: link.diff.replace("120000", "100644") }}
					fileName="l"
				/>,
			);
			expect(screen.queryByText("Symlink")).not.toBeInTheDocument();
		});
	});
});
