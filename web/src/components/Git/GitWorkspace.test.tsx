import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitLayer } from "../../types/overlay";
import GitWorkspace from "./GitWorkspace";

const layout = vi.hoisted(() => ({ expanded: false }));

vi.mock("@pockode/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("@pockode/shared")>()),
	useIsExpanded: () => layout.expanded,
}));
vi.mock("../../hooks/useOpenSessionUnread", () => ({
	useOpenSessionUnread: () => false,
}));
// Has tests of its own (hooks/useGitSync.test.tsx).
vi.mock("../../hooks/useGitSync", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../hooks/useGitSync")>()),
	useAutoFetch: () => {},
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
// The app shell's; it has the prefill handoff's own tests behind it.
vi.mock("../../hooks/useBranchMergeHandoff", () => ({
	useSharedMergeHandoff: () => ({
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
			backToChat,
			holdsFailures,
		}: {
			onBack: () => void;
			backToChat?: boolean;
			holdsFailures: boolean;
		}) => (
			<>
				<Page onBack={onBack} backToChat={backToChat} />
				{holdsFailures && <div>branch page holds failures</div>}
			</>
		),
	};
});
const page = vi.hoisted(
	() =>
		(name: string) =>
		({
			onBack,
			backToChat,
			actionsAt,
		}: {
			onBack?: () => void;
			backToChat?: boolean;
			actionsAt?: string;
		}) => (
			<div>
				{name} page
				{actionsAt && (
					<span>
						{name} actions {actionsAt}
					</span>
				)}
				{onBack && (
					<button type="button" onClick={onBack}>
						{name} back{backToChat && " to chat"}
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
		// The review leaves by itself, replacing; all it is told is how to draw
		// its way back.
		default: ({
			backToChat,
			actionsAt,
		}: {
			backToChat?: boolean;
			actionsAt?: string;
		}) => {
			useEffect(() => {
				diffMounts.count++;
			}, []);
			return (
				<Page onBack={() => {}} backToChat={backToChat} actionsAt={actionsAt} />
			);
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

function renderWorkspace(
	layer: GitLayer,
	{ keyboardUp = false, listBeside = false } = {},
) {
	const props = {
		onBack: vi.fn(),
		onSelectSegment: vi.fn(),
		onSelectFile: vi.fn(),
		onSelectCommit: vi.fn(),
		onSelectBranch: vi.fn(),
		onRepointBranch: vi.fn(),
		onCloseFile: vi.fn(),
	};
	const view = render(
		<GitWorkspace
			layer={layer}
			keyboardUp={keyboardUp}
			listBeside={listBeside}
			{...props}
		/>,
	);
	return { ...props, ...view };
}

const segmentControl = () =>
	screen.queryByRole("group", { name: "Which part of the repository to show" });

const topBar = () =>
	screen.queryByRole("button", { name: "Branches, currently on main" });

const DIFF: GitLayer = { type: "diff", path: "src/a.ts", staged: false };
const TOPIC: GitLayer = { type: "branch", ref: "topic", remote: false };

beforeEach(() => {
	layout.expanded = false;
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
	// by a branch's detail covering it, and by the top bar over any other
	// list.
	it("tells the top bar whether a branch surface is holding a switch's failure", () => {
		const { rerender, ...props } = renderWorkspace({
			type: "git",
			segment: "branches",
		});
		expect(screen.queryByText("top bar holds switch failures")).toBeNull();

		rerender(<GitWorkspace layer={TOPIC} {...props} />);
		expect(screen.getByText("branch page holds failures")).toBeInTheDocument();

		rerender(
			<GitWorkspace layer={{ type: "git", segment: "history" }} {...props} />,
		);
		expect(
			screen.getByText("top bar holds switch failures"),
		).toBeInTheDocument();
	});

	// A layer is for reading; what the bar reports waits for the list, which
	// the stores keep it for.
	it("has no top bar over a layer", () => {
		const { rerender, ...props } = renderWorkspace(DIFF);
		expect(topBar()).toBeNull();

		for (const layer of [
			TOPIC,
			{ type: "commit", hash: "abc1234" },
			{ type: "commit-diff", hash: "abc1234", path: "a.ts" },
			{ type: "commit-file", hash: "abc1234", path: "a.ts" },
		] as const) {
			rerender(<GitWorkspace layer={layer} {...props} />);
			expect(topBar()).toBeNull();
		}
	});

	// The composer is under a detail, so its bar stands above it — and gives
	// way to the soft keyboard, which leaves no room for three bars.
	it("puts a detail's actions above the composer, and away for the keyboard", () => {
		const layers = [
			[DIFF, "diff"],
			[{ type: "commit-diff", hash: "abc1234", path: "a.ts" }, "commit diff"],
			[{ type: "commit-file", hash: "abc1234", path: "a.ts" }, "commit file"],
		] as const;
		const { rerender, ...props } = renderWorkspace(DIFF);
		for (const [layer, name] of layers) {
			rerender(<GitWorkspace layer={layer} {...props} />);
			expect(screen.getByText(`${name} actions bottom`)).toBeInTheDocument();
			rerender(<GitWorkspace layer={layer} keyboardUp {...props} />);
			expect(screen.getByText(`${name} actions hidden`)).toBeInTheDocument();
		}
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
	});
});

describe("GitWorkspace at expanded", () => {
	beforeEach(() => {
		layout.expanded = true;
	});

	// The bottom is the composer's alone, keyboard or not.
	it("puts a detail's actions at its top", () => {
		renderWorkspace(DIFF, { keyboardUp: true });
		expect(screen.getByText("diff actions top")).toBeInTheDocument();
	});

	// The list is the sidebar's Git tab: the main area is the detail alone,
	// naming itself in the app header, and its way back lands on the list's
	// URL, which is the chat here.
	it("draws a detail alone, its way back leading to the chat", () => {
		renderWorkspace(DIFF);

		expect(screen.getByText("diff page")).toBeVisible();
		expect(screen.queryByText(/changes list/)).toBeNull();
		expect(segmentControl()).toBeNull();
		expect(topBar()).toBeNull();
		expect(screen.queryByRole("heading", { name: "Git" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "diff back to chat" }),
		).toBeInTheDocument();
		// The whole banner, and its actions, are the sidebar's.
		expect(
			screen.getByRole("button", { name: "one-line banner" }),
		).toBeInTheDocument();
	});

	it("goes back from a commit to the History list's URL", async () => {
		const user = userEvent.setup();
		const { onSelectSegment } = renderWorkspace({
			type: "commit",
			hash: "abc1234",
		});

		await user.click(
			screen.getByRole("button", { name: "commit back to chat" }),
		);
		expect(onSelectSegment).toHaveBeenCalledWith("history");
	});

	// The sidebar's list, and its pinned area, are on screen: the failures stay
	// with them.
	it("leaves a branch's failures to the sidebar's list beside it", async () => {
		const user = userEvent.setup();
		const { onSelectSegment } = renderWorkspace(TOPIC, { listBeside: true });

		expect(screen.getByText("branch page")).toBeVisible();
		expect(screen.queryByText("branch page holds failures")).toBeNull();
		await user.click(
			screen.getByRole("button", { name: "branch back to chat" }),
		);
		expect(onSelectSegment).toHaveBeenCalledWith("branches");
	});

	// A sidebar collapsed, or on another tab, shows nothing: a press in the
	// detail would fail in silence.
	it("holds a branch's failures while the sidebar's list is off the screen", () => {
		renderWorkspace(TOPIC);
		expect(screen.getByText("branch page holds failures")).toBeInTheDocument();
	});

	it("goes back from a commit opened from a branch to that branch", async () => {
		const user = userEvent.setup();
		const branch = { ref: "topic", remote: false };
		const { onSelectBranch } = renderWorkspace({
			type: "commit",
			hash: "abc1234",
			branch,
		});

		await user.click(screen.getByRole("button", { name: /commit back/ }));
		expect(onSelectBranch).toHaveBeenCalledWith(branch);
	});

	// Rotating a tablet takes the list away from under the diff; the diff
	// itself — its scroll, its state — must not start over.
	it("keeps the open diff mounted across a resize", () => {
		layout.expanded = false;
		diffMounts.count = 0;
		const { rerender, ...props } = renderWorkspace(DIFF);

		layout.expanded = true;
		rerender(<GitWorkspace layer={DIFF} {...props} />);

		expect(screen.getByText("diff page")).toBeVisible();
		expect(diffMounts.count).toBe(1);
	});
});
