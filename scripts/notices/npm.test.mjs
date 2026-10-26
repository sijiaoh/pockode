import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
	bundledIn,
	bundledPackage,
	installedPackage,
	packageRootOf,
	readPackage,
	render,
	shippedPackages,
} from "./npm.mjs";

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "notices-test-")));
after(() => rmSync(TMP, { recursive: true, force: true }));

const write = (file, content) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
};

let count = 0;
/** A package directory under a fresh node_modules, with the given files. */
function fixture(manifest, files = {}) {
	const root = join(TMP, `p${count++}`, "node_modules", manifest.name);
	write(join(root, "package.json"), JSON.stringify(manifest));
	for (const [name, content] of Object.entries(files))
		write(join(root, name), content);
	return root;
}

test("a file belongs to the innermost package, scoped or not; our own code to none", () => {
	assert.equal(
		packageRootOf("/r/node_modules/a/dist/x.js"),
		"/r/node_modules/a",
	);
	assert.equal(
		packageRootOf("/r/node_modules/@s/a/x.js"),
		"/r/node_modules/@s/a",
	);
	assert.equal(
		packageRootOf("/r/node_modules/.pnpm/a@1/node_modules/b/x.js"),
		"/r/node_modules/.pnpm/a@1/node_modules/b",
	);
	assert.equal(packageRootOf("/r/web/src/main.tsx"), null);
});

test("a package's notice is its declared license and every license file", () => {
	const root = fixture(
		{ name: "a", version: "1.0.0", license: "Apache-2.0" },
		{
			LICENSE: "Apache text\r\n",
			"LICENSE.md": "Apache text",
			NOTICE: "Copyright A\n",
			"README.md": "no",
			"license-update.mjs": "code",
			"LICENSES/MIT.txt": "a directory",
		},
	);
	assert.deepEqual(readPackage(root, {}), {
		id: "a@1.0.0",
		name: "a",
		version: "1.0.0",
		license: "Apache-2.0",
		files: [
			{ name: "LICENSE", text: "Apache text" },
			{ name: "NOTICE", text: "Copyright A" },
		],
	});
	const legacy = fixture(
		{
			name: "b",
			version: "1.0.0",
			licenses: [{ type: "MIT" }, { type: "GPL-2.0" }],
		},
		{ "license.md": "MIT text" },
	);
	assert.equal(readPackage(legacy, {}).license, "MIT OR GPL-2.0");
});

test("a package without a declared license or a license file is a problem", () => {
	const unlicensed = fixture(
		{ name: "a", version: "1.0.0" },
		{ LICENSE: "text" },
	);
	assert.match(
		readPackage(unlicensed, {}).problem,
		/^a@1\.0\.0 .*declares no license/,
	);
	const textless = fixture({ name: "b", version: "2.0.0", license: "MIT" });
	assert.match(
		readPackage(textless, {}).problem,
		/^b@2\.0\.0 .*no LICENSE.*MIT text/,
	);
});

test("a manual entry fills in what the package lacks, and only that", () => {
	const root = fixture({ name: "a", version: "1.0.0" });
	const manual = {
		"a@1.0.0": { license: "MIT", text: "MIT text", source: "s" },
	};
	assert.deepEqual(readPackage(root, manual).files, [
		{
			name: "License text, not published in the package (from s)",
			text: "MIT text",
		},
	]);
	assert.match(
		readPackage(root, { "a@1.0.1": manual["a@1.0.0"] }).problem,
		/declares no license/,
	);

	const fixed = fixture(
		{ name: "b", version: "1.0.0", license: "MIT" },
		{ LICENSE: "MIT text" },
	);
	assert.match(
		readPackage(fixed, { "b@1.0.0": { license: "MIT" } }).problem,
		/own license in package\.json/,
	);
	assert.match(
		readPackage(fixed, { "b@1.0.0": { text: "x" } }).problem,
		/own license file/,
	);
});

test("the notices are sorted by name, then version", () => {
	const pkg = (name, version) => ({
		name,
		version,
		license: "MIT",
		files: [{ name: "LICENSE", text: "t" }],
	});
	const text = render([
		pkg("b", "1.0.0"),
		pkg("a", "2.0.0"),
		pkg("a", "1.0.0"),
	]);
	assert.deepEqual(text.match(/^[ab] .*$/gm), [
		"a 1.0.0",
		"a 2.0.0",
		"b 1.0.0",
	]);
});

/** Runs the collector over a fake bundle, as Rollup would at generateBundle. */
function collect(viteRoot, bundle, watchFiles = []) {
	const collector = shippedPackages(viteRoot);
	collector.plugin.generateBundle.call(
		{ getWatchFiles: () => watchFiles },
		{},
		bundle,
	);
	return {
		roots: [...collector.roots].sort(),
		problems: collector.problems,
		bundled: [...collector.bundled.keys()].sort(),
	};
}

const chunk = (modules) => ({
	type: "chunk",
	fileName: "assets/index.js",
	modules: Object.fromEntries(
		Object.entries(modules).map(([id, n]) => [id, { renderedLength: n }]),
	),
});

test("only packages with code left in a chunk ship, plus Vite for its helpers", () => {
	const app = join(TMP, "app");
	const nm = join(app, "node_modules");
	const vite = dirname(write(join(nm, "vite/package.json"), "{}"));
	const kept = write(join(nm, "kept/index.js"), "");
	const shaken = write(join(nm, "shaken/index.js"), "");
	const own = write(join(app, "src/main.js"), "");
	const { roots, problems } = collect(app, {
		"assets/index.js": chunk({
			[kept]: 10,
			[shaken]: 0,
			[own]: 5,
			"\0vite/preload-helper.js": 3,
		}),
	});
	assert.deepEqual(roots, [join(nm, "kept"), vite]);
	assert.deepEqual(problems, []);
});

test("a module no file stands behind is a problem, not a silent skip", () => {
	const { problems } = collect(join(TMP, "app"), {
		"assets/index.js": chunk({ "\0some-plugin:virtual": 10 }),
	});
	assert.match(problems[0], /cannot tell which package .*some-plugin:virtual/);
});

test("a raw import brings its package's production dependencies along", () => {
	const app = join(TMP, "raw");
	const nm = join(app, "node_modules");
	write(
		join(nm, "bundled/package.json"),
		JSON.stringify({
			name: "bundled",
			dependencies: { inner: "1", "@types/inner": "1" },
			optionalDependencies: { absent: "1" },
		}),
	);
	const prebuilt = write(join(nm, "bundled/dist/all.min.js"), "");
	write(
		join(nm, "inner/package.json"),
		JSON.stringify({ name: "inner", dependencies: { deep: "1" } }),
	);
	write(join(nm, "deep/package.json"), JSON.stringify({ name: "deep" }));
	write(join(nm, "@types/inner/package.json"), "{}");
	const { roots, problems } = collect(app, {
		"assets/index.js": chunk({ [`${prebuilt}?raw`]: 10 }),
	});
	assert.deepEqual(roots, [
		join(nm, "bundled"),
		join(nm, "deep"),
		join(nm, "inner"),
	]);
	assert.deepEqual(problems, []);
});

test("Tailwind's stylesheets and the packages they @plugin ship", () => {
	const app = join(TMP, "css");
	const nm = join(app, "node_modules");
	write(join(nm, "tailwindcss/package.json"), "{}");
	const tw = write(join(nm, "tailwindcss/index.css"), "");
	write(join(nm, "@tw/typography/package.json"), "{}");
	const css = write(
		join(app, "src/index.css"),
		'@import "tailwindcss";\n@plugin "@tw/typography";\n@import "./local.css";\n@import "https://fonts.example/x.css";\n@source "../lib";\n',
	);
	const { roots, problems } = collect(app, {}, [
		css,
		`${tw}?direct`,
		join(nm, "tailwindcss/x.js"),
	]);
	assert.deepEqual(roots, [
		join(nm, "@tw/typography"),
		join(nm, "tailwindcss"),
	]);
	assert.deepEqual(problems, []);
});

test("a source map names what a build bundled, with the version pnpm's path records", () => {
	const dir = join(TMP, "maps");
	const map = (sources) => JSON.stringify({ version: 3, sources });
	const commented = write(
		join(dir, "a.js"),
		"code\n//# sourceMappingURL=a.js.map\n",
	);
	write(
		join(dir, "a.js.map"),
		map([
			"../src/a.ts",
			"../../node_modules/.pnpm/@s+x@1.2.0_peer@3/node_modules/@s/x/i.js",
			"webpack://LIB/node_modules/y/index.js",
			"../../node_modules/.pnpm/@s+x@1.2.0_peer@3/node_modules/@s/x/j.js",
		]),
	);
	assert.deepEqual(bundledIn(commented), [
		{ name: "@s/x", version: "1.2.0" },
		{ name: "y", version: null },
	]);

	const inline = Buffer.from(map(["node_modules/z/a.js"])).toString("base64");
	const inlined = write(
		join(dir, "b.js"),
		`x\n//# sourceMappingURL=data:application/json;base64,${inline}\n`,
	);
	assert.deepEqual(bundledIn(inlined), [{ name: "z", version: null }]);

	const beside = write(join(dir, "c.min.js"), "no comment");
	write(join(dir, "c.min.js.map"), map(["node_modules/w/a.js"]));
	assert.deepEqual(bundledIn(beside), [{ name: "w", version: null }]);

	assert.deepEqual(bundledIn(write(join(dir, "d.js"), "x")), []);
});

test("a bundled package's license is read from an installed copy, of another version if need be", () => {
	const store = join(TMP, "store", "node_modules", ".pnpm");
	const pkg = (entry, name, version) =>
		dirname(
			write(
				join(store, entry, "node_modules", name, "package.json"),
				JSON.stringify({ name, version }),
			),
		);
	const owner = pkg("owner@1.0.0", "owner", "1.0.0");
	const exact = pkg("dep@2.0.0_peer@1", "dep", "2.0.0");
	pkg("dep@3.0.0", "dep", "3.0.0");
	assert.equal(installedPackage(owner, "dep", "2.0.0"), exact);
	assert.equal(
		installedPackage(owner, "dep", "9.9.9"),
		join(store, "dep@3.0.0/node_modules/dep"),
	);
	assert.equal(installedPackage(owner, "absent", "1.0.0"), null);
});

test("a bundled package nobody installed needs a manual license and text", () => {
	const b = {
		id: "x (bundled in o@1.0.0)",
		name: "x",
		version: null,
		owner: "o@1.0.0",
	};
	assert.match(
		bundledPackage(b, {}).problem,
		/^x \(bundled in o@1\.0\.0\): bundled into o@1\.0\.0 but not installed/,
	);
	assert.match(
		bundledPackage(b, { [b.id]: { license: "MIT" } }).problem,
		/not installed/,
	);
	const pkg = bundledPackage(b, {
		[b.id]: { license: "MIT", text: "MIT text\n", source: "s" },
	});
	assert.deepEqual(pkg.files, [
		{ name: "License text (from s)", text: "MIT text" },
	]);
	assert.match(
		render([pkg]),
		/^x \(bundled in o@1\.0\.0\)\nhttps:\/\/www\.npmjs\.com\/package\/x\nLicense: MIT$/m,
	);
});

test("what a shipped file's map names ships too, installed or not", () => {
	const app = join(TMP, "mapped");
	const nm = join(app, "node_modules");
	write(
		join(nm, "lib/package.json"),
		JSON.stringify({ name: "lib", version: "1.0.0" }),
	);
	write(
		join(nm, "helper/package.json"),
		JSON.stringify({ name: "helper", version: "2.0.0" }),
	);
	const file = write(
		join(nm, "lib/dist/index.js"),
		"x\n//# sourceMappingURL=index.js.map",
	);
	write(
		join(nm, "lib/dist/index.js.map"),
		JSON.stringify({
			sources: [
				"../src/a.ts",
				"../node_modules/lib/b.js",
				"../node_modules/helper/h.js",
				"../node_modules/gone/g.js",
			],
		}),
	);
	const { roots, problems, bundled } = collect(app, {
		"assets/index.js": chunk({ [file]: 10 }),
	});
	assert.deepEqual(roots, [join(nm, "helper"), join(nm, "lib")]);
	assert.deepEqual(problems, []);
	assert.deepEqual(bundled, ["gone (bundled in lib@1.0.0)"]);
});
