import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeBranch } from "../../test/gitFixtures";
import type { GitBranches, GitCommit, GitStatus } from "../../types/git";
import GitWorkspace, { type GitLayer } from "./GitWorkspace";

const layout = vi.hoisted(() => ({ expanded: false }));
let status: GitStatus | undefined;
let commits: GitCommit[] | undefined;
let branches: Pick<GitBranches, "local" | "remote_only"> | undefined;

vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => layout.expanded,
}));
vi.mock("../../hooks/useOpenSessionUnread", () => ({
	useOpenSessionUnread: () => false,
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({ data: status }),
}));
// Has tests of its own (hooks/useGitSync.test.tsx).
vi.mock("../../hooks/useGitSync", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitSync")>()),
	useAutoFetch: () => {},
}));
vi.mock("../../hooks/useGitLog", () => ({
	useGitLog: () => ({ data: commits && { pages: [{ commits, next: null }] } }),
}));
vi.mock("../../hooks/useGitBranches", () => ({
	useGitBranches: () => ({ data: branches }),
}));

// What is under test is which layers are on screen and where their ways back
// lead; the sections and pages themselves have tests of their own.
vi.mock("./BranchBar", () => ({
	default: ({
		onOpenBranches,
		branchFailureSurface,
	}: {
		onOpenBranches: () => void;
		branchFailureSurface: boolean;
	}) => (
		<>
			<button type="button" onClick={onOpenBranches}>
				Branches, currently on main
			</button>
			{!branchFailureSurface && <div>top bar holds switch failures</div>}
		</>
	),
}));
vi.mock("./ChangesSection", () => ({
	default: ({
		activeFile,
	}: {
		activeFile: { path: string; staged: boolean } | null;
	}) => <div>changes list, active {activeFile?.path ?? "none"}</div>,
}));
vi.mock("./HistorySection", () => ({
	default: ({ activeHash }: { activeHash: string | null }) => (
		<div>history list, active {activeHash ?? "none"}</div>
	),
}));
// Has the prefill handoff's own tests behind it; it needs a router here.
vi.mock("../../hooks/useBranchMergeHandoff", () => ({
	useBranchMergeHandoff: () => ({
		handingOff: null,
		error: null,
		dismissError: () => {},
		start: () => {},
	}),
}));
const TOPIC_ROW = { key: "local:topic", label: "topic", remote: false };
vi.mock("./BranchesSection", () => ({
	default: ({
		activeKey,
		onSelectBranch,
		onBranchDeleted,
	}: {
		activeKey: string | null;
		onSelectBranch: (row: typeof TOPIC_ROW) => void;
		onBranchDeleted: (row: typeof TOPIC_ROW) => void;
	}) => (
		<div>
			branches list, active {activeKey ?? "none"}
			<button type="button" onClick={() => onSelectBranch(TOPIC_ROW)}>
				open topic
			</button>
			<button type="button" onClick={() => onBranchDeleted(TOPIC_ROW)}>
				topic deleted
			</button>
		</div>
	),
}));
vi.mock("./BranchDetail", async () => {
	const Page = page("branch");
	return {
		default: ({
			onBack,
			holdsFailures,
		}: {
			onBack?: () => void;
			holdsFailures: boolean;
		}) => (
			<>
				<Page onBack={onBack} />
				{holdsFailures && <div>branch page holds failures</div>}
			</>
		),
	};
});
const page = vi.hoisted(
	() =>
		(name: string) =>
		({ onBack }: { onBack?: () => void }) => (
			<div>
				{name} page
				{onBack && (
					<button type="button" onClick={onBack}>
						{name} back
					</button>
				)}
			</div>
		),
);
const diffMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("./DiffView", async () => {
	const { useEffect } = await import("react");
	const Page = page("diff");
	return {
		// The review leaves by itself, replacing; all it is told is whether to
		// offer the way back.
		default: ({ showBack }: { showBack?: boolean }) => {
			useEffect(() => {
				diffMounts.count++;
			}, []);
			return <Page onBack={showBack ? () => {} : undefined} />;
		},
	};
});
vi.mock("./OperationBanner", () => ({
	default: ({
		compact,
		onSelectFile,
	}: {
		compact: boolean;
		onSelectFile: (path: string) => void;
	}) => (
		<button type="button" onClick={() => onSelectFile("src/c.ts")}>
			{compact ? "one-line banner" : "full banner"}
		</button>
	),
}));
vi.mock("./CommitView", () => ({ default: page("commit") }));
vi.mock("./CommitDiffView", () => ({ default: page("commit diff") }));
vi.mock("./CommitFileView", () => ({ default: page("commit file") }));

function renderWorkspace(layer: GitLayer) {
	const props = {
		onBack: vi.fn(),
		onSelectSegment: vi.fn(),
		onSelectFile: vi.fn(),
		onSelectCommit: vi.fn(),
		onSelectBranch: vi.fn(),
		onRepointBranch: vi.fn(),
		onCloseFile: vi.fn(),
	};
	const view = render(<GitWorkspace layer={layer} {...props} />);
	return { ...props, ...view };
}

const segmentControl = () =>
	screen.queryByRole("group", { name: "Which part of the repository to show" });

const resizeHandle = () =>
	screen.queryByRole("separator", { name: "Resize list" });

const DIFF: GitLayer = { type: "diff", path: "src/a.ts", staged: false };
const TOPIC: GitLayer = { type: "branch", ref: "topic", remote: false };

beforeEach(() => {
	layout.expanded = false;
	status = { staged: [], unstaged: [{ path: "src/a.ts", status: "M" }] };
	commits = [];
	branches = {
		local: [makeBranch("main", { current: true })],
		remote_only: [],
	};
});

describe("GitWorkspace below expanded", () => {
	it("shows a list under the segment control, with the way back to the chat", async () => {
		const user = userEvent.setup();
		const { onBack, onSelectSegment } = renderWorkspace({
			type: "git",
			segment: "history",
		});

		expect(screen.getByRole("heading", { name: "Git" })).toBeInTheDocument();
		expect(screen.getByText(/history list/)).toBeVisible();
		expect(
			screen.getByRole("button", { name: "History", pressed: true }),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Branches" }));
		expect(onSelectSegment).toHaveBeenLastCalledWith("branches");

		await user.click(screen.getByRole("button", { name: "Back to chat" }));
		expect(onBack).toHaveBeenCalled();
	});

	it("opens Branches from the branch name in the top bar", async () => {
		const user = userEvent.setup();
		const { onSelectSegment } = renderWorkspace({
			type: "git",
			segment: "changes",
		});

		await user.click(
			screen.getByRole("button", { name: "Branches, currently on main" }),
		);
		expect(onSelectSegment).toHaveBeenCalledWith("branches");
	});

	// A switch's failure is shown by the Branches list while it is on screen,
	// by a branch's detail covering it, and by the top bar on every other
	// layer.
	it("tells the top bar whether a branch surface is holding a switch's failure", () => {
		const { rerender, ...props } = renderWorkspace({
			type: "git",
			segment: "branches",
		});
		expect(screen.queryByText("top bar holds switch failures")).toBeNull();

		rerender(<GitWorkspace layer={TOPIC} {...props} />);
		expect(screen.queryByText("top bar holds switch failures")).toBeNull();
		expect(screen.getByText("branch page holds failures")).toBeInTheDocument();

		rerender(<GitWorkspace layer={DIFF} {...props} />);
		expect(
			screen.getByText("top bar holds switch failures"),
		).toBeInTheDocument();
	});

	// A row selects; switching is an action of the branch's.
	it("opens a branch from its row, and goes back from it to the list", async () => {
		const user = userEvent.setup();
		const { onSelectBranch, rerender, ...props } = renderWorkspace({
			type: "git",
			segment: "branches",
		});

		await user.click(screen.getByRole("button", { name: "open topic" }));
		expect(onSelectBranch).toHaveBeenCalledWith({
			ref: "topic",
			remote: false,
		});

		rerender(
			<GitWorkspace layer={TOPIC} onSelectBranch={onSelectBranch} {...props} />,
		);
		expect(screen.getByText("branch page")).toBeVisible();
		// Covered: nothing is lit under a page.
		expect(screen.getByText(/branches list/)).toHaveTextContent("active none");
		await user.click(screen.getByRole("button", { name: "branch back" }));
		expect(props.onSelectSegment).toHaveBeenCalledWith("branches");
	});

	// Whichever surface it was pressed in: the route is the workspace's to
	// correct, and only if that branch's detail is still the one open.
	it("asks to leave a deleted branch's detail", async () => {
		const user = userEvent.setup();
		const { onRepointBranch } = renderWorkspace(TOPIC);

		await user.click(screen.getByRole("button", { name: "topic deleted" }));
		expect(onRepointBranch).toHaveBeenCalledWith(
			{ ref: "topic", remote: false },
			null,
			"",
		);
	});

	it("has no list edge to drag", () => {
		renderWorkspace({ type: "git", segment: "changes" });

		expect(resizeHandle()).toBeNull();
	});

	// A layer is the page: no segment control, no list, and its way back is the
	// list it was opened from rather than the chat.
	it("shows a diff on its own, with a way back", () => {
		renderWorkspace(DIFF);

		expect(screen.getByText("diff page")).toBeVisible();
		// Still mounted under the layer, for its scroll position, but covered:
		// `invisible` rather than `hidden`, since `display: none` would destroy
		// the scroll box it is kept for (jsdom applies neither class, hence the
		// class itself is what is asserted).
		const covered = screen.getByText(/changes list/).closest("[inert]");
		expect(covered).toHaveClass("invisible");
		expect(covered).not.toHaveAttribute("hidden");
		expect(covered).toContainElement(segmentControl());
		expect(screen.queryByRole("heading", { name: "Git" })).toBeNull();
		// The top bar stays: a sync left running reports there and nowhere else.
		expect(
			screen.getByRole("button", { name: "Branches, currently on main" }),
		).toBeInTheDocument();

		expect(
			screen.getByRole("button", { name: "diff back" }),
		).toBeInTheDocument();
	});

	// A layer has no room for the whole banner over its content; the list does.
	it("draws the operation banner whole on a list and in one line on a layer", async () => {
		const user = userEvent.setup();
		const { rerender, onSelectFile, ...props } = renderWorkspace({
			type: "git",
			segment: "history",
		});

		await user.click(screen.getByRole("button", { name: "full banner" }));
		// The conflicted file's working-tree side: what its review shows.
		expect(onSelectFile).toHaveBeenCalledWith("src/c.ts", false);

		rerender(
			<GitWorkspace layer={DIFF} onSelectFile={onSelectFile} {...props} />,
		);
		expect(
			screen.getByRole("button", { name: "one-line banner" }),
		).toBeInTheDocument();
	});

	it("goes back from a commit to History", async () => {
		const user = userEvent.setup();
		const { onSelectSegment } = renderWorkspace({
			type: "commit",
			hash: "abc1234",
		});

		await user.click(screen.getByRole("button", { name: "commit back" }));
		expect(onSelectSegment).toHaveBeenCalledWith("history");
	});

	// docs/git-branches-ui.md#opening-a-commit: stacked on the branch, its
	// way back is the branch, not the list.
	it("goes back from a commit opened from a branch to that branch", async () => {
		const user = userEvent.setup();
		const { onSelectBranch, onSelectSegment } = renderWorkspace({
			type: "commit",
			hash: "abc1234",
			branch: { ref: "origin/topic", remote: true },
		});

		await user.click(screen.getByRole("button", { name: "commit back" }));
		expect(onSelectBranch).toHaveBeenCalledWith({
			ref: "origin/topic",
			remote: true,
		});
		expect(onSelectSegment).not.toHaveBeenCalled();
		// Not a surface of branch failures: the top bar holds them.
		expect(
			screen.getByText("top bar holds switch failures"),
		).toBeInTheDocument();
	});
});

describe("GitWorkspace at expanded", () => {
	beforeEach(() => {
		layout.expanded = true;
	});

	it("puts the list and the diff side by side, the diff needing no way back", () => {
		renderWorkspace(DIFF);

		expect(screen.getByText("changes list, active src/a.ts")).toBeVisible();
		expect(screen.getByText("diff page")).toBeVisible();
		expect(segmentControl()).toBeInTheDocument();
		// The app header names the workspace; it cannot name both columns.
		expect(screen.getByRole("heading", { name: "Git" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "diff back" })).toBeNull();
		// Above both columns, so the layer needs no one-line form of its own.
		expect(
			screen.getByRole("button", { name: "full banner" }),
		).toBeInTheDocument();
	});

	// The list beside it is the commit's; its row stays lit through the
	// commit's own layers.
	it("keeps the commit selected in History under a file of it", () => {
		renderWorkspace({ type: "commit-diff", hash: "abc1234", path: "a.ts" });

		expect(screen.getByText("history list, active abc1234")).toBeVisible();
		expect(screen.getByText("commit diff page")).toBeVisible();
	});

	// The list's pinned area is on screen: the failures stay with it.
	it("lights the open branch's row beside its detail", () => {
		renderWorkspace(TOPIC);

		expect(screen.getByText(/branches list/)).toHaveTextContent(
			"active local:topic",
		);
		expect(screen.getByText("branch page")).toBeVisible();
		expect(screen.queryByRole("button", { name: "branch back" })).toBeNull();
		expect(screen.queryByText("branch page holds failures")).toBeNull();
		expect(screen.queryByText("top bar holds switch failures")).toBeNull();
	});

	// The branch is not on screen beside it, so unlike a commit beside
	// History it keeps a way back; the list beside it is the Branches list.
	it("puts a commit opened from a branch beside the Branches list", async () => {
		const user = userEvent.setup();
		const branch = { ref: "topic", remote: false };
		const { onSelectBranch } = renderWorkspace({
			type: "commit",
			hash: "abc1234",
			branch,
		});

		expect(screen.getByText(/branches list/)).toHaveTextContent(
			"active local:topic",
		);
		expect(screen.queryByText("top bar holds switch failures")).toBeNull();
		await user.click(screen.getByRole("button", { name: "commit back" }));
		expect(onSelectBranch).toHaveBeenCalledWith(branch);
	});

	it("keeps the branch lit under a file of a commit opened from it", () => {
		renderWorkspace({
			type: "commit-file",
			hash: "abc1234",
			path: "a.ts",
			branch: { ref: "topic", remote: false },
		});

		expect(screen.getByText(/branches list/)).toHaveTextContent(
			"active local:topic",
		);
		expect(screen.getByText("commit file page")).toBeVisible();
	});

	it.each([
		["changes", "Select a file to see its diff"],
		["history", "Select a commit to see what it changed"],
		["branches", "Select a branch to see its commits"],
	] as const)("says what to do in an empty %s column", (segment, text) => {
		commits = [
			{
				hash: "abc1234",
				parents: [],
				subject: "s",
				author: "a",
				date: "2026-01-01",
			},
		];
		renderWorkspace({ type: "git", segment });

		expect(screen.getByText(text)).toBeInTheDocument();
	});

	it("says there is nothing to choose from when there is nothing", () => {
		status = { staged: [], unstaged: [] };
		const { unmount } = renderWorkspace({ type: "git", segment: "changes" });
		expect(screen.getByText("No changes to review")).toBeInTheDocument();
		unmount();

		commits = [];
		const history = renderWorkspace({ type: "git", segment: "history" });
		expect(screen.getByText("No commits yet")).toBeInTheDocument();
		history.unmount();

		branches = { local: [], remote_only: [] };
		renderWorkspace({ type: "git", segment: "branches" });
		expect(screen.getByText("No branches yet")).toBeInTheDocument();
	});

	// Blank, not a prompt to choose: the list is still saying why it is empty.
	it("leaves the column blank while the list has no answer", () => {
		status = undefined;
		const { unmount } = renderWorkspace({ type: "git", segment: "changes" });

		expect(screen.queryByText(/Select a file/)).toBeNull();
		expect(screen.queryByText(/No changes/)).toBeNull();
		unmount();

		branches = undefined;
		renderWorkspace({ type: "git", segment: "branches" });
		expect(screen.queryByText(/Select a branch/)).toBeNull();
	});

	// Rotating a tablet moves the diff's heading between the app header and its
	// column; the diff itself — its scroll, its state — must not start over.
	it("keeps the open diff mounted across a resize", () => {
		layout.expanded = false;
		diffMounts.count = 0;
		const {
			rerender,
			onBack,
			onSelectSegment,
			onSelectFile,
			onSelectCommit,
			onSelectBranch,
			onRepointBranch,
			onCloseFile,
		} = renderWorkspace(DIFF);

		layout.expanded = true;
		rerender(
			<GitWorkspace
				layer={DIFF}
				onBack={onBack}
				onSelectSegment={onSelectSegment}
				onSelectFile={onSelectFile}
				onSelectCommit={onSelectCommit}
				onSelectBranch={onSelectBranch}
				onRepointBranch={onRepointBranch}
				onCloseFile={onCloseFile}
			/>,
		);

		expect(screen.getByText("diff page")).toBeVisible();
		expect(diffMounts.count).toBe(1);
	});

	// How wide it is drawn and how a drag moves it need layout:
	// GitWorkspace.browser.test.tsx.
	it("puts a resize handle on the list column's edge", () => {
		renderWorkspace(DIFF);

		const handle = resizeHandle();
		expect(handle).toHaveAttribute("aria-orientation", "vertical");
		const column = document.getElementById(
			handle?.getAttribute("aria-controls") ?? "",
		);
		expect(column).toContainElement(
			screen.getByText("changes list, active src/a.ts"),
		);
	});
});
