import { describe, expect, it } from "vitest";
import { buildNavigation } from "./navigation";

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

		it("builds main worktree settings route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "settings",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/settings",
				params: {},
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

			expect(result).toEqual({ to: "/", params: {} });
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

			expect(result).toEqual({ to: "/", replace: true, params: {} });
		});

		it("does not add replace when not specified", () => {
			const result = buildNavigation({ type: "home", worktree: "" });

			expect(result.replace).toBeUndefined();
		});
	});

	describe("workspace routes", () => {
		it("builds workspace-only session route", () => {
			const result = buildNavigation({
				type: "session",
				worktree: "",
				workspace: "ws-123",
				sessionId: "abc123",
			});

			expect(result).toEqual({
				to: "/w/$workspace/s/$sessionId",
				params: { workspace: "ws-123", sessionId: "abc123" },
			});
		});

		it("builds workspace + worktree session route", () => {
			const result = buildNavigation({
				type: "session",
				worktree: "feature-x",
				workspace: "ws-123",
				sessionId: "abc123",
			});

			expect(result).toEqual({
				to: "/w/$workspace/w/$worktree/s/$sessionId",
				params: {
					workspace: "ws-123",
					worktree: "feature-x",
					sessionId: "abc123",
				},
			});
		});

		it("builds workspace home route", () => {
			const result = buildNavigation({
				type: "home",
				worktree: "",
				workspace: "ws-123",
			});

			expect(result).toEqual({
				to: "/w/$workspace/",
				params: { workspace: "ws-123" },
			});
		});

		it("builds workspace + worktree home route", () => {
			const result = buildNavigation({
				type: "home",
				worktree: "feature-x",
				workspace: "ws-123",
			});

			expect(result).toEqual({
				to: "/w/$workspace/w/$worktree/",
				params: { workspace: "ws-123", worktree: "feature-x" },
			});
		});

		it("builds workspace settings route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				workspace: "ws-123",
				overlayType: "settings",
				sessionId: null,
			});

			expect(result).toEqual({
				to: "/w/$workspace/settings",
				params: { workspace: "ws-123" },
			});
		});

		it("builds workspace-select route", () => {
			const result = buildNavigation({
				type: "workspace-select",
			});

			expect(result).toEqual({
				to: "/",
			});
		});
	});
});
