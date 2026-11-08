import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileEditor from "./FileEditor";

const layout = vi.hoisted(() => ({ expanded: false }));

vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => layout.expanded,
}));

const writeFile = vi.fn();
const goToParent = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { writeFile } }),
}));

// One object across renders, as react-query's: a new one re-runs the editor's
// initialisation and drops what was typed.
const contents = vi.hoisted(() => ({
	data: {
		type: "file",
		name: "app.ts",
		path: "src/app.ts",
		size: 12,
		mime: "text/plain; charset=utf-8",
		content: "const a = 1;",
		encoding: "text",
	},
	isLoading: false,
	error: null,
}));

vi.mock("../../hooks/useContents", () => ({
	contentsQueryKey: (path: string) => ["contents", path],
	useContents: () => contents,
}));

vi.mock("../../hooks/useGoToParent", () => ({
	useGoToParent: () => goToParent,
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

vi.mock("../../hooks/useRouteState", () => ({
	useCurrentWorktree: () => "",
	useRouteState: () => ({ sessionId: null }),
}));

vi.mock("../Layout/PageHeader", () => ({
	FilePageHeader: () => <header />,
}));

function renderEditor(keyboardUp = false) {
	const queryClient = new QueryClient();
	render(
		<QueryClientProvider client={queryClient}>
			<FileEditor path="src/app.ts" onBack={vi.fn()} keyboardUp={keyboardUp} />
		</QueryClientProvider>,
	);
}

const precedes = (a: Node, b: Node) =>
	Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const editor = () => screen.getByRole("textbox");
const button = (name: string) => screen.getByRole("button", { name });

describe("FileEditor", () => {
	beforeEach(() => {
		layout.expanded = false;
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("where its actions are", () => {
		it("leads with View and ends with Save", () => {
			renderEditor();
			expect(precedes(button("View"), button("Save"))).toBe(true);
		});

		it("puts them under the editor below expanded", () => {
			renderEditor();
			expect(precedes(editor(), button("Save"))).toBe(true);
		});

		it("puts them above the editor at expanded, keyboard or not", () => {
			layout.expanded = true;
			renderEditor(true);
			expect(precedes(button("Save"), editor())).toBe(true);
		});

		// The composer's keyboard, not the editor's: typing in the file is what
		// Save is for.
		it("takes them off a phone while the composer has the keyboard", () => {
			renderEditor(true);
			expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
			expect(screen.queryByRole("button", { name: "View" })).toBeNull();
		});
	});

	it("saves the buffer, busy while it does, then goes to the view", async () => {
		const user = userEvent.setup();
		let finish = () => {};
		writeFile.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		renderEditor();

		await user.type(editor(), "!");
		await user.click(button("Save"));

		const saving = button("Saving…");
		expect(saving).toHaveAttribute("aria-busy", "true");
		expect(saving).toBeDisabled();
		expect(writeFile).toHaveBeenCalledWith("src/app.ts", "const a = 1;!");

		finish();
		await vi.waitFor(() => expect(goToParent).toHaveBeenCalled());
	});
});
