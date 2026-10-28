import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitShowResult } from "../../types/git";
import type { OverlayState } from "../../types/overlay";
import type { CommitMenuTarget } from "./CommitActions";
import CommitView from "./CommitView";

interface CommitQuery {
	data?: GitShowResult;
	isLoading: boolean;
	error: Error | null;
}

let commitQuery: CommitQuery;
/** What `git.show` answers for the commit's parents, by hash. */
let parentQueries: Record<string, CommitQuery>;
const navigate = vi.fn();
let routeOverlay: OverlayState = null;

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({
		worktree: "",
		sessionId: null,
		overlay: routeOverlay,
	}),
}));

vi.mock("../../hooks/useGitCommit", () => ({
	useGitCommit: () => commitQuery,
	useGitCommitSubject: (hash: string) => ({
		data: parentQueries[hash]?.data?.subject,
		error: parentQueries[hash]?.error ?? null,
	}),
}));

// The menu is CommitActions' to test; here only that the page opens it.
vi.mock("./CommitActions", () => ({
	default: ({ target }: { target: CommitMenuTarget | null }) =>
		target && (
			<div role="dialog">
				{`Menu for ${target.commit.subject}, in HEAD's history: ${String(target.inHeadHistory)}`}
			</div>
		),
}));

function loading(): CommitQuery {
	return { data: undefined, isLoading: true, error: null };
}

function loaded(extra: Partial<GitShowResult> = {}): CommitQuery {
	return {
		data: {
			hash: "abc1234def",
			parents: ["1111111aaa"],
			subject: "Fix the header",
			author: "a",
			date: "2026-10-27T14:02:00Z",
			files: [],
			...extra,
		},
		isLoading: false,
		error: null,
	};
}

beforeEach(() => {
	commitQuery = loading();
	parentQueries = {};
	navigate.mockReset();
	routeOverlay = null;
});

function heading() {
	return screen.getByRole("heading", { level: 1 });
}

describe("CommitView", () => {
	// The hash comes with the route; the subject has to be fetched, and the
	// hash does not stand in for it meanwhile.
	it("shows the hash at once and the subject as loading", () => {
		render(<CommitView hash="abc1234def" onBack={vi.fn()} />);

		expect(heading()).toHaveAttribute("aria-busy", "true");
		expect(heading()).toHaveTextContent(/^Loading, abc1234$/);
	});

	it("names the commit by its subject, with the short hash under it", () => {
		commitQuery = loaded();
		render(<CommitView hash="abc1234def" onBack={vi.fn()} />);

		expect(heading()).toHaveTextContent(/^Fix the header, abc1234$/);
		expect(heading().querySelector("[title]")).toHaveAttribute(
			"title",
			"Fix the header — abc1234def",
		);
	});

	// No subject is coming, but the hash is still true.
	it("falls back to the hash when the commit cannot be read", () => {
		commitQuery = {
			data: undefined,
			isLoading: false,
			error: new Error("bad object"),
		};
		render(<CommitView hash="abc1234def" onBack={vi.fn()} />);

		expect(heading()).not.toHaveAttribute("aria-busy");
		expect(heading()).toHaveTextContent(/^abc1234$/);
	});

	it("lists every ref and the full hash, which it copies", () => {
		commitQuery = loaded({
			refs: [
				{ name: "HEAD", type: "head" },
				{ name: "main", type: "branch", current: true },
				{ name: "topic-a", type: "branch" },
				{ name: "topic-b", type: "branch" },
				{ name: "v1.2", type: "tag" },
			],
		});
		render(<CommitView hash="abc1234def" />);

		// No `+N` here: the page has room to say them all.
		for (const name of ["main", "topic-a", "topic-b", "v1.2"]) {
			expect(screen.getByText(name)).toBeInTheDocument();
		}
		expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
		// What the icons and the outline say, in words.
		expect(screen.getByText("Current branch")).toHaveClass("sr-only");
		expect(screen.getByText("Tag")).toHaveClass("sr-only");
		expect(screen.getByText("abc1234def")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Copy hash" }),
		).toBeInTheDocument();
	});

	it("opens a parent, carrying the history query along", async () => {
		const user = userEvent.setup();
		routeOverlay = {
			type: "commit",
			hash: "abc1234def",
			history: { scope: "all", q: "fix" },
		};
		commitQuery = loaded();
		parentQueries["1111111aaa"] = loaded({
			hash: "1111111aaa",
			subject: "The parent",
		});
		render(<CommitView hash="abc1234def" />);

		await user.click(screen.getByRole("button", { name: /The parent/ }));

		// Pushed: Back returns to this commit.
		expect(navigate).toHaveBeenCalledWith({
			to: "/commit/$",
			params: { _splat: "1111111aaa" },
			search: { scope: "all", q: "fix" },
		});
	});

	// docs/git-branches-ui.md#opening-a-commit: stacked on a branch, the
	// page leads back to it and carries it to everything opened from here.
	it("leads back to the branch it was opened from, and carries it on", async () => {
		const user = userEvent.setup();
		const onBack = vi.fn();
		routeOverlay = {
			type: "commit",
			hash: "abc1234def",
			branch: { ref: "origin/topic", remote: true },
		};
		commitQuery = loaded({
			files: [{ path: "src/a.ts", status: "M" }],
		});
		parentQueries["1111111aaa"] = loaded({
			hash: "1111111aaa",
			subject: "The parent",
		});
		render(<CommitView hash="abc1234def" onBack={onBack} />);

		await user.click(screen.getByRole("button", { name: "Back to branch" }));
		expect(onBack).toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: /The parent/ }));
		expect(navigate).toHaveBeenLastCalledWith({
			to: "/commit/$",
			params: { _splat: "1111111aaa" },
			search: { branch: "origin/topic", remote: 1 },
		});

		await user.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
		expect(navigate).toHaveBeenLastCalledWith({
			to: "/commit/$hash/diff/$",
			params: { hash: "abc1234def", _splat: "src/a.ts" },
			search: { branch: "origin/topic", remote: 1 },
		});
	});

	it("numbers a merge's parents, and says its files are against the first", () => {
		commitQuery = loaded({
			parents: ["1111111aaa", "2222222bbb"],
			files: [{ path: "a.ts", status: "M" }],
		});
		parentQueries["1111111aaa"] = loaded({
			hash: "1111111aaa",
			subject: "Main's line",
		});
		render(<CommitView hash="abc1234def" />);

		expect(
			screen.getByRole("button", { name: "First parent: 1111111 Main's line" }),
		).toBeInTheDocument();
		// Its subject is still on the way: the hash alone names it meanwhile.
		expect(
			screen.getByRole("button", { name: "Merged-in parent 2: 2222222" }),
		).toBeInTheDocument();
		expect(screen.getByText(/Changed files \(1\)/)).toHaveTextContent(
			"vs parent 1",
		);
	});

	it("does not number a single parent, nor compare its files", () => {
		commitQuery = loaded({ files: [{ path: "a.ts", status: "M" }] });
		render(<CommitView hash="abc1234def" />);

		expect(screen.queryByText(/vs parent/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /First parent/ }),
		).not.toBeInTheDocument();
	});

	it("says a root commit has no parents", () => {
		commitQuery = loaded({ parents: [] });
		render(<CommitView hash="abc1234def" />);

		expect(
			screen.getByText("No parents — this is the first commit."),
		).toBeInTheDocument();
	});

	// From a link nothing tells whether HEAD reaches it, so the menu is not
	// told it does not.
	it("opens the commit's menu from the bottom bar", async () => {
		const user = userEvent.setup();
		commitQuery = loaded();
		render(<CommitView hash="abc1234def" />);

		await user.click(
			screen.getByRole("button", { name: "Actions for commit abc1234" }),
		);

		expect(
			within(screen.getByRole("dialog")).getByText(/Fix the header/),
		).toHaveTextContent("in HEAD's history: undefined");
	});
});
