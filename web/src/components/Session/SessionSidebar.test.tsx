import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "../../lib/fileUpload";
import { uploadActions } from "../../lib/uploadStore";
import SessionSidebar from "./SessionSidebar";

const wsState = { maxUploadSize: 0 };

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

vi.mock("../../hooks/useSession", () => ({
	useSession: () => ({
		hasAnyUnread: false,
		filteredSessions: [],
		isLoading: false,
		refresh: vi.fn(),
	}),
}));

// The tabs are not what is under test; the one call the Files tab makes back
// into the sidebar is.
vi.mock("../Files", () => ({
	FilesTab: ({ onSelectFile }: { onSelectFile: (path: string) => void }) => (
		<button type="button" onClick={() => onSelectFile("src/main.tsx")}>
			open src/main.tsx
		</button>
	),
}));
vi.mock("../Git", () => ({ DiffTab: () => null }));
vi.mock("../Project", () => ({ ProjectTab: () => null }));
vi.mock("../Worktree", () => ({ WorktreeSwitcher: () => null }));

function renderSidebar(onClose: () => void) {
	render(
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
			onOpenWorkList={vi.fn()}
			onOpenAgentRoleList={vi.fn()}
			isSwitchingWorktree={false}
			isDesktop={false}
		/>,
	);
}

/** The dot the Files tab is badged with, which has nothing else to name it. */
function filesBadge(): Element | null {
	return screen.getByLabelText("Files").querySelector("span");
}

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

	it("closes it again when the only news left is a failure", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		renderSidebar(onClose);
		// Nothing to badge yet, which is also what pins the dot below to the badge
		// rather than to some other span the tab button might grow.
		expect(filesBadge()).toBeNull();

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
		expect(filesBadge()).not.toBeNull();
	});
});
