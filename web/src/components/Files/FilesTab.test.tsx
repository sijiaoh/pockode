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
import { FILE_SEARCH_DEBOUNCE_MS } from "../../hooks/useFileSearch";
import { ENTRY_DRAG_TYPE } from "../../lib/entryDrag";
import { useFilesSearchStore } from "../../lib/filesSearchStore";
import {
	type FolderUploadRequest,
	UploadError,
	uploadFile,
	uploadFolder,
} from "../../lib/fileUpload";
import { uploadActions, useUploadStore } from "../../lib/uploadStore";
import { worktreeActions } from "../../lib/worktreeStore";
import { folderEntry } from "../../test/folderEntry";
import type { Entry } from "../../types/contents";
import type { FileSearchResult } from "../../types/search";
import { SidebarContext } from "../Layout/SidebarContext";
import FilesTab from "./FilesTab";
import type { EntryDragStart } from "./FileTreeNode";

const searchFiles = vi.fn();
const createFile = vi.fn();
const deleteFile = vi.fn();
const renameFile = vi.fn();
const moveFile = vi.fn();
const getFile = vi.fn();
const wsState = {
	actions: {
		searchFiles,
		createFile,
		deleteFile,
		renameFile,
		moveFile,
		getFile,
	},
	maxUploadSize: 0,
};

vi.mock("../../lib/wsStore", () => ({
	useWSStore: Object.assign(
		(selector: (state: unknown) => unknown) => selector(wsState),
		{ getState: () => wsState },
	),
	isRPCTimeout: () => false,
}));

const saveRawFolder = vi.fn();

vi.mock("../../hooks/useRawMediaSource", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useRawMediaSource")>()),
	saveRawFolder: (...args: unknown[]) => saveRawFolder(...args),
}));

vi.mock("../../lib/fileUpload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/fileUpload")>()),
	uploadFile: vi.fn(),
	uploadFolder: vi.fn(),
}));

/**
 * Stands in for the tree, carrying only what the tab reads back from it: the
 * rows a menu can be opened from, the `data-entry-*` rows a drop is resolved
 * against, and the drag props echoed as text so they can be asserted.
 */
/**
 * The rows the stand-in tree offers a menu for. Two are always there, since
 * most cases are about one of them; a case that needs others pushes them on and
 * `beforeEach` puts the list back.
 */
const DEFAULT_TREE_ENTRIES: Entry[] = [
	{ name: "src", type: "dir", path: "src" },
	{ name: "main.tsx", type: "file", path: "src/main.tsx" },
];
let treeEntries: Entry[] = [...DEFAULT_TREE_ENTRIES];
/** Whether a folder row dragged from the stand-in tree was open at the time. */
let dragStartsExpanded = false;

vi.mock("./FileTree", () => ({
	default: ({
		onOpenMenu,
		dropTargetPath,
		springOpenPath,
		forceOpenPaths,
		onEntryDragStart,
		dragSourcePath,
		movingPaths,
	}: {
		onOpenMenu: (entry: Entry) => void;
		dropTargetPath: string | null;
		springOpenPath: string | null;
		forceOpenPaths: readonly string[];
		onEntryDragStart?: (entry: Entry, drag: EntryDragStart) => void;
		dragSourcePath: string | null;
		movingPaths: ReadonlySet<string>;
	}) => {
		// What a real row does at `dragstart`, minus the payload, which is the
		// row's own business and is tested with it.
		const dragStart = (entry: Entry) =>
			onEntryDragStart
				? (event: React.DragEvent<HTMLElement>) => {
						event.stopPropagation();
						onEntryDragStart(entry, {
							wasExpanded: dragStartsExpanded,
							element: event.currentTarget,
						});
					}
				: undefined;
		return (
			<div>
				file tree
				{treeEntries.map((entry) => (
					<button
						key={entry.path}
						type="button"
						onClick={() => onOpenMenu(entry)}
					>
						{`menu for ${entry.path}`}
					</button>
				))}
				<div>{`force open: ${forceOpenPaths.join(", ") || "none"}`}</div>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: stands in for a row's drag source */}
				<div
					data-entry-path="src"
					data-entry-type="dir"
					onDragStart={dragStart({ name: "src", type: "dir", path: "src" })}
				>
					src
					{/* biome-ignore lint/a11y/noStaticElementInteractions: stands in for a row's drag source */}
					<div
						data-entry-path="src/main.tsx"
						data-entry-type="file"
						onDragStart={dragStart({
							name: "main.tsx",
							type: "file",
							path: "src/main.tsx",
						})}
					>
						main.tsx
					</div>
				</div>
				<div data-entry-path="lib" data-entry-type="dir">
					lib
				</div>
				<div>{`drop target: ${dropTargetPath === null ? "none" : dropTargetPath || "root"}`}</div>
				<div>{`spring open: ${springOpenPath ?? "none"}`}</div>
				<div>{`rows draggable: ${onEntryDragStart ? "yes" : "no"}`}</div>
				<div>{`dragging: ${dragSourcePath ?? "none"}`}</div>
				<div>{`moving: ${[...movingPaths].join(", ") || "none"}`}</div>
			</div>
		);
	},
}));

interface SearchParams {
	query: string;
	mode: string;
	respect_gitignore: boolean;
}

function lastSearchParams(): SearchParams {
	return searchFiles.mock.calls[searchFiles.mock.calls.length - 1][0];
}

function renderFilesTab(
	listings: Record<string, Entry[]> = {},
	{
		activeFilePath = null,
		activeFileEdit = false,
		onCloseFile = vi.fn(),
		onRepointFile = vi.fn(),
	}: {
		activeFilePath?: string | null;
		activeFileEdit?: boolean;
		onCloseFile?: () => void;
		onRepointFile?: (path: string) => void;
	} = {},
) {
	const queryClient = new QueryClient({
		// `retry: false` does not reach `useContents`, which passes a `retry`
		// callback of its own and so keeps the real retry budget. Only the wait
		// between attempts is taken away, so a listing that fails reaches its
		// error state in this test at the same point it does in the app, without
		// the seconds of backoff in between.
		defaultOptions: { queries: { retry: false, retryDelay: 0 } },
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

	return render(
		<FilesTab
			onSelectFile={vi.fn()}
			activeFilePath={activeFilePath}
			activeFileEdit={activeFileEdit}
			onRepointFile={onRepointFile}
			onCloseFile={onCloseFile}
		/>,
		{ wrapper },
	);
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

/**
 * Nothing in this block may depend on real time, which rules out `userEvent`
 * here: it awaits a real zero-delay timer between keystrokes, and on a loaded
 * machine those gaps stretch into seconds — far past the debounce — so the
 * hook fires a search for "a" and one for "ap" on the way to "app", and what
 * the last call holds becomes a matter of how busy the box was. `fireEvent`
 * takes no time of its own, so the gap between two keystrokes is only ever
 * what the case below asks for.
 */
function typeSearch(text: string): HTMLElement {
	const input = screen.getByLabelText("Search files");
	for (let i = 1; i <= text.length; i += 1) {
		fireEvent.change(input, { target: { value: text.slice(0, i) } });
		// Typing is not instantaneous, and a debounce that did not restart on
		// each keystroke would fire partway through the word. Two thirds of it
		// is short enough that a working one never does, and long enough that
		// "app" spans more than one debounce — at a third, the word is done
		// before a timer armed by its first key runs out, and that case passes.
		act(() => {
			vi.advanceTimersByTime((FILE_SEARCH_DEBOUNCE_MS * 2) / 3);
		});
	}
	return input;
}

/** Runs the debounce out and lets the search that follows it render. */
async function settleSearch() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS);
	});
	// The debounce is only the first hop: the request resolves and react-query
	// hands its result back through a zero-delay timer of its own. The second
	// `act` is not a spare tick — React commits on leaving one, so this is where
	// the render carrying the results happens.
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
}

describe("FilesTab search", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		searchFiles.mockReset();
		localStorage.clear();
		useFilesSearchStore.setState({
			respectGitignore: true,
			searchContent: false,
		});
		worktreeActions.setIsGitRepo(true);
	});

	afterEach(() => {
		vi.useRealTimers();
		worktreeActions.reset();
	});

	it("shows results while searching and returns to the tree when cleared", async () => {
		searchFiles.mockResolvedValue(result(["src/app.ts"]));
		renderFilesTab();

		expect(screen.getByText("file tree")).toBeInTheDocument();

		typeSearch("app");
		await settleSearch();

		expect(
			screen.getByRole("button", { name: "Open file: src/app.ts" }),
		).toBeInTheDocument();
		expect(screen.getByText("1 file")).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText("Clear search"));

		// Asserted without moving the clock: an empty field leaves search mode on
		// the keystroke, or the tree would stay hidden for the debounce first.
		expect(
			screen.queryByRole("button", { name: "Open file: src/app.ts" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("file tree")).toBeInTheDocument();
	});

	it("lets Escape reach the sidebar only once there is nothing to clear", () => {
		const onDocumentEscape = vi.fn();
		const listener = (e: KeyboardEvent) => {
			if (e.key === "Escape") onDocumentEscape();
		};
		document.addEventListener("keydown", listener);
		searchFiles.mockResolvedValue(result([]));

		try {
			renderFilesTab();
			const input = typeSearch("app");

			fireEvent.keyDown(input, { key: "Escape" });

			expect(input).toHaveValue("");
			// The sidebar's own Escape listener must not fire, or the whole panel
			// would close instead of just the search.
			expect(onDocumentEscape).not.toHaveBeenCalled();

			fireEvent.keyDown(input, { key: "Escape" });

			expect(onDocumentEscape).toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", listener);
		}
	});

	it("defaults to respecting gitignore and searching names", async () => {
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		typeSearch("app");
		await settleSearch();

		// Once, for the whole word: the prefixes typed on the way to "app" are
		// what the debounce is there to keep off the wire.
		expect(searchFiles).toHaveBeenCalledTimes(1);
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

	// There is no .gitignore for the server to respect outside a repository, so
	// the chip would toggle nothing.
	it("offers no gitignore chip outside a git repository", async () => {
		worktreeActions.setIsGitRepo(false);
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		typeSearch("app");
		await settleSearch();

		expect(
			screen.getByRole("button", { name: /Contents/ }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /\.gitignore/ })).toBeNull();
	});

	it("re-runs the search with the new option when a chip is toggled", async () => {
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		typeSearch("app");
		await settleSearch();
		expect(searchFiles).toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /Contents/ }));
		await settleSearch();

		expect(lastSearchParams()).toMatchObject({ mode: "content" });
		expect(localStorage.getItem("files-search-content")).toBe("true");
	});

	it("offers to widen the search when nothing matches", async () => {
		searchFiles.mockResolvedValue(result([]));
		renderFilesTab();

		typeSearch("app");
		await settleSearch();

		fireEvent.click(
			screen.getByRole("button", { name: "Search ignored files too" }),
		);
		await settleSearch();

		expect(lastSearchParams()).toMatchObject({ respect_gitignore: false });
	});

	it("surfaces search failures with a retry", async () => {
		searchFiles.mockRejectedValue(new Error("search backend exploded"));
		renderFilesTab();

		typeSearch("app");
		await settleSearch();

		expect(screen.getByText("Search failed")).toBeInTheDocument();
		expect(screen.getByText("search backend exploded")).toBeInTheDocument();

		searchFiles.mockResolvedValue(result(["src/app.ts"]));
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await settleSearch();

		expect(
			screen.getByRole("button", { name: "Open file: src/app.ts" }),
		).toBeInTheDocument();
	});

	it("waits for two characters before searching file contents", async () => {
		searchFiles.mockResolvedValue(result([]));
		useFilesSearchStore.setState({ searchContent: true });
		renderFilesTab();

		typeSearch("a");
		await settleSearch();

		expect(
			screen.getByText("Type at least 2 characters to search file contents"),
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

	// jsdom lays nothing out, so what is checked is the rule the row overflowed
	// by breaking: at 240px only the field may shrink, and everything beside it
	// has to hold a fixed, icon-sized width.
	it("leaves the search field as the only element of its row that shrinks", () => {
		renderFilesTab();

		const field = screen.getByLabelText("Search files");
		const rootMenuButton = screen.getByRole("button", {
			name: "Project root actions",
		});
		const row = field.closest("div")?.parentElement as HTMLElement;
		expect(row).toContainElement(rootMenuButton);

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
		// the root's `…` behind it, and the picker it opens reaches this code.
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
	/** What `webkitGetAsEntry` gives for a folder that is read. */
	entry?: FileSystemDirectoryEntry;
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
			webkitGetAsEntry: () => item.entry ?? { isDirectory: item.isDirectory },
		})),
	};
}

function dragged(...files: File[]): DraggedItem[] {
	return files.map((file) => ({ file, isDirectory: false }));
}

function draggedFolder(entry: FileSystemDirectoryEntry): DraggedItem {
	return { file: null, isDirectory: true, entry };
}

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
		// The root's menu is unaffected: its target is the root, not a row of a
		// tree that search has hidden.
		expect(
			screen.getByRole("button", { name: "Project root actions" }),
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

	it("asks about a name a drop would take, in the folder it landed in", async () => {
		renderFilesTab({ src: [entry("logo.png", "file", "src")] });

		drop(folderRow(), dragged(new File(["x"], "logo.png")));

		expect(await screen.findByText("Files already exist")).toBeInTheDocument();
		expect(uploadFile).not.toHaveBeenCalled();
	});
});

function lastFolderUpload(): FolderUploadRequest {
	const calls = vi.mocked(uploadFolder).mock.calls;
	return calls[calls.length - 1][0];
}

function sentPaths(request: FolderUploadRequest): string[] {
	return request.contents.files.map(({ path }) => path);
}

describe("FilesTab folder upload", () => {
	beforeEach(() => {
		treeEntries = [...DEFAULT_TREE_ENTRIES];
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		wsState.maxUploadSize = 0;
		vi.mocked(uploadFile).mockReset();
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
		vi.mocked(uploadFolder).mockReset();
		vi.mocked(uploadFolder).mockImplementation(() => new Promise(() => {}));
	});

	const assets = () =>
		folderEntry("assets", {
			"logo.png": new File(["x"], "logo.png"),
			img: { "a.png": new File(["x"], "a.png") },
			empty: {},
		});

	it("uploads a dropped folder whole, beside the files dropped with it", async () => {
		renderFilesTab({ src: [] });

		drop(folderRow(), [
			...dragged(new File(["x"], "hero.png")),
			draggedFolder(assets()),
		]);

		await waitFor(() => expect(uploadFolder).toHaveBeenCalledTimes(1));
		expect(lastFolderUpload()).toMatchObject({
			name: "assets",
			destPath: "src",
			merge: false,
			contents: { dirs: ["empty"] },
		});
		expect(sentPaths(lastFolderUpload())).toEqual(["logo.png", "img/a.png"]);
		expect(lastUpload()).toMatchObject({ name: "hero.png", destPath: "src" });
	});

	it("asks once about a folder that exists, and merges only when told to", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("assets", "dir", "src")] });

		drop(folderRow(), [draggedFolder(assets())]);

		expect(
			await screen.findByText("Folders already exist"),
		).toBeInTheDocument();
		// A folder is merged into, never replaced: the button says which.
		expect(
			screen.queryByRole("button", { name: "Replace" }),
		).not.toBeInTheDocument();
		expect(uploadFolder).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Merge" }));

		expect(lastFolderUpload()).toMatchObject({ name: "assets", merge: true });
	});

	it("keeps both by naming the new folder, without splitting off an extension", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("v1.2", "dir", "src")] });

		drop(folderRow(), [draggedFolder(folderEntry("v1.2", {}))]);
		await user.click(await screen.findByRole("button", { name: "Keep both" }));

		expect(lastFolderUpload()).toMatchObject({
			name: "v1.2 (1)",
			merge: false,
		});
	});

	it("takes Skip as leaving the folder out, not as a failure", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("assets", "dir", "src")] });

		drop(folderRow(), [draggedFolder(assets())]);
		await user.click(await screen.findByRole("button", { name: "Skip" }));

		expect(uploadFolder).not.toHaveBeenCalled();
		expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument();
	});

	it("refuses a folder whose name a file holds, offering only Keep both", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("assets", "file", "src")] });

		drop(folderRow(), [draggedFolder(assets())]);

		expect(
			await screen.findByText(
				"A file with this name exists · Nothing was uploaded",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Folders already exist")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Merge/ }),
		).not.toBeInTheDocument();
		expect(uploadFolder).not.toHaveBeenCalled();

		await user.click(
			screen.getByRole("button", { name: "Keep both copies of assets" }),
		);

		expect(lastFolderUpload()).toMatchObject({ name: "assets (1)" });
	});

	it("offers Merge and Keep both when the server, not the listing, finds the folder", async () => {
		const user = userEvent.setup();
		vi.mocked(uploadFolder).mockRejectedValueOnce(
			new UploadError("src/assets already exists", {
				code: "conflict",
				canRetry: false,
			}),
		);
		renderFilesTab({ src: [] });

		drop(folderRow(), [draggedFolder(assets())]);

		await user.click(
			await screen.findByRole("button", {
				name: "Merge into the existing assets",
			}),
		);

		expect(lastFolderUpload()).toMatchObject({ name: "assets", merge: true });
	});

	it("says which file could not be read, and sends nothing of the folder", async () => {
		renderFilesTab({ src: [] });

		drop(folderRow(), [
			draggedFolder(
				folderEntry("assets", {
					"ok.txt": new File(["x"], "ok.txt"),
					"secret.key": new Error("NotReadableError"),
				}),
			),
		]);

		expect(
			await screen.findByText(
				"Couldn't read assets/secret.key · Nothing was uploaded",
			),
		).toBeInTheDocument();
		expect(uploadFolder).not.toHaveBeenCalled();
	});

	it("refuses a folder over the size limit as a whole", async () => {
		wsState.maxUploadSize = 1;
		renderFilesTab({ src: [] });

		drop(folderRow(), [draggedFolder(assets())]);

		expect(
			await screen.findByText("assets is 2 B (max 1 B) · Nothing was uploaded"),
		).toBeInTheDocument();
		expect(uploadFolder).not.toHaveBeenCalled();
	});

	it("shows the folder while it is read, and turns new drops away until then", async () => {
		const user = userEvent.setup();
		let finishReading = () => {};
		const slow = {
			name: "big",
			isDirectory: true,
			createReader: () => ({
				readEntries: (resolve: (entries: unknown[]) => void) => {
					finishReading = () => resolve([]);
				},
			}),
		} as unknown as FileSystemDirectoryEntry;
		renderFilesTab({ src: [] });

		drop(folderRow(), [draggedFolder(slow)]);

		await user.click(
			screen.getByRole("button", { name: "Expand upload queue" }),
		);
		expect(screen.getByText("Reading… 0 files")).toBeInTheDocument();

		dragOver(panel(), fileDrag(dragged(new File(["x"], "hero.png"))));
		expect(
			screen.getByText("Wait for the folder being read"),
		).toBeInTheDocument();
		fireEvent.drop(panel(), {
			dataTransfer: fileDrag(dragged(new File(["x"], "hero.png"))),
		});
		expect(uploadFile).not.toHaveBeenCalled();

		await act(async () => finishReading());

		expect(lastFolderUpload()).toMatchObject({ name: "big" });
	});

	it("drops the reading when the header ✕ cancels it, and says so on the row", async () => {
		const user = userEvent.setup();
		const slow = {
			name: "big",
			isDirectory: true,
			createReader: () => ({ readEntries: () => {} }),
		} as unknown as FileSystemDirectoryEntry;
		renderFilesTab({ src: [] });

		drop(folderRow(), [draggedFolder(slow)]);
		await user.click(
			screen.getByRole("button", { name: "Cancel all uploads" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Expand upload queue" }),
		);

		expect(
			screen.getByText("Cancelled · Nothing was uploaded"),
		).toBeInTheDocument();

		// The walk that never answered does not hold the gate shut after it.
		await waitFor(() =>
			expect(
				screen.queryByText("Wait for the folder being read"),
			).not.toBeInTheDocument(),
		);
		drop(panel(), dragged(new File(["x"], "hero.png")));
		expect(lastUpload()).toMatchObject({ name: "hero.png" });
	});
});

describe("FilesTab folder upload, interrupted", () => {
	beforeEach(() => {
		treeEntries = [...DEFAULT_TREE_ENTRIES];
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		worktreeActions.setCurrent("");
		wsState.maxUploadSize = 0;
		vi.mocked(uploadFile).mockReset();
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
		vi.mocked(uploadFolder).mockReset();
		vi.mocked(uploadFolder).mockImplementation(() => new Promise(() => {}));
	});

	afterEach(() => {
		worktreeActions.setCurrent("");
	});

	/** A folder whose walk waits until `finish` is called. */
	function slowFolder(name: string) {
		let finish = () => {};
		const entry = {
			name,
			isDirectory: true,
			createReader: () => ({
				readEntries: (resolve: (entries: unknown[]) => void) => {
					finish = () => resolve([]);
				},
			}),
		} as unknown as FileSystemDirectoryEntry;
		return { entry, finish: () => finish() };
	}

	it("still sends a folder whose tab went away while reading it, when nothing needs asking", async () => {
		const slow = slowFolder("assets");
		const { unmount } = renderFilesTab({ src: [] });

		drop(folderRow(), [draggedFolder(slow.entry)]);
		unmount();
		await act(async () => slow.finish());

		expect(lastFolderUpload()).toMatchObject({ name: "assets" });
	});

	it("lets go of a folder whose tab went away while reading it, when it needed an answer", async () => {
		const slow = slowFolder("assets");
		const { unmount } = renderFilesTab({
			src: [entry("assets", "dir", "src")],
		});

		drop(folderRow(), [draggedFolder(slow.entry)]);
		unmount();
		await act(async () => slow.finish());

		// Held, it would wait for ever for a dialog nobody can show.
		expect(useUploadStore.getState().items[0]).toMatchObject({
			status: "failed",
			error: "Interrupted before it was sent. Upload it again.",
		});
		expect(uploadFolder).not.toHaveBeenCalled();
	});

	it("lets go of a folder the dialog was asking about when the tab goes away", async () => {
		const { unmount } = renderFilesTab({
			src: [entry("assets", "dir", "src")],
		});

		drop(folderRow(), [draggedFolder(folderEntry("assets", {}))]);
		await screen.findByText("Folders already exist");
		unmount();

		expect(useUploadStore.getState().items[0].status).toBe("failed");
	});

	it("names the files dropped beside a folder a worktree switch cancelled", async () => {
		const slow = slowFolder("assets");
		renderFilesTab({ src: [] });

		drop(folderRow(), [
			...dragged(new File(["x"], "hero.png")),
			draggedFolder(slow.entry),
		]);
		act(() => worktreeActions.setCurrent("feature"));

		expect(
			await screen.findByText(
				"Cancelled while reading. The files dropped beside the folder were not uploaded.",
			),
		).toBeInTheDocument();
		expect(uploadFile).not.toHaveBeenCalled();
	});

	it("drops the whole batch when the folder being asked about is cancelled", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("assets", "dir", "src")] });

		drop(folderRow(), [
			...dragged(new File(["x"], "hero.png")),
			draggedFolder(folderEntry("assets", {})),
		]);
		await screen.findByText("Folders already exist");
		act(() => uploadActions.cancelAll());

		expect(
			await screen.findByText(
				"Cancelled. The files dropped beside the folder were not uploaded.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Folders already exist")).not.toBeInTheDocument();
		expect(uploadFile).not.toHaveBeenCalled();
		await user.click(
			screen.getByRole("button", { name: "Expand upload queue" }),
		);
		expect(
			screen.getByText("Cancelled · Nothing was uploaded"),
		).toBeInTheDocument();
	});

	it("takes back the banner that said to wait once the reading is over", async () => {
		const user = userEvent.setup();
		const slow = slowFolder("assets");
		const { container } = renderFilesTab({ src: [] });

		drop(folderRow(), [draggedFolder(slow.entry)]);
		await user.upload(fileInput(container), [new File(["x"], "hero.png")]);
		expect(
			screen.getByText(
				"Still reading the folder just dropped. Nothing new was uploaded.",
			),
		).toBeInTheDocument();

		await act(async () => slow.finish());

		expect(
			screen.queryByText(/Still reading the folder/),
		).not.toBeInTheDocument();
	});
});

describe("FilesTab folder picker", () => {
	const originalMatchMedia = window.matchMedia;

	function useFinePointer() {
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: (query: string) => ({
				...originalMatchMedia(query),
				matches: query === "(hover: hover) and (pointer: fine)",
			}),
		});
	}

	beforeEach(() => {
		treeEntries = [...DEFAULT_TREE_ENTRIES];
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		vi.mocked(uploadFile).mockReset();
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
		vi.mocked(uploadFolder).mockReset();
		vi.mocked(uploadFolder).mockImplementation(() => new Promise(() => {}));
		// jsdom has no directory picker; a desktop browser does.
		Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
			configurable: true,
			value: false,
			writable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: originalMatchMedia,
		});
		Reflect.deleteProperty(HTMLInputElement.prototype, "webkitdirectory");
	});

	function picked(relativePath: string): File {
		const file = new File(["x"], relativePath.split("/").pop() ?? "");
		Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
		return file;
	}

	function folderInput(container: HTMLElement): HTMLInputElement {
		const input = container.querySelector<HTMLInputElement>(
			"input[webkitdirectory]",
		);
		if (!input) throw new Error("no folder input rendered");
		return input;
	}

	it("uploads the picked folder into the folder the menu came from", async () => {
		useFinePointer();
		const user = userEvent.setup();
		const { container } = renderFilesTab({ src: [] });

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Upload folder" }));
		await user.upload(folderInput(container), [
			picked("assets/a.png"),
			picked("assets/img/b.png"),
		]);

		await waitFor(() => expect(uploadFolder).toHaveBeenCalled());
		expect(lastFolderUpload()).toMatchObject({
			name: "assets",
			destPath: "src",
		});
		expect(sentPaths(lastFolderUpload())).toEqual(["a.png", "img/b.png"]);
	});

	it("is not offered on a touch screen, where directory picking is unreliable", async () => {
		const user = userEvent.setup();
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));

		expect(
			screen.getByRole("button", { name: "Upload files" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Upload folder" }),
		).not.toBeInTheDocument();
	});
});

describe("FilesTab entry menu", () => {
	beforeEach(() => {
		treeEntries = [...DEFAULT_TREE_ENTRIES];
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		wsState.maxUploadSize = 0;
		createFile.mockReset();
		deleteFile.mockReset();
		getFile.mockReset();
		createFile.mockResolvedValue(undefined);
		deleteFile.mockResolvedValue(undefined);
		vi.mocked(uploadFile).mockReset();
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
	});

	it("offers everything a folder can do, and only deleting on a file", async () => {
		const user = userEvent.setup();
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));

		for (const label of ["Upload files", "New file", "New folder", "Delete"]) {
			expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
		}

		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);

		// Nothing is created inside a file, and nothing is uploaded into one.
		expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "New file" }),
		).not.toBeInTheDocument();
	});

	it("leaves the project root with nothing to delete", async () => {
		const user = userEvent.setup();
		// The tree has already read the root, so its listing is there to check a
		// new name against without waiting.
		renderFilesTab({ "": [] });

		await user.click(
			screen.getByRole("button", { name: "Project root actions" }),
		);

		// Neither deleting nor renaming the workspace itself is one of the
		// choices: the root is the work directory, not an entry of the file
		// namespace, so these are not disabled here — they never apply.
		expect(
			screen.queryByRole("button", { name: "Delete" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Rename/ }),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "New file" }));
		await user.type(screen.getByLabelText("Name"), "notes.md");
		await user.click(screen.getByRole("button", { name: "Create" }));

		// Not "/notes.md": the root is the empty path, so there is no directory to
		// join to the name.
		expect(createFile).toHaveBeenCalledWith("notes.md", "file");
	});

	it("aims a menu upload at the folder the menu was opened from", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab({ src: [] });

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Upload files" }));

		// The picker the menu opens is the tab's own: the sheet holding the item
		// unmounts the moment it is chosen from, taking any input of its own.
		await user.upload(fileInput(container), [new File(["x"], "hero.png")]);

		expect(lastUpload()).toMatchObject({ name: "hero.png", destPath: "src" });
	});

	it("aims an upload from the root's menu at the root", async () => {
		const user = userEvent.setup();
		const { container } = renderFilesTab();

		await user.click(
			screen.getByRole("button", { name: "Project root actions" }),
		);
		await user.click(screen.getByRole("button", { name: "Upload files" }));
		await user.upload(fileInput(container), [new File(["x"], "hero.png")]);

		expect(lastUpload()).toMatchObject({ name: "hero.png", destPath: "" });
	});

	it("creates an entry in the folder the menu came from and opens it", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("main.tsx", "file", "src")] });

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "New folder" }));
		await user.type(screen.getByLabelText("Name"), "utils");
		await user.click(screen.getByRole("button", { name: "Create" }));

		expect(createFile).toHaveBeenCalledWith("src/utils", "dir");
		await waitFor(() =>
			expect(screen.queryByLabelText("Name")).not.toBeInTheDocument(),
		);
		// A folder that stays closed over what was just made in it is the same as
		// the creation having done nothing.
		expect(screen.getByText("force open: src")).toBeInTheDocument();
	});

	it("refuses a name the listing already holds without asking the server", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("main.tsx", "file", "src")] });

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "New file" }));
		await user.type(screen.getByLabelText("Name"), "main.tsx");

		expect(screen.getByRole("alert")).toHaveTextContent("already exists here");
		expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
		expect(createFile).not.toHaveBeenCalled();
	});

	it("keeps the dialog up when the server is the one that finds the clash", async () => {
		const user = userEvent.setup();
		// A folder that has never been expanded has no listing to check against,
		// so the local pre-check passes and the server's refusal is the first news
		// of the name being taken.
		getFile.mockResolvedValue({ type: "directory", entries: [] });
		createFile.mockRejectedValue(new Error("src/notes.md already exists"));
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "New file" }));
		await user.type(await screen.findByLabelText("Name"), "notes.md");
		await user.click(screen.getByRole("button", { name: "Create" }));

		// Dropped into the tab's error bar instead, the message would arrive with
		// the dialog gone and the name the user typed with it.
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"src/notes.md already exists",
		);
		expect(screen.getByLabelText("Name")).toHaveValue("notes.md");

		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "other.md");

		// The refusal was about the name that has just been replaced.
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("says a folder is deleted with everything in it before doing so", async () => {
		const user = userEvent.setup();
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Delete" }));

		// The endpoint removes the subtree, so the subtree has to be in the words.
		expect(
			screen.getByText(
				'This will delete "src" and everything inside it. This action cannot be undone.',
			),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Delete" }));

		expect(deleteFile).toHaveBeenCalledWith("src");
	});

	it("closes the file being read when the folder holding it is deleted", async () => {
		const user = userEvent.setup();
		const onCloseFile = vi.fn();
		renderFilesTab({}, { activeFilePath: "src/main.tsx", onCloseFile });

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await user.click(screen.getByRole("button", { name: "Delete" }));

		// The overlay reads the file's own path, which invalidating the folder
		// around it does not touch: left open it would go on showing a file that
		// is no longer there.
		await waitFor(() => expect(onCloseFile).toHaveBeenCalled());
	});

	it("reports a failed delete without leaving the row looking gone", async () => {
		const user = userEvent.setup();
		deleteFile.mockRejectedValue(new Error("permission denied"));
		renderFilesTab();

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));
		await user.click(screen.getByRole("button", { name: "Delete" }));

		expect(await screen.findByText("permission denied")).toBeInTheDocument();
	});
});

describe("FilesTab folder download", () => {
	beforeEach(() => {
		treeEntries = [...DEFAULT_TREE_ENTRIES];
		searchFiles.mockResolvedValue(result([]));
		saveRawFolder.mockReset();
	});

	/** A save that settles when the case says, and records its signal. */
	function pendingSave() {
		const save: {
			signal?: AbortSignal;
			resolve: () => void;
			reject: (error: Error) => void;
		} = { resolve: () => {}, reject: () => {} };
		saveRawFolder.mockImplementationOnce(
			(_path: string, signal: AbortSignal) =>
				new Promise<void>((resolve, reject) => {
					save.signal = signal;
					save.resolve = resolve;
					save.reject = reject;
				}),
		);
		return save;
	}

	it("keeps the sheet up while the zip is prepared, and closes it on hand-over", async () => {
		const user = userEvent.setup();
		const save = pendingSave();
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Download as zip" }));

		expect(saveRawFolder).toHaveBeenCalledWith("src", expect.any(AbortSignal));
		expect(
			screen.getByRole("button", { name: /Cancel download.*Preparing zip/ }),
		).toBeInTheDocument();

		await act(async () => save.resolve());

		// The browser has it now; the app shows nothing more about it.
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("downloads the project root from the root's menu", async () => {
		const user = userEvent.setup();
		saveRawFolder.mockResolvedValue(undefined);
		renderFilesTab({ "": [] });

		await user.click(
			screen.getByRole("button", { name: "Project root actions" }),
		);
		await user.click(screen.getByRole("button", { name: "Download as zip" }));

		expect(saveRawFolder).toHaveBeenCalledWith("", expect.any(AbortSignal));
	});

	it("is not offered for a file", async () => {
		const user = userEvent.setup();
		renderFilesTab();

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);

		expect(
			screen.queryByRole("button", { name: "Download as zip" }),
		).not.toBeInTheDocument();
	});

	it("closes the sheet and reports a refusal in the tab's banner", async () => {
		const user = userEvent.setup();
		saveRawFolder.mockRejectedValue(
			new Error("Folder not found — it may have been moved or deleted"),
		);
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Download as zip" }));

		expect(
			await screen.findByText(
				"Download failed: Folder not found — it may have been moved or deleted",
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it.each([
		["pressing it again", "Cancel download"],
		["closing the sheet", "Close"],
	])("cancels on %s and says nothing", async (_, button) => {
		const user = userEvent.setup();
		const save = pendingSave();
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Download as zip" }));
		await user.click(
			screen.getByRole("button", { name: new RegExp(`^${button}`) }),
		);

		expect(save.signal?.aborted).toBe(true);
		const abort = new Error("aborted");
		abort.name = "AbortError";
		await act(async () => save.reject(abort));
		expect(screen.queryByText(/Download failed/)).not.toBeInTheDocument();
	});

	// The capability's request is not cancellable: it can still fail on its own
	// — a timeout, a dropped connection — after the user has moved on.
	it("says nothing, and leaves the next menu open, when a cancelled download fails late", async () => {
		const user = userEvent.setup();
		const save = pendingSave();
		renderFilesTab();

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Download as zip" }));
		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);

		await act(async () => save.reject(new Error("RPC timed out")));

		expect(screen.queryByText(/Download failed/)).not.toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});

describe("FilesTab renaming", () => {
	beforeEach(() => {
		treeEntries = [...DEFAULT_TREE_ENTRIES];
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		wsState.maxUploadSize = 0;
		renameFile.mockReset();
		getFile.mockReset();
		renameFile.mockResolvedValue(undefined);
		vi.mocked(uploadFile).mockReset();
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
	});

	it("asks for a name, not a path, and keeps the entry in its own folder", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("main.tsx", "file", "src")] });

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename" }));

		// The name to be changed is already in the field, so the common case is
		// an edit rather than a retype.
		expect(screen.getByLabelText("Name")).toHaveValue("main.tsx");
		expect(screen.getByText("in src")).toBeInTheDocument();

		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "app.tsx");
		await user.click(screen.getByRole("button", { name: "Rename" }));

		// A name, not "src/app.tsx": the directory is the server's business here.
		expect(renameFile).toHaveBeenCalledWith("src/main.tsx", "app.tsx");
	});

	it("pre-selects the name without its extension, and folders whole", async () => {
		const user = userEvent.setup();
		treeEntries = [
			entry("report.final.md", "file", "src"),
			entry(".gitignore", "file", "src"),
			entry("utils", "dir", "src"),
		];
		renderFilesTab({
			src: [
				entry("report.final.md", "file", "src"),
				entry(".gitignore", "file", "src"),
				entry("utils", "dir", "src"),
			],
			"": [entry("src", "dir")],
		});

		const selectionAfterOpening = async (menu: string) => {
			await user.click(screen.getByRole("button", { name: menu }));
			await user.click(screen.getByRole("button", { name: "Rename" }));
			const input = screen.getByLabelText("Name") as HTMLInputElement;
			const selected = input.value.slice(
				input.selectionStart ?? 0,
				input.selectionEnd ?? 0,
			);
			await user.click(screen.getByRole("button", { name: "Cancel" }));
			return selected;
		};

		// Renaming is nearly always about the name and not the type, so typing
		// over the selection keeps the extension.
		expect(await selectionAfterOpening("menu for src/report.final.md")).toBe(
			"report.final",
		);
		// A dotfile's leading dot is part of its name, not a suffix on one.
		expect(await selectionAfterOpening("menu for src/.gitignore")).toBe(
			".gitignore",
		);
		expect(await selectionAfterOpening("menu for src/utils")).toBe("utils");
	});

	it("holds the button on the name the entry already has, without scolding", async () => {
		const user = userEvent.setup();
		renderFilesTab({ src: [entry("main.tsx", "file", "src")] });

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename" }));

		// Its own name is in its own folder's listing; answered as "unchanged"
		// rather than as a clash, and nothing is said about it.
		expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();

		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "other.tsx");
		expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled();
	});

	it("refuses a name a sibling already holds without asking the server", async () => {
		const user = userEvent.setup();
		renderFilesTab({
			src: [entry("main.tsx", "file", "src"), entry("app.tsx", "file", "src")],
		});

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename" }));
		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "app.tsx");

		expect(screen.getByRole("alert")).toHaveTextContent("already exists here");
		expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
		expect(renameFile).not.toHaveBeenCalled();
	});

	it("follows the file being read to its new path instead of closing it", async () => {
		const user = userEvent.setup();
		const onRepointFile = vi.fn();
		const onCloseFile = vi.fn();
		renderFilesTab(
			{ "": [entry("src", "dir")] },
			{ activeFilePath: "src/main.tsx", onRepointFile, onCloseFile },
		);

		await user.click(screen.getByRole("button", { name: "menu for src" }));
		await user.click(screen.getByRole("button", { name: "Rename" }));
		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "lib");
		await user.click(screen.getByRole("button", { name: "Rename" }));

		// Nothing was lost, so closing the viewer would be telling the user
		// something untrue; the file it shows just sits one name over.
		// `onRepointFile`, not `onSelectFile`: the sidebar answers the latter by
		// closing its drawer on a phone, which is right for a tap on a row and
		// wrong for a rename nobody asked to navigate.
		await waitFor(() =>
			expect(onRepointFile).toHaveBeenCalledWith("lib/main.tsx"),
		);
		expect(onCloseFile).not.toHaveBeenCalled();
		// A renamed folder is a new key in the tree, so its row remounts collapsed.
		expect(screen.getByText("force open: lib")).toBeInTheDocument();
	});

	it("keeps the sheet up when the server is the one that finds the clash", async () => {
		const user = userEvent.setup();
		renameFile.mockRejectedValue(new Error("src/app.tsx already exists"));
		renderFilesTab({ src: [entry("main.tsx", "file", "src")] });

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename" }));
		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "app.tsx");
		await user.click(screen.getByRole("button", { name: "Rename" }));

		// A case-insensitive filesystem lands here for a name the client let
		// through, and the typed name has to survive for the user to correct it.
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"src/app.tsx already exists",
		);
		expect(screen.getByLabelText("Name")).toHaveValue("app.tsx");
	});

	it("reports any other failure in the tab's error bar", async () => {
		const user = userEvent.setup();
		renameFile.mockRejectedValue(new Error("permission denied"));
		renderFilesTab({ src: [entry("main.tsx", "file", "src")] });

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename" }));
		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "app.tsx");
		await user.click(screen.getByRole("button", { name: "Rename" }));

		// About the request rather than the name, so it leaves with the sheet.
		expect(await screen.findByText("permission denied")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.queryByLabelText("Name")).not.toBeInTheDocument(),
		);
	});

	it("says why a folder above the file being edited cannot be renamed", async () => {
		const user = userEvent.setup();
		renderFilesTab(
			{},
			{ activeFilePath: "src/main.tsx", activeFileEdit: true },
		);

		await user.click(screen.getByRole("button", { name: "menu for src" }));

		// Left in place with the reason rather than hidden: a control that is not
		// there teaches the user nothing.
		const row = screen.getByRole("button", { name: /Rename/ });
		expect(row).toHaveAttribute("aria-disabled", "true");
		expect(row).toHaveTextContent("Close the editor first.");

		await user.click(row);
		expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
	});

	it("stops waiting for a listing that failed and lets the server decide", async () => {
		const user = userEvent.setup();
		// No listing seeded and the fetch refused: the answer to "is this name
		// taken" is never coming.
		getFile.mockRejectedValue(new Error("connection lost"));
		renderFilesTab();

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename" }));
		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "app.tsx");

		// Held behind a spinner forever, renaming anything in a folder that
		// cannot be listed would be impossible. The local check is given up and
		// `file.rename` — the only authority either way — answers instead.
		// Not at the first failure: `useContents` keeps the default retry budget
		// for anything but a timeout, so the sheet holds the spinner through
		// those attempts and gives up only once they are spent.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Rename" })).toBeEnabled(),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Rename" }));
		expect(renameFile).toHaveBeenCalledWith("src/main.tsx", "app.tsx");
	});

	it("leaves renaming available while the file is only being read", async () => {
		const user = userEvent.setup();
		renderFilesTab(
			{ src: [entry("main.tsx", "file", "src")] },
			{ activeFilePath: "src/main.tsx", activeFileEdit: false },
		);

		await user.click(
			screen.getByRole("button", { name: "menu for src/main.tsx" }),
		);
		await user.click(screen.getByRole("button", { name: "Rename" }));

		expect(screen.getByLabelText("Name")).toBeInTheDocument();
	});
});

describe("FilesTab moving by dragging", () => {
	const originalMatchMedia = window.matchMedia;

	beforeEach(() => {
		searchFiles.mockResolvedValue(result([]));
		uploadActions.reset();
		moveFile.mockReset();
		getFile.mockReset();
		getFile.mockReturnValue(new Promise(() => {}));
		vi.mocked(uploadFile).mockReset();
		dragStartsExpanded = false;
		// Rows are dragged with a mouse, so only a fine pointer gets the gesture.
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: (query: string) => ({
				...originalMatchMedia(query),
				matches: query === "(hover: hover) and (pointer: fine)",
			}),
		});
	});

	afterEach(() => {
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: originalMatchMedia,
		});
		vi.useRealTimers();
	});

	function rowDrag() {
		return { types: [ENTRY_DRAG_TYPE], dropEffect: "none" };
	}

	function libRow(): Element {
		const row = document.querySelector('[data-entry-path="lib"]');
		if (!row) throw new Error("no lib row rendered");
		return row;
	}

	/** Picks `source` up and holds it over `target`; the drag, to go on with. */
	function dragRow(source: Element, target: Element) {
		const dataTransfer = rowDrag();
		fireEvent.dragStart(source, { dataTransfer });
		fireEvent.dragEnter(target, { dataTransfer });
		fireEvent.dragOver(target, { dataTransfer });
		return dataTransfer;
	}

	function moveRow(source: Element, target: Element) {
		const dataTransfer = dragRow(source, target);
		fireEvent.drop(target, { dataTransfer });
		// Sent to the row the drag started from, as a browser does.
		fireEvent.dragEnd(source, { dataTransfer });
	}

	it("moves a row to where it is let go, never uploading it", async () => {
		moveFile.mockResolvedValue("main.tsx");
		renderFilesTab({ "": [entry("src", "dir")] });

		const dataTransfer = dragRow(fileRow(), panel());

		expect(
			screen.getByText("Move main.tsx to project root"),
		).toBeInTheDocument();
		expect(screen.getByText("drop target: root")).toBeInTheDocument();
		expect(dataTransfer.dropEffect).toBe("move");
		expect(
			await screen.findByText("dragging: src/main.tsx"),
		).toBeInTheDocument();

		fireEvent.drop(panel(), { dataTransfer });
		fireEvent.dragEnd(fileRow(), { dataTransfer });

		expect(moveFile).toHaveBeenCalledWith("src/main.tsx", "");
		expect(uploadFile).not.toHaveBeenCalled();
		expect(screen.queryByText(/^Move main/)).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByText("moving: none")).toBeInTheDocument(),
		);
	});

	it("dims the row until the move is answered", async () => {
		let answer: (path: string) => void = () => {};
		moveFile.mockReturnValue(
			new Promise<string>((resolve) => {
				answer = resolve;
			}),
		);
		renderFilesTab({ "": [entry("src", "dir")] });

		moveRow(fileRow(), panel());

		// The drag is over but the request is not: the row stays faded and cannot
		// be picked up again for a second move of a path about to be vacated.
		expect(screen.getByText("dragging: none")).toBeInTheDocument();
		expect(screen.getByText("moving: src/main.tsx")).toBeInTheDocument();

		await act(async () => answer("main.tsx"));

		expect(screen.getByText("moving: none")).toBeInTheDocument();
	});

	it.each<{
		name: string;
		source: () => Element;
		target: () => Element;
		listings: Record<string, Entry[]>;
		reason: string;
	}>([
		{
			name: "a folder into itself",
			source: () => folderRow(),
			target: () => fileRow(),
			listings: {},
			reason: "Can't move a folder into itself",
		},
		{
			name: "an entry into the folder it is already in",
			source: () => fileRow(),
			target: () => folderRow(),
			listings: {},
			reason: "Already in src",
		},
		{
			name: "onto a name the destination already holds",
			source: () => fileRow(),
			target: () => panel(),
			listings: { "": [entry("main.tsx", "file")] },
			reason: "Project root already has main.tsx",
		},
	])("turns away $name and says why", ({
		source,
		target,
		listings,
		reason,
	}) => {
		vi.useFakeTimers();
		renderFilesTab(listings);

		const dataTransfer = dragRow(source(), target());

		expect(screen.getByText(reason)).toBeInTheDocument();
		expect(dataTransfer.dropEffect).toBe("none");
		expect(screen.getByText("drop target: none")).toBeInTheDocument();
		// Hovering does not open anything that would turn the drop away, which
		// for a moved folder is the folder itself.
		act(() => vi.advanceTimersByTime(700));
		expect(screen.getByText("spring open: none")).toBeInTheDocument();

		fireEvent.drop(target(), { dataTransfer });
		expect(moveFile).not.toHaveBeenCalled();
	});

	it("turns away a move of the file being edited, wherever it is aimed", () => {
		renderFilesTab(
			{},
			{ activeFilePath: "src/main.tsx", activeFileEdit: true },
		);

		const dataTransfer = dragRow(folderRow(), libRow());

		expect(screen.getByText("Close the editor first")).toBeInTheDocument();
		fireEvent.drop(libRow(), { dataTransfer });
		expect(moveFile).not.toHaveBeenCalled();
	});

	it("follows the file being read and reopens the folder where it landed", async () => {
		moveFile.mockResolvedValue("lib/src");
		dragStartsExpanded = true;
		const onRepointFile = vi.fn();
		const onCloseFile = vi.fn();
		renderFilesTab(
			{},
			{ activeFilePath: "src/main.tsx", onRepointFile, onCloseFile },
		);

		moveRow(folderRow(), libRow());

		expect(moveFile).toHaveBeenCalledWith("src", "lib");
		await waitFor(() =>
			expect(onRepointFile).toHaveBeenCalledWith("lib/src/main.tsx"),
		);
		expect(onCloseFile).not.toHaveBeenCalled();
		// The destination, so the entry is seen arriving, and the folder itself,
		// a new key in the tree that was open when it was picked up.
		expect(screen.getByText("force open: lib, lib/src")).toBeInTheDocument();
	});

	it("reports a refusal and refetches both folders it involved", async () => {
		moveFile.mockRejectedValue(new Error("lib/main.tsx already exists"));
		// The stand-in tree observes no listing, so a refetch is never started;
		// what is asked of the cache is what there is to check.
		const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
		const remove = vi.spyOn(QueryClient.prototype, "removeQueries");
		renderFilesTab();

		moveRow(fileRow(), libRow());

		expect(
			await screen.findByText("Move failed: lib/main.tsx already exists"),
		).toBeInTheDocument();
		// Either listing may have been the stale one, and the message cannot say
		// which; both are fetched again rather than dropped.
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: contentsQueryKey("src"),
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: contentsQueryKey("lib"),
		});
		expect(remove).not.toHaveBeenCalled();
		expect(screen.getByText("force open: none")).toBeInTheDocument();
		invalidate.mockRestore();
		remove.mockRestore();
	});

	it("leaves rows undraggable on a touch screen", () => {
		Object.defineProperty(window, "matchMedia", {
			writable: true,
			value: originalMatchMedia,
		});
		renderFilesTab();

		expect(screen.getByText("rows draggable: no")).toBeInTheDocument();
	});

	it("lets go of a drag whose row left the page under it", async () => {
		renderFilesTab();
		const row = fileRow();
		const dataTransfer = dragRow(row, panel());
		expect(
			await screen.findByText("dragging: src/main.tsx"),
		).toBeInTheDocument();
		// The folder refreshed and the row went with it. Its `dragend` still goes
		// to it, but no longer bubbles to anything above.
		row.remove();

		fireEvent.dragEnd(row, { dataTransfer });

		expect(screen.getByText("dragging: none")).toBeInTheDocument();
		// Nor does the panel go on taking it for one of its own.
		dataTransfer.dropEffect = "none";
		fireEvent.dragEnter(panel(), { dataTransfer });
		fireEvent.dragOver(panel(), { dataTransfer });
		expect(screen.queryByText(/^Move main/)).not.toBeInTheDocument();
		expect(screen.getByText("drop target: none")).toBeInTheDocument();
		expect(dataTransfer.dropEffect).toBe("none");
	});

	it("turns away a move into or out of one still in flight", () => {
		moveFile.mockReturnValue(new Promise(() => {}));
		renderFilesTab();

		moveRow(folderRow(), libRow());
		// `src` is about to be somewhere else, so neither what is in it nor it as
		// a destination is where it seems to be.
		dragRow(fileRow(), libRow());

		expect(
			screen.getByText("Wait for the move in progress"),
		).toBeInTheDocument();
		expect(moveFile).toHaveBeenCalledTimes(1);
	});

	it("drops the answer to a move made before a worktree switch", async () => {
		let answer: (path: string) => void = () => {};
		moveFile.mockReturnValue(
			new Promise<string>((resolve) => {
				answer = resolve;
			}),
		);
		dragStartsExpanded = true;
		const onRepointFile = vi.fn();
		renderFilesTab({}, { activeFilePath: "src/main.tsx", onRepointFile });
		worktreeActions.setCurrent("");

		moveRow(folderRow(), libRow());
		act(() => worktreeActions.setCurrent("feature-x"));
		// The row in the new tree that happens to share the path is not held.
		expect(screen.getByText("moving: none")).toBeInTheDocument();

		await act(async () => answer("lib/src"));

		// About the other tree: following it would navigate back there, and the
		// paths opened here would be this tree's namesakes.
		expect(onRepointFile).not.toHaveBeenCalled();
		expect(screen.getByText("force open: none")).toBeInTheDocument();
		worktreeActions.setCurrent("");
	});

	it("follows the file with the view shown when the move is answered", async () => {
		let answer: (path: string) => void = () => {};
		moveFile.mockReturnValue(
			new Promise<string>((resolve) => {
				answer = resolve;
			}),
		);
		const repointBefore = vi.fn();
		const { rerender } = renderFilesTab(
			{},
			{ activeFilePath: "src/main.tsx", onRepointFile: repointBefore },
		);

		moveRow(folderRow(), libRow());
		// Another session opened while the move was out: the callback the shell
		// hands down now navigates within that one.
		const repointAfter = vi.fn();
		rerender(
			<FilesTab
				onSelectFile={vi.fn()}
				activeFilePath="src/main.tsx"
				activeFileEdit={false}
				onRepointFile={repointAfter}
				onCloseFile={vi.fn()}
			/>,
		);

		await act(async () => answer("lib/src"));

		expect(repointBefore).not.toHaveBeenCalled();
		expect(repointAfter).toHaveBeenCalledWith("lib/src/main.tsx");
	});
});
