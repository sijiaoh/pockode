import { describe, expect, it } from "vitest";
import { TYPE_CHANGE_DIFF } from "../test/gitFixtures";
import { asOneFileDiff, drawablePatch, symlinkChange } from "./drawablePatch";

describe("drawablePatch", () => {
	it("passes one file's patch with a hunk", () => {
		const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
		expect(drawablePatch(patch)).toBe(patch);
	});

	it("refuses a file header with no hunk", () => {
		expect(drawablePatch("--- a/a.txt\n+++ b/a.txt\n")).toBeNull();
	});

	it("refuses more than one file's sections", () => {
		expect(drawablePatch(TYPE_CHANGE_DIFF.diff)).toBeNull();
	});
});

describe("asOneFileDiff", () => {
	it("turns a type change's two sections into one file's patch", () => {
		if (TYPE_CHANGE_DIFF.omitted) throw new Error("not a diff");
		const data = asOneFileDiff(
			{ ...TYPE_CHANGE_DIFF, hunk_ids: ["h1", "h2"] },
			"a.txt",
		);
		if (data.omitted) throw new Error("not a diff");

		expect(drawablePatch(data.diff)).toBe(data.diff);
		// What says it is a type change at all, as git says a mode change.
		expect(data.diff).toMatch(/^old mode 100644\nnew mode 120000$/m);
		expect(data.diff).toMatch(/^-content$/m);
		expect(data.diff).toMatch(/^\+real\.txt$/m);
		expect(data.old_content).toBe(TYPE_CHANGE_DIFF.old_content);
		expect(data.new_content).toBe(TYPE_CHANGE_DIFF.new_content);
		// They named the server's two hunks, which are not the one drawn now.
		expect(data.hunk_ids).toBeUndefined();
	});

	it("leaves one file's diff as it is", () => {
		const data = {
			diff: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\n",
			old_content: "a\n",
			new_content: "b\n",
			hunk_ids: ["h1"],
		};
		expect(asOneFileDiff(data, "a")).toBe(data);
	});

	it("leaves a type change with a binary side to be said as binary", () => {
		const data = {
			diff: [
				"diff --git a/a.png b/a.png",
				"deleted file mode 100644",
				"Binary files a/a.png and /dev/null differ",
				"diff --git a/a.png b/a.png",
				"new file mode 120000",
				"--- /dev/null",
				"+++ b/a.png",
				"@@ -0,0 +1 @@",
				"+real.png",
				"",
			].join("\n"),
			old_content: "\u0089PNG\u0000",
			new_content: "real.png",
		};
		expect(asOneFileDiff(data, "a.png")).toBe(data);
	});
});

describe("symlinkChange", () => {
	it("reads a file that became a link, in git's form and rebuilt", () => {
		const change = { kind: "typechange", from: "file", to: "symlink" };
		expect(symlinkChange(TYPE_CHANGE_DIFF.diff)).toEqual(change);
		expect(
			symlinkChange(asOneFileDiff(TYPE_CHANGE_DIFF, "a.txt").diff),
		).toEqual(change);
	});

	it("reads a link that became a file", () => {
		const patch =
			"diff --git a/b b/b\nold mode 120000\nnew mode 100644\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-real.txt\n+plain\n";
		expect(symlinkChange(patch)).toEqual({
			kind: "typechange",
			from: "symlink",
			to: "file",
		});
	});

	it("marks a link added, retargeted or deleted", () => {
		const added =
			"diff --git a/l b/l\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+real.txt\n";
		const retargeted =
			"diff --git a/l b/l\nindex 1111111..2222222 120000\n--- a/l\n+++ b/l\n@@ -1 +1 @@\n-a\n+b\n";
		for (const patch of [added, retargeted]) {
			expect(symlinkChange(patch)).toEqual({ kind: "symlink" });
		}
	});

	it("says nothing for a file, or a mode line inside the content", () => {
		const exec = "diff --git a/s b/s\nold mode 100644\nnew mode 100755\n";
		const content =
			"diff --git a/n b/n\nindex 1111111..2222222 100644\n--- a/n\n+++ b/n\n@@ -1 +1 @@\n-new file mode 120000\n+x\n";
		expect(symlinkChange(exec)).toBeNull();
		expect(symlinkChange(content)).toBeNull();
	});
});
