import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Activity } from "../../lib/activity";
import { uploadFile } from "../../lib/fileUpload";
import { uploadActions } from "../../lib/uploadStore";
import { useWorkStore } from "../../lib/workStore";
import type { WorkListItem } from "../../types/work";
import SessionSidebar from "./SessionSidebar";

const wsState = {
	maxUploadSize: 0,
	// The sessions tab asks which worktrees still hold sessions, but only once
	// the filter leaves this worktree — which it never does here.
	actions: {
		sessionViewWorktrees: vi.fn(),
		sessionViewList: vi.fn(),
	},
};

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

vi.mock("../../hooks/useGitWatch", () => ({ useGitWatch: () => undefined }));
let gitChangeCount: number | undefined;
vi.mock("../../hooks/useGitChangeCount", () => ({
	useGitChangeCount: () => gitChangeCount,
}));

vi.mock("../../hooks/useSession", () => ({
	useSession: () => ({
		hasAnyUnread: false,
		sessions: [],
		isLoading: false,
		refresh: vi.fn(),
	}),
}));

// The tabs are not what is under test; the one call the Files tab makes back
// into the sidebar is.
vi.mock("../Files", () => ({
	FilesTab: ({
		onSelectFile,
		onRepointFile,
	}: {
		onSelectFile: (path: string) => void;
		onRepointFile: (path: string) => void;
	}) => (
		<>
			<button type="button" onClick={() => onSelectFile("src/main.tsx")}>
				open src/main.tsx
			</button>
			<button type="button" onClick={() => onRepointFile("lib/main.tsx")}>
				repoint to lib/main.tsx
			</button>
		</>
	),
}));
vi.mock("../Git", () => ({ DiffTab: () => null }));
vi.mock("../Project", () => ({ ProjectTab: () => null }));
vi.mock("../Worktree", () => ({ WorktreeSwitcher: () => null }));

function renderSidebar(onClose: () => void) {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<SessionSidebar
				isOpen={true}
				onClose={onClose}
				currentSessionId={null}
				onSelectSession={vi.fn()}
				onCreateSession={vi.fn()}
				onDeleteSession={vi.fn()}
				onSelectDiffFile={vi.fn()}
				onCloseDiffFile={vi.fn()}
				activeDiffFile={null}
				onSelectCommit={vi.fn()}
				activeCommitHash={null}
				onSelectFile={vi.fn()}
				activeFilePath={null}
				activeFileEdit={false}
				onRepointFile={vi.fn()}
				onCloseFile={vi.fn()}
				onOpenWorkList={vi.fn()}
				onOpenAgentRoleList={vi.fn()}
				isSwitchingWorktree={false}
				isExpanded={false}
			/>
		</QueryClientProvider>,
	);
}

/**
 * The dot a tab is badged with, which has nothing else to name it: it is
 * `aria-hidden` and carries no text. Nested, because the tab button wraps its
 * icon in the span the badges anchor to.
 */
function tabBadge(label: string): Element | null {
	return screen.getByLabelText(label).querySelector("span > span");
}

// Module-level, so every case states the count it is about rather than
// inheriting one from whichever ran before it.
beforeEach(() => {
	gitChangeCount = undefined;
	// Same reason, and in both directions: the work list feeds the Project tab's
	// badge, so a case that leaves rows behind would badge a later case's sidebar.
	useWorkStore.getState().reset();
});

describe("SessionSidebar on a phone", () => {
	beforeEach(() => {
		uploadActions.reset();
		vi.mocked(uploadFile).mockReset();
		// Stays in flight, so an upload keeps the status the case is about.
		vi.mocked(uploadFile).mockImplementation(() => new Promise(() => {}));
	});

	it("holds the drawer open while an upload is still running", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderSidebar(onClose);
		uploadActions.enqueue([
			{ file: new File(["x"], "hero.png"), destPath: "" },
		]);

		await user.click(screen.getByRole("button", { name: "open src/main.tsx" }));

		// Closing takes the queue and the tab bar that badges it off screen
		// together, leaving the upload with nothing to report to.
		expect(onClose).not.toHaveBeenCalled();
	});

	it("stays open when a rename only re-points the file already on screen", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderSidebar(onClose);

		await user.click(
			screen.getByRole("button", { name: "repoint to lib/main.tsx" }),
		);

		// Closing is the answer to a tap on a row, which says "show me this".
		// A rename says nothing of the kind — the user is still in the tree, and
		// taking it out from under them would be a reply to something they did
		// not ask.
		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes it again when the only news left is a failure", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderSidebar(onClose);
		// Nothing to badge yet, which is also what pins the dot below to the badge
		// rather than to some other span the tab button might grow.
		expect(tabBadge("Files")).toBeNull();

		// A folder of that name: refused before anything is sent, and the row then
		// stays until it is dismissed.
		uploadActions.enqueue([
			{ file: new File(["x"], "assets"), destPath: "", blockedBy: "folder" },
		]);

		await user.click(screen.getByRole("button", { name: "open src/main.tsx" }));

		// A failure has already reported. Waiting on one nobody dismissed would
		// leave the drawer standing open over every file tapped from then on.
		expect(onClose).toHaveBeenCalled();
		// The badge is the wider question and still lit, which is how the row is
		// found again once the file has been read.
		expect(tabBadge("Files")).not.toBeNull();
	});
});

describe("the Git tab's change count", () => {
	it("is spoken after the tab label, with the noun it counts", () => {
		gitChangeCount = 5;
		renderSidebar(vi.fn());
		expect(
			screen.getByRole("button", { name: "Git, 5 changed files" }),
		).toBeInTheDocument();
	});

	it("drops the plural for a single file", () => {
		gitChangeCount = 1;
		renderSidebar(vi.fn());
		expect(
			screen.getByRole("button", { name: "Git, 1 changed file" }),
		).toBeInTheDocument();
	});

	it("says nothing at all when there is nothing changed", () => {
		gitChangeCount = 0;
		renderSidebar(vi.fn());
		expect(screen.getByRole("button", { name: "Git" })).toBeInTheDocument();
	});
});

describe("the Project tab's attention badge", () => {
	// Its activity is the whole of what the badge reads; the rest is scaffolding.
	const work = (activity: Activity): WorkListItem => ({
		id: "w1",
		type: "task",
		title: "Rewire the lifecycle",
		status: "active",
		activity,
		updated_at: "2026-03-04T00:00:00Z",
	});

	it("lights while a work is waiting on the user", () => {
		useWorkStore.getState().setWorks([work("needs_permission")]);

		renderSidebar(vi.fn());

		// On a phone the sidebar is a drawer: without this the user has to open it
		// and pick the tab to find out anyone is waiting.
		expect(tabBadge("Project")).not.toBeNull();
		// The hue the other tabs use means "there is news here". This one means a
		// person is being waited on, and has to match the dot it stands for inside
		// the tab — one dot, one hue, one meaning (docs/lifecycle-ui.md §4).
		expect(tabBadge("Project")).toHaveClass("bg-th-warning");
	});

	it("says nothing while every work is getting on with it", () => {
		useWorkStore.getState().setWorks([work("running")]);

		renderSidebar(vi.fn());

		expect(tabBadge("Project")).toBeNull();
	});
});
