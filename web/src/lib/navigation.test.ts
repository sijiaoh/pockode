import { describe, expect, it } from "vitest";
import { buildNavigation, overlayToNavigation } from "./navigation";

describe("buildNavigation", () => {
	describe("session", () => {
		it("builds main worktree session route", () => {
			const result = buildNavigation({
				type: "session",
				worktree: "",
				sessionId: "abc123",
			});

			expect(result).toEqual({
				to: "/s/$sessionId",
				params: { sessionId: "abc123" },
			});
		});

		it("builds named worktree session route", () => {
			const result = buildNavigation({
				type: "session",
				worktree: "feature-x",
				sessionId: "abc123",
			});

			expect(result).toEqual({
				to: "/w/$worktree/s/$sessionId",
				params: { worktree: "feature-x", sessionId: "abc123" },
			});
		});

		it("names the worktree a session is read out of", () => {
			const result = buildNavigation({
				type: "session",
				worktree: "feature-x",
				sessionId: "abc123",
				viewWorktree: "old-fix",
			});

			// The path still names where the user is standing — Files and Git stay
			// with it — and only the query says where the transcript comes from.
			expect(result).toEqual({
				to: "/w/$worktree/s/$sessionId",
				params: { worktree: "feature-x", sessionId: "abc123" },
				search: { from: "old-fix" },
			});
		});

		it("keeps the empty source worktree, which names main", () => {
			const result = buildNavigation({
				type: "session",
				worktree: "feature-x",
				sessionId: "abc123",
				viewWorktree: "",
			});

			expect(result.search).toEqual({ from: "" });
		});
	});

	describe("overlay", () => {
		it("builds main worktree staged diff route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "staged",
				path: "src/index.ts",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/staged/$",
				params: { _splat: "src/index.ts" },
			});
		});

		it("builds named worktree unstaged diff route with session", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "feature-x",
				overlayType: "unstaged",
				path: "src/app.ts",
				sessionId: "sess123",
			});

			expect(result).toEqual({
				to: "/w/$worktree/unstaged/$",
				params: { worktree: "feature-x", _splat: "src/app.ts" },
				search: { session: "sess123" },
			});
		});

		it("builds file view route without session", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "file",
				path: "README.md",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/files/$",
				params: { _splat: "README.md" },
			});
		});

		it("builds file edit route with mode=edit", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "file",
				path: "src/main.ts",
				sessionId: null,
				edit: true,
			});

			expect(result).toEqual({
				to: "/files/$",
				params: { _splat: "src/main.ts" },
				search: { mode: "edit" },
			});
		});

		it("builds file edit route with session and edit", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "feature-x",
				overlayType: "file",
				path: "app.ts",
				sessionId: "sess123",
				edit: true,
			});

			expect(result).toEqual({
				to: "/w/$worktree/files/$",
				params: { worktree: "feature-x", _splat: "app.ts" },
				search: { session: "sess123", mode: "edit" },
			});
		});

		it("builds main worktree commit route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "commit",
				hash: "abc1234",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/commit/$",
				params: { _splat: "abc1234" },
			});
		});

		it("builds main worktree commit-diff route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "commit-diff",
				path: "src/index.ts",
				hash: "abc1234",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/commit/$hash/diff/$",
				params: { hash: "abc1234", _splat: "src/index.ts" },
			});
		});

		it("builds named worktree commit-diff route with session", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "feature-x",
				overlayType: "commit-diff",
				path: "src/app.ts",
				hash: "def5678",
				sessionId: "sess123",
			});

			expect(result).toEqual({
				to: "/w/$worktree/commit/$hash/diff/$",
				params: {
					worktree: "feature-x",
					hash: "def5678",
					_splat: "src/app.ts",
				},
				search: { session: "sess123" },
			});
		});

		it("builds main worktree commit-file route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "commit-file",
				path: "src/index.ts",
				hash: "abc1234",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/commit/$hash/file/$",
				params: { hash: "abc1234", _splat: "src/index.ts" },
			});
		});

		it("builds named worktree commit-file route with session", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "feature-x",
				overlayType: "commit-file",
				path: "src/app.ts",
				hash: "def5678",
				sessionId: "sess123",
			});

			expect(result).toEqual({
				to: "/w/$worktree/commit/$hash/file/$",
				params: {
					worktree: "feature-x",
					hash: "def5678",
					_splat: "src/app.ts",
				},
				search: { session: "sess123" },
			});
		});

		it("builds main worktree settings route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "settings",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/settings",
			});
		});

		it("builds named worktree settings route with session", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "feature-x",
				overlayType: "settings",
				sessionId: "sess123",
			});

			expect(result).toEqual({
				to: "/w/$worktree/settings",
				params: { worktree: "feature-x" },
				search: { session: "sess123" },
			});
		});
	});

	describe("home", () => {
		it("builds main worktree home route", () => {
			const result = buildNavigation({
				type: "home",
				worktree: "",
			});

			expect(result).toEqual({ to: "/" });
		});

		it("builds named worktree home route", () => {
			const result = buildNavigation({
				type: "home",
				worktree: "feature-x",
			});

			expect(result).toEqual({
				to: "/w/$worktree/",
				params: { worktree: "feature-x" },
			});
		});
	});

	describe("replace option", () => {
		it("adds replace: true when specified", () => {
			const result = buildNavigation(
				{ type: "home", worktree: "" },
				{ replace: true },
			);

			expect(result).toEqual({ to: "/", replace: true });
		});

		it("does not add replace when not specified", () => {
			const result = buildNavigation({ type: "home", worktree: "" });

			expect(result.replace).toBeUndefined();
		});
	});
});

describe("overlayToNavigation", () => {
	it("routes a commit-file overlay to its own path, not the commit splat", () => {
		const result = overlayToNavigation(
			{ type: "commit-file", hash: "abc1234", path: "src/app.ts" },
			"",
			null,
		);

		expect(result).toEqual({
			to: "/commit/$hash/file/$",
			params: { hash: "abc1234", _splat: "src/app.ts" },
		});
	});

	it("keeps worktree and session on a commit-file overlay", () => {
		const result = overlayToNavigation(
			{ type: "commit-file", hash: "def5678", path: "docs/a.md" },
			"feature-x",
			"sess123",
		);

		expect(result).toEqual({
			to: "/w/$worktree/commit/$hash/file/$",
			params: {
				worktree: "feature-x",
				hash: "def5678",
				_splat: "docs/a.md",
			},
			search: { session: "sess123" },
		});
	});
});

// docs/project-ui.md §5. `Current` is the absence of the parameter, so that one
// state has one URL and the Project button's plain `/works` means `Current`.
describe("the work list segment in the URL", () => {
	it("writes nothing for Current and the word for Closed", () => {
		expect(
			overlayToNavigation({ type: "work-list", segment: "current" }, "", null),
		).toEqual({ to: "/works" });

		expect(
			overlayToNavigation({ type: "work-list", segment: "closed" }, "", null),
		).toEqual({ to: "/works", search: { segment: "closed" } });
	});

	it("carries the segment into a work detail, beside the session", () => {
		expect(
			overlayToNavigation(
				{ type: "work-detail", workId: "w1", segment: "closed" },
				"feature-x",
				"sess123",
			),
		).toEqual({
			to: "/w/$worktree/works/$workId",
			params: { workId: "w1", worktree: "feature-x" },
			search: { session: "sess123", segment: "closed" },
		});
	});
});
