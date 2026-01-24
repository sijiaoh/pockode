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
			});

			expect(result).toEqual({
				to: "/files/$",
				params: { _splat: "README.md" },
			});
		});

		it("builds main worktree settings route", () => {
			const result = buildNavigation({
				type: "overlay",
				worktree: "",
				overlayType: "settings",
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
