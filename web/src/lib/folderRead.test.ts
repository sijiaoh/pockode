import { describe, expect, it } from "vitest";
import { folderEntry as dir } from "../test/folderEntry";
import {
	FolderReadError,
	folderFromPicked,
	MAX_FOLDER_FILES,
	readFolderEntry,
} from "./folderRead";

function file(name: string): File {
	return new File(["x"], name);
}

function paths(names: string[], prefix = ""): { [name: string]: File } {
	return Object.fromEntries(names.map((n) => [n, file(`${prefix}${n}`)]));
}

describe("readFolderEntry", () => {
	it("keeps every file's path inside the folder, and its empty directories", async () => {
		const contents = await readFolderEntry(
			dir("assets", {
				"logo.png": file("logo.png"),
				img: { "a.png": file("a.png"), deep: { "b.png": file("b.png") } },
				empty: {},
			}),
		);

		expect(contents.files.map(({ path }) => path)).toEqual([
			"logo.png",
			"img/a.png",
			"img/deep/b.png",
		]);
		// A directory with files needs no entry of its own; an empty one would
		// otherwise not arrive at all.
		expect(contents.dirs).toEqual(["empty"]);
	});

	it("reads past the first batch of a large directory", async () => {
		const names = Array.from({ length: 250 }, (_, i) => `f${i}.txt`);
		const contents = await readFolderEntry(dir("big", paths(names)));

		expect(contents.files).toHaveLength(250);
	});

	it("fails the whole folder on a file it cannot read, naming it", async () => {
		const reading = readFolderEntry(
			dir("assets", {
				"ok.txt": file("ok.txt"),
				secret: { "key.pem": new Error("NotReadableError") },
			}),
		);

		await expect(reading).rejects.toThrow(FolderReadError);
		await expect(reading).rejects.toThrow(
			"Couldn't read assets/secret/key.pem",
		);
	});

	it("stops at more files than one upload takes, rather than reading them all", async () => {
		const names = Array.from(
			{ length: MAX_FOLDER_FILES + 5 },
			(_, i) => `f${i}`,
		);
		await expect(
			readFolderEntry(dir("node_modules", paths(names))),
		).rejects.toThrow("node_modules has more than 1,000 files");
	});

	it("gives up once its signal fires", async () => {
		const controller = new AbortController();
		const reading = readFolderEntry(
			dir("assets", { a: { "b.txt": file("b.txt") } }),
			{ signal: controller.signal },
		);
		controller.abort();

		await expect(reading).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("folderFromPicked", () => {
	function picked(relativePath: string): File {
		const f = file(relativePath.split("/").pop() ?? "");
		Object.defineProperty(f, "webkitRelativePath", { value: relativePath });
		return f;
	}

	it("names the folder after the first segment and keeps the rest as the path", () => {
		expect(
			folderFromPicked([picked("assets/a.png"), picked("assets/img/b.png")]),
		).toMatchObject({
			name: "assets",
			contents: {
				files: [{ path: "a.png" }, { path: "img/b.png" }],
				dirs: [],
			},
		});
	});

	it("is no folder when the browser opened a plain file picker after all", () => {
		expect(folderFromPicked([picked("")])).toBeNull();
	});
});
