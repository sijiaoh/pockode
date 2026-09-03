import { DiffFile } from "@git-diff-view/react";
import { describe, expect, it } from "vitest";
import { parseCodexChanges } from "./codexChanges";

// Captured from codex-cli 0.153.0 `patch_apply_begin` events. Paths arrive
// absolute, and the key order is neither the prompt order nor sorted.
const MIXED = {
	"/tmp/w/keep.txt": {
		type: "update",
		unified_diff: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
		move_path: "/tmp/w/renamed.txt",
	},
	"/tmp/w/added.txt": { type: "add", content: "hello\nworld\n" },
	"/tmp/w/doomed.txt": { type: "delete", content: "bye\n" },
};

const EMPTY_ADD = {
	"/tmp/w/empty.txt": { type: "add", content: "" },
};

const PURE_RENAME = {
	"/tmp/w/pure.txt": {
		type: "update",
		unified_diff: "",
		move_path: "/tmp/w/pure_renamed.txt",
	},
};

const PLAIN_UPDATE = {
	"/tmp/w/m.txt": {
		type: "update",
		unified_diff: "@@ -1 +1 @@\n-a\n+b\n",
		move_path: null,
	},
};

// A future codex variant we do not know about, next to one we do.
const UNKNOWN_TYPE = {
	"/tmp/w/mystery.txt": { type: "chmod" },
	"/tmp/w/added.txt": { type: "add", content: "hello\n" },
};

// Content whose own lines start with "@@": the hunk-header check must read
// these as content, since a patch prefixes every content line.
const AT_AT_CONTENT = {
	"/tmp/w/at.txt": {
		type: "add",
		content: "@@ not a header\n@@ -9,9 +9,9 @@\n",
	},
};

const ALL_FIXTURES = {
	MIXED,
	EMPTY_ADD,
	PURE_RENAME,
	PLAIN_UPDATE,
	UNKNOWN_TYPE,
	AT_AT_CONTENT,
};

describe("parseCodexChanges", () => {
	it("maps the three variants to statuses, sorted by path", () => {
		const changes = parseCodexChanges({ changes: MIXED });

		expect(changes?.map((c) => [c.path, c.status])).toEqual([
			["/tmp/w/added.txt", "A"],
			["/tmp/w/doomed.txt", "D"],
			["/tmp/w/keep.txt", "R"],
		]);
		expect(changes?.[2].newPath).toBe("/tmp/w/renamed.txt");
	});

	it("renders add as an all-plus patch and delete as an all-minus one", () => {
		const changes = parseCodexChanges({ changes: MIXED });
		const byPath = new Map(changes?.map((c) => [c.path, c.patch]));

		expect(byPath.get("/tmp/w/added.txt")).toContain("@@ -0,0 +1,2 @@");
		expect(byPath.get("/tmp/w/added.txt")).toContain("+hello");
		expect(byPath.get("/tmp/w/doomed.txt")).toContain("-bye");
	});

	it("marks an update without move_path as modified", () => {
		const changes = parseCodexChanges({ changes: PLAIN_UPDATE });

		expect(changes?.[0].status).toBe("M");
		expect(changes?.[0].newPath).toBe("/tmp/w/m.txt");
	});

	it("gives a rename a patch header spanning the old and new path", () => {
		const rename = parseCodexChanges({ changes: MIXED })?.[2];

		expect(rename?.patch).toContain("--- a//tmp/w/keep.txt\n");
		expect(rename?.patch).toContain("+++ b//tmp/w/renamed.txt\n");
	});

	it("drops the hunkless patch of an empty add", () => {
		const changes = parseCodexChanges({ changes: EMPTY_ADD });

		expect(changes?.[0].patch).toBeNull();
		expect(changes?.[0].note).toBeTruthy();
	});

	it("drops the hunkless patch of a pure rename", () => {
		const changes = parseCodexChanges({ changes: PURE_RENAME });

		expect(changes?.[0].status).toBe("R");
		expect(changes?.[0].patch).toBeNull();
		expect(changes?.[0].note).toBeTruthy();
	});

	it("degrades only the file whose change type is unknown", () => {
		const changes = parseCodexChanges({ changes: UNKNOWN_TYPE });

		const mystery = changes?.find((c) => c.path === "/tmp/w/mystery.txt");
		expect(mystery?.status).toBe("?");
		expect(mystery?.patch).toBeNull();
		expect(mystery?.note).toContain("chmod");
		// The sibling still renders.
		expect(
			changes?.find((c) => c.path === "/tmp/w/added.txt")?.patch,
		).toContain("+hello");
	});

	// The guard against the whole-app blank screen. Asserted against the real
	// parser rather than a hunk-header regex: a patch @git-diff-view cannot read
	// throws inside DiffView's async commit, and web/ installs no error boundary,
	// so it unmounts the entire tree. This is the contract that has to hold, not
	// whichever heuristic withHunks happens to use.
	it("never emits a patch the diff viewer cannot parse", () => {
		for (const fixture of Object.values(ALL_FIXTURES)) {
			for (const change of parseCodexChanges({ changes: fixture }) ?? []) {
				if (change.patch === null) continue;
				// Exactly what DiffViewer hands to DiffView.
				const file = DiffFile.createInstance({
					oldFile: { fileName: change.newPath },
					newFile: { fileName: change.newPath },
					hunks: [change.patch],
				});
				file.init();
				file.buildUnifiedDiffLines();
				expect(file.unifiedLineLength).toBeGreaterThan(0);
			}
		}
	});

	it("rejects inputs that are not a codex changes payload", () => {
		expect(parseCodexChanges({ file_path: "/tmp/w/a.txt" })).toBeNull();
		expect(parseCodexChanges({ changes: {} })).toBeNull();
		expect(parseCodexChanges({ changes: { "/tmp/w/a.txt": {} } })).toBeNull();
		expect(parseCodexChanges(null)).toBeNull();
	});
});
