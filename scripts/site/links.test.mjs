import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { servedFile, siteLinks } from "./links.mjs";

test("pockode.com links, bare or in markdown, without query or fragment", () => {
	const text = [
		"[Website](https://pockode.com) · [Docs](https://pockode.com/docs/)",
		"curl -fsSL https://pockode.com/install.sh | sh",
		"<https://pockode.com/changelog/#v0-20-0> and https://pockode.com/security/?x=1.",
	].join("\n");
	assert.deepEqual(siteLinks(text), [
		{ path: "/", line: 1 },
		{ path: "/docs/", line: 1 },
		{ path: "/install.sh", line: 2 },
		{ path: "/changelog/", line: 3 },
		{ path: "/security/", line: 3 },
	]);
});

test("the host in any spelling, with the path a browser would request", () => {
	assert.deepEqual(
		siteLinks(
			"http://www.pockode.com/docs HTTPS://Pockode.com/a/../security/",
		).map((l) => l.path),
		["/docs", "/security/"],
	);
});

test("other hosts are not the site", () => {
	assert.deepEqual(
		siteLinks(
			"https://pockode.com.evil.test/ https://github.com/sijiaoh/pockode",
		),
		[],
	);
});

test("a path is served by its file or its directory's index.html", () => {
	const dir = mkdtempSync(join(tmpdir(), "site-links-"));
	const site = join(dir, "public");
	try {
		mkdirSync(join(site, "docs"), { recursive: true });
		writeFileSync(join(site, "docs/index.html"), "");
		writeFileSync(join(site, "install.sh"), "");
		mkdirSync(join(site, "empty"));

		assert.ok(servedFile(site, "/docs/"));
		assert.ok(servedFile(site, "/docs"));
		assert.ok(servedFile(site, "/install.sh"));
		assert.equal(servedFile(site, "/security/"), null);
		assert.equal(servedFile(site, "/empty/"), null);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("nothing outside the build is served, and a bad escape is no page", () => {
	const dir = mkdtempSync(join(tmpdir(), "site-links-"));
	const site = join(dir, "public");
	try {
		mkdirSync(site);
		writeFileSync(join(dir, "outside"), "");

		assert.equal(servedFile(site, "/%2E%2E/outside"), null);
		assert.equal(servedFile(site, "/%E0"), null);
	} finally {
		rmSync(dir, { recursive: true });
	}
});
