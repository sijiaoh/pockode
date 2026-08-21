import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFilesSearchStore } from "../../lib/filesSearchStore";
import type { FileSearchResult } from "../../types/search";
import { SidebarContext } from "../Layout/SidebarContext";
import FilesTab from "./FilesTab";

const searchFiles = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: unknown) => unknown) =>
		selector({ actions: { searchFiles } }),
}));

vi.mock("./FileTree", () => ({
	default: () => <div>file tree</div>,
}));

interface SearchParams {
	query: string;
	mode: string;
	respect_gitignore: boolean;
}

function lastSearchParams(): SearchParams {
	return searchFiles.mock.calls[searchFiles.mock.calls.length - 1][0];
}

function renderFilesTab() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<SidebarContext.Provider value={{ activeTab: "files", refreshSignal: 0 }}>
				{children}
			</SidebarContext.Provider>
		</QueryClientProvider>
	);

	return render(<FilesTab onSelectFile={vi.fn()} activeFilePath={null} />, {
		wrapper,
	});
}

function result(paths: string[], truncated = false): FileSearchResult {
	return {
		matches: paths.map((path) => ({
			path,
			name: path.slice(path.lastIndexOf("/") + 1),
		})),
		truncated,
	};
}

// Every case types into the debounced input and waits for a query round trip,
// which outruns both the default test timeout and the 1s async-query timeout on
// a loaded machine.
const SLOW = { timeout: 10_000 };

describe("FilesTab search", { timeout: 20_000 }, () => {
	beforeEach(() => {
		searchFiles.mockReset();
		localStorage.clear();
		useFilesSearchStore.setState({
			respectGitignore: true,
			searchContent: false,
		});
	});

	it("shows results while searching and returns to the tree when cleared", async () => {
		const user = userEvent.setup();
		searchFiles.mockResolvedValue(result(["src/app.ts"]));
		renderFilesTab();

		expect(screen.getByText("file tree")).toBeInTheDocument();

		await user.type(screen.getByLabelText("Search files"), "app");

		expect(
			await screen.findByRole(
				"button",
				{ name: "Open file: src/app.ts" },
				SLOW,
			),
		).toBeInTheDocument();
		expect(screen.getByText("1 file")).toBeInTheDocument();

		await user.click(screen.getByLabelText("Clear search"));

		await waitFor(() => {
			expect(
				screen.queryByRole("button", { name: "Open file: src/app.ts" }),
			).not.toBeInTheDocument();
		}, SLOW);
	});

	it("lets Escape reach the sidebar only once there is nothing to clear", async () => {
		const user = userEvent.setup();
		const onDocumentEscape = vi.fn();
		const listener = (e: KeyboardEvent) => {
			if (e.key === "Escape") onDocumentEscape();
		};
		document.addEventListener("keydown", listener);
		searchFiles.mockResolvedValue(result([]));

		try {
			renderFilesTab();
			const input = screen.getByLabelText("Search files");

			await user.type(input, "app{Escape}");

			expect(input).toHaveValue("");
			// The sidebar's own Escape listener must not fire, or the whole panel
			// would close instead of just the search.
			expect(onDocumentEscape).not.toHaveBeenCalled();

			await user.type(input, "{Escape}");

			expect(onDocumentEscape).toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", listener);
		}
	});

	it("defaults to respecting gitignore and searching names", async () => {
		const user = userEvent.setup();
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		await user.type(screen.getByLabelText("Search files"), "app");

		await waitFor(() => expect(searchFiles).toHaveBeenCalled(), SLOW);
		expect(lastSearchParams()).toMatchObject({
			query: "app",
			mode: "name",
			respect_gitignore: true,
		});
		expect(screen.getByRole("button", { name: /\.gitignore/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(
			screen.getByRole("button", { name: /File contents/ }),
		).toHaveAttribute("aria-pressed", "false");
	});

	it("re-runs the search with the new option when a chip is toggled", async () => {
		const user = userEvent.setup();
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		await user.type(screen.getByLabelText("Search files"), "app");
		await waitFor(() => expect(searchFiles).toHaveBeenCalled(), SLOW);

		await user.click(screen.getByRole("button", { name: /File contents/ }));

		await waitFor(
			() => expect(lastSearchParams()).toMatchObject({ mode: "content" }),
			SLOW,
		);
		expect(localStorage.getItem("files-search-content")).toBe("true");
	});

	it("offers to widen the search when nothing matches", async () => {
		const user = userEvent.setup();
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		await user.type(screen.getByLabelText("Search files"), "app");

		await user.click(
			await screen.findByRole(
				"button",
				{ name: "Search ignored files too" },
				SLOW,
			),
		);

		await waitFor(
			() =>
				expect(lastSearchParams()).toMatchObject({ respect_gitignore: false }),
			SLOW,
		);
	});

	it("surfaces search failures with a retry", async () => {
		const user = userEvent.setup();
		searchFiles.mockRejectedValue(new Error("search backend exploded"));
		renderFilesTab();

		await user.type(screen.getByLabelText("Search files"), "app");

		expect(
			await screen.findByText("Search failed", undefined, SLOW),
		).toBeInTheDocument();
		expect(screen.getByText("search backend exploded")).toBeInTheDocument();

		searchFiles.mockResolvedValue(result(["src/app.ts"]));
		await user.click(screen.getByRole("button", { name: "Retry" }));

		expect(
			await screen.findByRole(
				"button",
				{ name: "Open file: src/app.ts" },
				SLOW,
			),
		).toBeInTheDocument();
	});

	it("waits for two characters before searching file contents", async () => {
		const user = userEvent.setup();
		searchFiles.mockResolvedValue(result([]));
		useFilesSearchStore.setState({ searchContent: true });
		renderFilesTab();

		await user.type(screen.getByLabelText("Search files"), "a");

		expect(
			await screen.findByText(
				"Type at least 2 characters to search file contents",
				undefined,
				SLOW,
			),
		).toBeInTheDocument();
		expect(searchFiles).not.toHaveBeenCalled();
	});
});
