// Writes the third-party notices for the npm packages in the frontend bundles
// the release ships: web (server/static) and web-cluster (server/cluster/static).
//
//   node scripts/notices/frontend.mjs [--out FILE]
//
// Without --out the notices go to stdout. Each frontend is built once more, in
// production mode with its own vite.config.ts and its own lockfile-pinned Vite,
// into a scratch directory that is thrown away: only the module graph is read.
// Exits 1 without writing anything if any shipped package's license or license
// text cannot be determined, naming every such package.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	bundledPackage,
	findPackage,
	readPackage,
	render,
	shippedPackages,
} from "./npm.mjs";
import { CONTENT_FROM, MANUAL } from "./npm-manual.mjs";

const ROOT = join(import.meta.dirname, "../..");
const FRONTENDS = ["web", "web-cluster"];

const { values } = parseArgs({ options: { out: { type: "string" } } });

const roots = new Set();
const bundled = new Map();
const problems = [];
for (const name of FRONTENDS) {
	const viteRoot = join(ROOT, name);
	const vite = createRequire(join(viteRoot, "package.json")).resolve("vite");
	const { build } = await import(pathToFileURL(vite).href);
	const collector = shippedPackages(viteRoot);
	const outDir = mkdtempSync(join(tmpdir(), `pockode-notices-${name}-`));
	try {
		await build({
			root: viteRoot,
			mode: "production",
			// Warnings and errors only, on stderr: stdout may be the notices.
			logLevel: "warn",
			// Not the release outDir: the compression plugin rewrites whatever is
			// in there. write: false leaves this one empty for it.
			build: { outDir, emptyOutDir: false, write: false },
			plugins: [collector.plugin],
		});
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
	for (const root of collector.roots) roots.add(root);
	for (const [id, b] of collector.bundled) bundled.set(id, b);
	problems.push(...collector.problems.map((p) => `${name}: ${p}`));
}

const packages = new Map();
const shipped = new Set();
const shippedNames = new Set();
const record = (pkg) => {
	shipped.add(pkg.id);
	if (pkg.problem) problems.push(pkg.problem);
	else packages.set(pkg.id, pkg);
};
for (const root of roots) {
	const pkg = readPackage(root, MANUAL);
	record(pkg);
	shippedNames.add(pkg.name ?? pkg.id.replace(/(.)@.*/, "$1"));
}
for (const b of bundled.values()) record(bundledPackage(b, MANUAL));
for (const [name, from] of Object.entries(CONTENT_FROM)) {
	if (!shippedNames.has(name)) {
		problems.push(
			`${name}: no longer shipped; drop its CONTENT_FROM entry from scripts/notices/npm-manual.mjs`,
		);
		continue;
	}
	const root = findPackage(ROOT, from);
	if (root) record(readPackage(root, MANUAL));
	else
		problems.push(
			`${from}: the source of what ${name} ships is not installed; add it to the root package.json's devDependencies`,
		);
}
for (const id of Object.keys(MANUAL)) {
	if (!shipped.has(id)) {
		problems.push(
			`${id}: no longer shipped; drop its entry from scripts/notices/npm-manual.mjs`,
		);
	}
}

if (problems.length > 0) {
	console.error("Cannot write the frontend third-party notices:");
	for (const problem of problems.sort()) console.error(`  - ${problem}`);
	process.exit(1);
}

const text = render(packages.values());
if (values.out) writeFileSync(values.out, text);
else process.stdout.write(text);
console.error(`Frontend third-party notices: ${packages.size} packages.`);
