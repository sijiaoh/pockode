import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentsQueryKey } from "../../hooks/useContents";
import { useFilesSearchStore } from "../../lib/filesSearchStore";
import { UploadError, uploadFile } from "../../lib/fileUpload";
import { uploadActions } from "../../lib/uploadStore";
import type { Entry } from "../../types/contents";
import type { FileSearchResult } from "../../types/search";
import { SidebarContext } from "../Layout/SidebarContext";
import FilesTab from "./FilesTab";

const searchFiles = vi.fn();
const wsState = { actions: { searchFiles }, maxUploadSize: 0 };

vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
}));

vi.mock("../../lib/fileUpload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileUpload")>()),
	uploadFile: vi.fn(),
}));

/**
 * Stands in for the tree, carrying only what the tab reads back from it: the
 * folder a tap chose, the `data-entry-*` rows a drop is resolved against, and
 * the two drag props echoed as text so they can be asserted.
 */
vi.mock("./FileTree", () => ({
	default: ({
		onSelectDir,
		dropTargetPath,
		springOpenPath,
	}: {
		onSelectDir: (path: string) => void;
		dropTargetPath: string | null;
		springOpenPath: string | null;
	}) => (
		<div>
			file tree
			<button type="button" onClick={() => onSelectDir("src/assets")}>
				pick src/assets
			</button>
			<div data-entry-path="src" data-entry-type="dir">
				src
				<div data-entry-path="src/main.tsx" data-entry-type="file">
					main.tsx
				</div>
			</div>
			<div>{`drop target: ${dropTargetPath === null ? "none" : dropTargetPath || "root"}`}</div>
			<div>{`spring open: ${springOpenPath ?? "none"}`}</div>
		</div>
	),
}));

interface SearchParams {
	query: string;
	mode: string;
	respect_gitignore: boolean;
}

function lastSearchParams(): SearchParams {
	return searchFiles.mock.calls[searchFiles.mock.calls.length - 1][0];
}

function renderFilesTab(listings: Record<string, Entry[]> = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	for (const [path, entries] of Object.entries(listings)) {
		queryClient.setQueryData(contentsQueryKey(path), entries);
	}
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
		expect(screen.getByRole("button", { name: /Contents/ })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	it("re-runs the search with the new option when a chip is toggled", async () => {
		const user = userEvent.setup();
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		await user.type(screen.getByLabelText("Search files"), "app");
		await waitFor(() => expect(searchFiles).toHaveBeenCalled(), SLOW);

		await user.click(screen.getByRole("button", { name: /Contents/ }));

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

function entry(name: string, type: "file" | "dir", dir = ""): Entry {
	return { name, type, path: dir ? `${dir}/${name}` : name };
}

function fileInput(container: HTMLElement): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("no file input rendered");
	return input;
}

function lastUpload() {
	const calls = vi.mocked(uploadFile).mock.calls;
	return calls[calls.length - 1][0];
}

describe("FilesTab uploads", () => {
	beforeEach(() => {
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		wsState.maxUploadSize = 0;
		vi.mocked(uploadFile).mockReset();
		// Stays in flight, so an entry keeps the state the assertion is about.
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
	});

	it("aims uploads at the folder that was tapped", async () => {
		const user = userEvent.setup();
		renderFilesTab();

		expect(
			screen.getByRole("button", { name: "Upload to project root" }),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "pick src/assets" }));

		expect(
			screen.getByRole("button", { name: "Upload to src/assets" }),
		).toBeInTheDocument();
	});

	it("says where uploads land without spending a word of the row on it", async () => {
		const user = userEvent.setup();
		renderFilesTab();

		const atRoot = screen.getByRole("button", {
			name: "Upload to project root",
		});
		expect(atRoot).toHaveTextContent("");
		// The dot is the whole visible answer to "somewhere other than the root";
		// the folder itself is named only in the accessible name and on its row.
		expect(atRoot.querySelector(".bg-th-accent")).toBeNull();

		await user.click(screen.getByRole("button", { name: "pick src/assets" }));

		const atFolder = screen.getByRole("button", {
			name: "Upload to src/assets",
		});
		expect(atFolder).toHaveTextContent("");
		expect(atFolder.querySelector(".bg-th-accent")).not.toBeNull();
	});

	// jsdom lays nothing out, so what is checked is the rule the row overflowed
	// by breaking: at 240px only the field may shrink, and everything beside it
	// has to hold a fixed, icon-sized width.
	it("leaves the search field as the only element of its row that shrinks", () => {
		renderFilesTab();

		const field = screen.getByLabelText("Search files");
		const uploadButton = screen.getByRole("button", {
			name: "Upload to project root",
		});
		const row = field.closest("div")?.parentElement as HTMLElement;
		expect(row).toContainElement(uploadButton);

		// A hidden element is out of the layout, so it owes the row nothing.
		const laidOut = Array.from(row.children).filter(
			(el) => !el.classList.contains("hidden"),
		);
		const shrinking = laidOut.filter((el) => el.classList.contains("flex-1"));

		expect(shrinking).toHaveLength(1);
		expect(shrinking[0]).toContainElement(field);
		expect(shrinking[0]).toHaveClass("min-w-0");
		for (const el of laidOut) {
			if (el !== shrinking[0]) expect(el).toHaveClass("shrink-0");
		}
	});

	it("sends a file that has nothing in its way without asking", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({ "": [entry("readme.md", "file")] });

		await user.upload(fileInput(container), [new File(["x"], "hero.png")]);

		expect(screen.queryByText("Files already exist")).not.toBeInTheDocument();
		expect(lastUpload()).toMatchObject({
			name: "hero.png",
			destPath: "",
			overwrite: false,
		});
	});

	it("asks once about a name already taken, and keeps both by renaming here", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({ "": [entry("logo.png", "file")] });

		await user.upload(fileInput(container), [new File(["x"], "logo.png")]);

		expect(await screen.findByText("Files already exist")).toBeInTheDocument();
		expect(uploadFile).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Keep both" }));

		// The endpoint cannot rename, so the second copy's name is chosen here.
		expect(lastUpload()).toMatchObject({
			name: "logo (1).png",
			overwrite: false,
		});
	});

	it("replaces only when that is what was chosen", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({ "": [entry("logo.png", "file")] });

		await user.upload(fileInput(container), [new File(["x"], "logo.png")]);
		await user.click(await screen.findByRole("button", { name: "Replace" }));

		expect(lastUpload()).toMatchObject({ name: "logo.png", overwrite: true });
	});

	it("skips only the files the answer was about", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({ "": [entry("logo.png", "file")] });

		await user.upload(fileInput(container), [
			new File(["x"], "logo.png"),
			new File(["x"], "hero.png"),
		]);
		await user.click(await screen.findByRole("button", { name: "Skip" }));

		// The one with nothing in its way was never in question.
		expect(vi.mocked(uploadFile).mock.calls).toHaveLength(1);
		expect(lastUpload()).toMatchObject({ name: "hero.png" });
	});

	it("takes Escape as Skip without closing the sidebar underneath", async () => {
		const user = userEvent.setup();
		const onSidebarEscape = vi.fn();
		const listener = (e: KeyboardEvent) => {
			if (e.key === "Escape") onSidebarEscape();
		};
		// Where the sidebar's own close-on-Escape lives (`Sidebar.tsx`).
		document.addEventListener("keydown", listener);

		try {
			const { container } = renderFilesTab({ "": [entry("logo.png", "file")] });
			await user.upload(fileInput(container), [new File(["x"], "logo.png")]);
			await screen.findByText("Files already exist");

			await user.keyboard("{Escape}");

			expect(screen.queryByText("Files already exist")).not.toBeInTheDocument();
			expect(uploadFile).not.toHaveBeenCalled();
			expect(onSidebarEscape).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", listener);
		}
	});

	it("offers Keep both again when the server, not the listing, found the clash", async () => {
		const user = userEvent.setup();
		// The listing is stale: something wrote logo.png after it was cached, so
		// the local pre-check sees nothing and the 409 is the first news of it.
		const { container } = renderFilesTab({ "": [entry("readme.md", "file")] });
		vi.mocked(uploadFile).mockRejectedValueOnce(
			new UploadError("logo.png already exists", {
				code: "conflict",
				canRetry: false,
			}),
		);

		await user.upload(fileInput(container), [new File(["x"], "logo.png")]);
		expect(
			await screen.findByText("logo.png already exists"),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Keep both copies of logo.png" }),
		);

		// Not logo.png again: the listing cannot vouch for the name, but the 409
		// just did, so re-sending it unchanged would fail on every press.
		expect(lastUpload()).toMatchObject({ name: "logo (1).png" });
	});

	it("never aims a file at a folder of the same name", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({ "": [entry("assets", "dir")] });

		await user.upload(fileInput(container), [new File(["x"], "assets")]);

		// Replacing a folder would take its whole subtree with it, so this is not
		// one of the choices — the file is refused before anything is sent.
		expect(screen.queryByText("Files already exist")).not.toBeInTheDocument();
		expect(uploadFile).not.toHaveBeenCalled();

		// No expanding first: a row that needs a decision brings itself into view.
		expect(
			screen.getByText("A folder with this name exists"),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Keep both copies of assets" }),
		);
		expect(lastUpload()).toMatchObject({ name: "assets (1)" });
	});

	it("turns away a second batch while the first is still being asked about", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({
			"": [entry("logo.png", "file"), entry("icon.svg", "file")],
		});

		await user.upload(fileInput(container), [new File(["x"], "logo.png")]);
		await screen.findByText("Files already exist");

		// The dialog's overlay stops clicks but not the keyboard: a few tabs reach
		// the upload button behind it, and picking there would reach this code.
		await user.upload(fileInput(container), [new File(["x"], "icon.svg")]);

		expect(
			screen.getByText(
				"Finish answering about the files already picked. Nothing was uploaded.",
			),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Keep both" }));

		// Still the batch the dialog was opened with. There is one place to hold a
		// batch awaiting an answer, so a second one taken here would have replaced
		// it and dropped the file it held without a word.
		expect(lastUpload()).toMatchObject({ name: "logo (1).png" });
		expect(vi.mocked(uploadFile).mock.calls).toHaveLength(1);
		// The refusal was an instruction, and it has just been carried out; left
		// standing it would read as an answer that did not register.
		expect(
			screen.queryByText(/Finish answering about the files already picked/),
		).not.toBeInTheDocument();
	});

	it("keeps both away from a name another queued upload has claimed", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({ "": [entry("logo.png", "file")] });

		await user.upload(fileInput(container), [new File(["x"], "logo.png")]);
		await user.click(await screen.findByRole("button", { name: "Keep both" }));
		expect(lastUpload()).toMatchObject({ name: "logo (1).png" });

		await user.upload(fileInput(container), [new File(["x"], "logo.png")]);
		await user.click(await screen.findByRole("button", { name: "Keep both" }));

		// The cached listing knows nothing about `logo (1).png` — it is claimed by
		// an upload that is still in flight — so a name chosen from the listing
		// alone would send two files to the same path.
		expect(lastUpload()).toMatchObject({ name: "logo (2).png" });
	});

	it("refuses a selection too large to be deliberate", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab();
		const files = Array.from(
			{ length: 51 },
			(_, i) => new File(["x"], `f${i}.txt`),
		);

		await user.upload(fileInput(container), files);

		expect(
			screen.getByText("Too many files. Upload up to 50 at a time."),
		).toBeInTheDocument();
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

interface DraggedItem {
	file: File | null;
	isDirectory: boolean;
}

/**
 * What a file drag exposes, which jsdom has no `DataTransfer` for.
 *
 * A dropped folder appears in `files` as a zero-byte entry indistinguishable
 * from a file, which is why the real code reads `items`; the fixture keeps both
 * so it can hold the code to that.
 */
function fileDrag(items: DraggedItem[] = []) {
	return {
		types: ["Files"],
		dropEffect: "none",
		files: items.map((item) => item.file ?? new File([], "folder")),
		items: items.map((item) => ({
			kind: "file",
			getAsFile: () => item.file,
			webkitGetAsEntry: () => ({ isDirectory: item.isDirectory }),
		})),
	};
}

function dragged(...files: File[]): DraggedItem[] {
	return files.map((file) => ({ file, isDirectory: false }));
}

const A_FOLDER: DraggedItem = { file: null, isDirectory: true };

function dragOver(target: Element, dataTransfer: ReturnType<typeof fileDrag>) {
	fireEvent.dragEnter(target, { dataTransfer });
	fireEvent.dragOver(target, { dataTransfer });
}

function drop(target: Element, items: DraggedItem[]) {
	const dataTransfer = fileDrag(items);
	dragOver(target, dataTransfer);
	fireEvent.drop(target, { dataTransfer });
}

function panel(): Element {
	return screen.getByText("file tree");
}

function folderRow(): Element {
	const row = document.querySelector('[data-entry-path="src"]');
	if (!row) throw new Error("no src row rendered");
	return row;
}

function fileRow(): Element {
	const row = document.querySelector('[data-entry-path="src/main.tsx"]');
	if (!row) throw new Error("no src/main.tsx row rendered");
	return row;
}

describe("FilesTab drag and drop", () => {
	beforeEach(() => {
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		wsState.maxUploadSize = 0;
		vi.mocked(uploadFile).mockReset();
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops into the folder the cursor is over", () => {
		renderFilesTab();

		drop(folderRow(), dragged(new File(["x"], "hero.png")));

		expect(lastUpload()).toMatchObject({ name: "hero.png", destPath: "src" });
	});

	it("hands a file row's drop to the folder holding it", () => {
		renderFilesTab();

		drop(fileRow(), dragged(new File(["x"], "hero.png")));

		// A file is not a destination; what was aimed at is the folder it sits in.
		expect(lastUpload()).toMatchObject({ destPath: "src" });
	});

	it("takes anywhere with no row above it as the project root", () => {
		renderFilesTab();

		drop(panel(), dragged(new File(["x"], "hero.png")));

		expect(lastUpload()).toMatchObject({ destPath: "" });
	});

	it("queues every file of one drop", () => {
		renderFilesTab();

		drop(
			folderRow(),
			dragged(new File(["x"], "a.png"), new File(["x"], "b.png")),
		);

		expect(vi.mocked(uploadFile).mock.calls.map(([call]) => call.name)).toEqual(
			["a.png", "b.png"],
		);
	});

	it("announces the destination and follows the cursor between rows", () => {
		renderFilesTab();
		const dataTransfer = fileDrag(dragged(new File(["x"], "hero.png")));

		dragOver(panel(), dataTransfer);
		expect(screen.getByText("Upload to project root")).toBeInTheDocument();
		expect(screen.getByText("drop target: root")).toBeInTheDocument();

		fireEvent.dragOver(folderRow(), { dataTransfer, clientY: 100 });
		expect(screen.getByText("Upload to src")).toBeInTheDocument();
		expect(screen.getByText("drop target: src")).toBeInTheDocument();
	});

	it("stays open while the cursor crosses the rows inside it", () => {
		renderFilesTab();
		const dataTransfer = fileDrag(dragged(new File(["x"], "hero.png")));

		fireEvent.dragEnter(panel(), { dataTransfer });
		// Entering a child fires a `dragleave` for the one being left, so without a
		// depth count the panel would drop out of the drag on every row crossed.
		fireEvent.dragEnter(folderRow(), { dataTransfer });
		fireEvent.dragLeave(panel(), { dataTransfer });

		expect(screen.getByText("Upload to src")).toBeInTheDocument();

		fireEvent.dragLeave(folderRow(), { dataTransfer });

		expect(screen.queryByText("Upload to src")).not.toBeInTheDocument();
	});

	it("gives up the drag when it ends outside the window", () => {
		renderFilesTab();

		fireEvent.dragEnter(panel(), {
			dataTransfer: fileDrag(dragged(new File(["x"], "hero.png"))),
		});
		expect(screen.getByText("Upload to project root")).toBeInTheDocument();

		// Released on the desktop or cancelled with Escape: the browser never sends
		// the last `dragleave`, so the counter alone would leave the panel lit up.
		fireEvent.dragEnd(window);

		expect(
			screen.queryByText("Upload to project root"),
		).not.toBeInTheDocument();
	});

	it("refuses a folder and still takes the files dropped beside it", () => {
		renderFilesTab();

		drop(panel(), [...dragged(new File(["x"], "hero.png")), A_FOLDER]);

		expect(
			screen.getByText(
				"Folders can't be uploaded. Drop individual files instead.",
			),
		).toBeInTheDocument();
		// The folder is refused rather than sent as the empty file it looks like in
		// `dataTransfer.files`.
		expect(vi.mocked(uploadFile).mock.calls).toHaveLength(1);
		expect(lastUpload()).toMatchObject({ name: "hero.png" });
	});

	it("opens a folder held under the cursor long enough", () => {
		vi.useFakeTimers();
		renderFilesTab();

		dragOver(folderRow(), fileDrag(dragged(new File(["x"], "hero.png"))));
		expect(screen.getByText("spring open: none")).toBeInTheDocument();

		act(() => vi.advanceTimersByTime(700));

		// A drag cannot click, so hovering is the only way into a closed folder.
		expect(screen.getByText("spring open: src")).toBeInTheDocument();
	});

	it("refuses drops while search results are showing", async () => {
		const user = userEvent.setup();
		renderFilesTab();
		await user.type(screen.getByLabelText("Search files"), "app");

		const dataTransfer = fileDrag(dragged(new File(["x"], "hero.png")));
		dragOver(panel(), dataTransfer);

		// A flat list of matches from everywhere has no answer to "into which
		// folder", so the drag is turned away rather than aimed at the root.
		expect(screen.getByText("Exit search to upload files")).toBeInTheDocument();

		fireEvent.drop(panel(), { dataTransfer });

		expect(uploadFile).not.toHaveBeenCalled();
		// The button is unaffected: it aims at the destination already chosen.
		expect(
			screen.getByRole("button", { name: "Upload to project root" }),
		).toBeInTheDocument();
	});

	it("turns away a drop while the conflict dialog is still asking", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({
			"": [entry("logo.png", "file"), entry("icon.svg", "file")],
		});

		await user.upload(fileInput(container), [new File(["x"], "logo.png")]);
		await screen.findByText("Files already exist");

		// A portal's events still travel the React tree, so a drop on the dialog
		// reaches the panel underneath it; the overlay only stops clicks.
		drop(screen.getByRole("dialog"), dragged(new File(["x"], "icon.svg")));

		expect(uploadFile).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Keep both" }));

		// Still answering for the batch it was opened with. A drop taken here would
		// have replaced that batch, dropping the files it held without a word.
		expect(lastUpload()).toMatchObject({ name: "logo (1).png" });
	});

	it("can still find the element the tree scrolls in", () => {
		const { container } = renderFilesTab();

		// `PullToRefreshify` owns the scroller and forwards no ref to it, so the
		// tab reaches it as the single child of the wrapper around `PullToRefresh`.
		// Should a version of it grow a second wrapper, edge auto-scroll would
		// quietly stop working and nothing else would notice.
		const scroller = container.querySelector<HTMLElement>(
			'[style*="overflow-y: auto"]',
		);
		expect(scroller).not.toBeNull();
		expect(scroller?.parentElement?.firstElementChild).toBe(scroller);
		expect(scroller?.contains(screen.getByText("file tree"))).toBe(true);
	});

	it("asks about a name a drop would take, in the folder it landed in", async () => {
		renderFilesTab({ src: [entry("logo.png", "file", "src")] });

		drop(folderRow(), dragged(new File(["x"], "logo.png")));

		expect(await screen.findByText("Files already exist")).toBeInTheDocument();
		expect(uploadFile).not.toHaveBeenCalled();
	});
});
