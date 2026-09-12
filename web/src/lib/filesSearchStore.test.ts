import { beforeEach, describe, expect, it, vi } from "vitest";

describe("filesSearchStore", () => {
	beforeEach(() => {
		vi.resetModules();
		localStorage.clear();
	});

	describe("initial state", () => {
		it("respects gitignore when nothing is stored", async () => {
			const { useFilesSearchStore } = await import("./filesSearchStore");

			expect(useFilesSearchStore.getState().respectGitignore).toBe(true);
			expect(useFilesSearchStore.getState().searchContent).toBe(false);
		});

		it("restores stored options", async () => {
			localStorage.setItem("files-search-respect-gitignore", "false");
			localStorage.setItem("files-search-content", "true");

			const { useFilesSearchStore } = await import("./filesSearchStore");

			expect(useFilesSearchStore.getState().respectGitignore).toBe(false);
			expect(useFilesSearchStore.getState().searchContent).toBe(true);
		});
	});

	it("persists toggled options", async () => {
		const { useFilesSearchStore } = await import("./filesSearchStore");

		useFilesSearchStore.getState().toggleRespectGitignore();
		useFilesSearchStore.getState().toggleSearchContent();

		expect(localStorage.getItem("files-search-respect-gitignore")).toBe(
			"false",
		);
		expect(localStorage.getItem("files-search-content")).toBe("true");

		vi.resetModules();
		const reloaded = await import("./filesSearchStore");
		expect(reloaded.useFilesSearchStore.getState().respectGitignore).toBe(
			false,
		);
		expect(reloaded.useFilesSearchStore.getState().searchContent).toBe(true);
	});
});
