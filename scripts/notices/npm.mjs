// Which npm packages a Vite build ships, and the notice each one owes.
//
// "Ships" is read off the build itself rather than package.json: a dependency
// listed there may be build tooling (tailwindcss's Vite plugin sits in web's
// `dependencies`) or tree-shaken away entirely, and a devDependency may still
// put code in the output (`@plugin "@tailwindcss/typography"`). The sources:
// - every module Rollup rendered into a chunk with at least one byte left;
// - Vite's own helpers, which arrive as virtual `\0` modules with no path;
// - the CSS Tailwind compiles, which never enters the module graph: its
//   stylesheets show up only as watch files, and its `@plugin` packages not
//   even there, so the directives are read from the stylesheets themselves;
// - for a file the bundler took in without parsing (a `?raw` import, a copied
//   asset), its package's whole production dependency tree, because such a
//   file may be a prebuilt bundle of them: web ships Mermaid's self-contained
//   build that way, with D3, DOMPurify, KaTeX and the rest inside;
// - for every shipped file that has a source map, the packages its `sources`
//   name under node_modules: what a package's own build bundled into it, which
//   need not be a dependency at all (Mermaid's build carries js-yaml, which it
//   does not depend on; libraries carry the tslib helpers they were compiled
//   with).
// The one source no build records, content generated from a devDependency
// (Shiki's grammars), is named by hand: CONTENT_FROM in npm-manual.mjs.

import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

// Virtual modules Vite injects into the output: the module preload polyfill,
// the dynamic import preload helper, and the helpers of the CommonJS plugin
// Vite bundles. Vite's LICENSE.md carries that plugin's notice too.
const VITE_VIRTUAL = /^\0(vite\/|commonjsHelpers\.js$)/;

// License, licence, copying and Apache's NOTICE, with or without a suffix
// (LICENSE-MIT.txt, LICENSE.BSD), but not code named after them: some
// packages ship a license-update.mjs.
const NOTICE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;
const CODE_FILE = /\.([cm]?[jt]sx?|json|map)$/i;

// Tailwind directives that pull a package's output into the stylesheet. A
// relative path is our own file and a URL (https:, data:) no package at all.
const CSS_PACKAGE =
	/@(?:import|plugin)\s+["'](?![a-z][a-z\d+.-]*:)([^"'./][^"']*)["']/gi;

const MANUAL_FILE = "scripts/notices/npm-manual.mjs";

// Ids of modules Vite hands over as text or as a URL rather than as code.
const UNPARSED = /\?(.*&)?(raw|url|inline)(&|$)/;

/** The package directory a resolved file belongs to, or null for our own code. */
export function packageRootOf(file) {
	// Greedy, so a package nested in another's node_modules is the inner one.
	return (
		file.match(/^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)/)?.[1] ??
		null
	);
}

/**
 * The real directory of the package `specifier` names, as Node would find it
 * from `dir`. Looked up on disk rather than through require.resolve, which an
 * `exports` map without a `require` condition would refuse.
 */
export function findPackage(dir, specifier) {
	const parts = specifier.split("/");
	const name = parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
	for (let at = resolve(dir); ; at = dirname(at)) {
		const candidate = join(at, "node_modules", name);
		if (existsSync(join(candidate, "package.json")))
			return realpathSync(candidate);
		if (dirname(at) === at) return null;
	}
}

/**
 * A Vite plugin that records the package root of everything the build ships.
 * `roots` is filled in by generateBundle; `problems` collects what could not be
 * attributed, so the caller can fail with every one of them at once.
 */
export function shippedPackages(viteRoot) {
	const roots = new Set();
	const problems = [];
	const opaque = new Set();
	const add = (root, from) => {
		if (root) roots.add(root);
		else problems.push(`cannot find the package ${from}`);
	};
	// Real paths of the files under node_modules that ship, for their maps.
	const shippedFiles = new Set();
	const bundled = new Map();
	const plugin = {
		name: "pockode:shipped-packages",
		generateBundle(_, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type === "chunk") {
					for (const [id, mod] of Object.entries(output.modules)) {
						if (mod.renderedLength === 0) continue;
						if (VITE_VIRTUAL.test(id)) {
							add(findPackage(viteRoot, "vite"), "vite");
							continue;
						}
						const file = id.replace(/^\0/, "").replace(/\?.*$/, "");
						if (!isAbsolute(file) || !existsSync(file)) {
							problems.push(
								`${output.fileName}: cannot tell which package the module ${JSON.stringify(id)} comes from`,
							);
							continue;
						}
						const real = realpathSync(file);
						const root = packageRootOf(real);
						if (root) {
							roots.add(root);
							shippedFiles.add(real);
						}
						if (root && UNPARSED.test(id)) opaque.add(root);
					}
				} else {
					// Copied assets (fonts, images) carry the path they were read from.
					for (const name of output.originalFileNames ?? []) {
						const file = resolve(viteRoot, name);
						if (!existsSync(file)) {
							problems.push(
								`${output.fileName}: cannot tell which package the asset ${JSON.stringify(name)} comes from`,
							);
							continue;
						}
						const real = realpathSync(file);
						const root = packageRootOf(real);
						if (!root) continue;
						roots.add(root);
						shippedFiles.add(real);
						opaque.add(root);
					}
				}
			}
			for (const file of this.getWatchFiles()) {
				if (!/\.css(\?|$)/.test(file)) continue;
				const css = realpathSync(file.replace(/\?.*$/, ""));
				const root = packageRootOf(css);
				if (root) roots.add(root);
				for (const [, specifier] of readFileSync(css, "utf8").matchAll(
					CSS_PACKAGE,
				)) {
					add(
						findPackage(dirname(css), specifier),
						`${JSON.stringify(specifier)} named in ${css}`,
					);
				}
			}
			const seen = new Set();
			for (const root of opaque) addDependencies(root, roots, seen, problems);
			for (const file of shippedFiles) {
				const owner = packageRootOf(file);
				for (const { name, version } of bundledIn(file)) {
					if (name === manifestOf(owner).name) continue;
					const root = installedPackage(owner, name, version);
					if (root) {
						roots.add(root);
						continue;
					}
					const ownerId = idOf(manifestOf(owner));
					const id = version
						? `${name}@${version}`
						: `${name} (bundled in ${ownerId})`;
					bundled.set(id, { id, name, version, owner: ownerId });
				}
			}
		},
	};
	// `bundled` holds what a source map names but no installed package
	// matches, by the id its manual entry is keyed by.
	return { plugin, roots, problems, bundled };
}

const manifests = new Map();
function manifestOf(root) {
	if (!manifests.has(root))
		manifests.set(
			root,
			JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
		);
	return manifests.get(root);
}

const idOf = (manifest) => `${manifest.name}@${manifest.version}`;

// A package path inside a source map: pnpm's store segment, when there is one,
// is the only place the version shows.
const MAPPED_PACKAGE =
	/node_modules\/(?:\.pnpm\/([^/]+)\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//;
const SOURCE_MAPPING_URL = /[/*][#@] sourceMappingURL=([^\s*'"]+)/g;

/**
 * The packages a file's source map says were bundled into it, each with its
 * version when the path records one. The map is the one its last
 * sourceMappingURL names, or else the `.map` beside the file (Mermaid's
 * prebuilt bundle names none). A file without a readable map gives nothing: a
 * map is the only record of what a build inlined.
 */
export function bundledIn(file) {
	const urls = [...readFileSync(file, "utf8").matchAll(SOURCE_MAPPING_URL)];
	let url = urls.at(-1)?.[1];
	if (!url && existsSync(`${file}.map`)) url = `${basename(file)}.map`;
	if (!url) return [];
	let map;
	try {
		const inline = url.match(/^data:application\/json[^,]*;base64,(.*)$/);
		map = JSON.parse(
			inline
				? Buffer.from(inline[1], "base64").toString("utf8")
				: readFileSync(resolve(dirname(file), decodeURI(url)), "utf8"),
		);
	} catch {
		return [];
	}
	const found = new Map();
	for (const source of map.sources ?? []) {
		const match = source.replaceAll("\\", "/").match(MAPPED_PACKAGE);
		if (!match) continue;
		const [, segment, name] = match;
		const prefix = `${name.replaceAll("/", "+")}@`;
		const version = segment?.startsWith(prefix)
			? segment.slice(prefix.length).split("_")[0]
			: null;
		found.set(`${name}@${version}`, { name, version });
	}
	return [...found.values()];
}

/**
 * The installed copy of `name` whose license file stands in for the one
 * bundled into `owner`: the same version if there is one, as `owner` would
 * resolve it or anywhere in the pnpm store it lives in; failing that, any
 * version, since a bundle's dependencies drift from what is installed and a
 * package's license text rarely changes between versions. Null if `name` is
 * not installed at all.
 */
export function installedPackage(owner, name, version) {
	const near = findPackage(owner, name);
	if (near && (!version || manifestOf(near).version === version)) return near;
	const store = owner.match(/^(.*[\\/]node_modules[\\/]\.pnpm)[\\/]/)?.[1];
	const copies = [];
	const prefix = `${name.replaceAll("/", "+")}@`;
	for (const entry of store ? readdirSync(store).sort() : []) {
		if (!entry.startsWith(prefix)) continue;
		const root = join(store, entry, "node_modules", name);
		if (existsSync(join(root, "package.json"))) copies.push(realpathSync(root));
	}
	return (
		copies.find((root) => manifestOf(root).version === version) ??
		near ??
		copies.at(-1) ??
		null
	);
}

/**
 * The notice of a package bundled into another but not installed, which only
 * a manual entry with both `license` and `text` can supply.
 */
export function bundledPackage({ id, name, version, owner }, manual) {
	const entry = manual[id];
	if (!entry?.license || !entry?.text) {
		return {
			id,
			problem: `${id}: bundled into ${owner} but not installed, so it has no license file to read; add its license and text to ${MANUAL_FILE}`,
		};
	}
	return {
		id,
		name,
		version,
		bundledIn: owner,
		license: entry.license,
		files: [
			{ name: `License text (from ${entry.source})`, text: entry.text.trim() },
		],
	};
}

// Type packages never reach a bundle; missing optional ones were never needed.
function addDependencies(root, roots, seen, problems) {
	if (seen.has(root)) return;
	seen.add(root);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const optional = manifest.optionalDependencies ?? {};
	const names = Object.keys({ ...manifest.dependencies, ...optional });
	for (const name of names) {
		if (name.startsWith("@types/")) continue;
		const dep = findPackage(root, name);
		if (!dep) {
			if (!(name in optional))
				problems.push(`${manifest.name}: cannot find its dependency ${name}`);
			continue;
		}
		roots.add(dep);
		addDependencies(dep, roots, seen, problems);
	}
}

/**
 * Name, version, license and license files of the package at `root`, or a
 * `problem` beside its `id` when either cannot be determined, because a notice
 * without its text does not discharge the obligation. `manual` maps
 * `name@version` to the `license` and/or `text` a package fails to publish;
 * an entry for something the package does publish is a problem too, so the
 * table cannot quietly override a package that has since fixed itself.
 */
export function readPackage(root, manual) {
	const manifest = manifestOf(root);
	const id = idOf(manifest);
	const fail = (problem) => ({ id, problem });
	const entry = manual[id] ?? {};
	const stale = (what) =>
		fail(
			`${id}: publishes its own ${what} now; drop it from its entry in ${MANUAL_FILE}`,
		);
	const declared = licenseOf(manifest);
	if (declared && entry.license) return stale("license in package.json");
	const license = declared ?? entry.license;
	if (!license) {
		return fail(
			`${id} (${root}): package.json declares no license; read it off the package and add it to ${MANUAL_FILE}`,
		);
	}
	const files = licenseFiles(root);
	if (files.length > 0 && entry.text) return stale("license file");
	if (files.length === 0) {
		if (!entry.text) {
			return fail(
				`${id} (${root}): no LICENSE, COPYING or NOTICE file with the ${license} text; find it upstream and add it to ${MANUAL_FILE}`,
			);
		}
		files.push({
			name: `License text, not published in the package (from ${entry.source})`,
			text: entry.text.trim(),
		});
	}
	return {
		id,
		name: manifest.name,
		version: manifest.version,
		license,
		files,
	};
}

// A package that ships the same text twice (LICENSE and LICENSE.md) gets it
// once. Line endings are normalised so the notices file has one kind.
function licenseFiles(root) {
	const files = [];
	const texts = new Set();
	for (const name of readdirSync(root).sort()) {
		if (!NOTICE_FILE.test(name) || CODE_FILE.test(name)) continue;
		if (!statSync(join(root, name)).isFile()) continue;
		const text = readFileSync(join(root, name), "utf8")
			.replace(/\r\n?/g, "\n")
			.trim();
		if (!text || texts.has(text)) continue;
		texts.add(text);
		files.push({ name, text });
	}
	return files;
}

// `license` is an SPDX expression today; older packages use an object or a
// `licenses` array of them.
function licenseOf(manifest) {
	const { license, licenses } = manifest;
	if (typeof license === "string") return license.trim();
	if (license?.type) return license.type;
	if (Array.isArray(licenses) && licenses.length > 0) {
		return licenses
			.map((l) => (typeof l === "string" ? l : l.type))
			.join(" OR ");
	}
	return null;
}

const RULE = "=".repeat(80);
const THIN = "-".repeat(80);

// Code-unit order, not localeCompare, so the file is the same on every machine.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The notices as plain text: a heading, then one block per package version,
 * sorted by name, in the layout of the server's section so the two read as
 * one file. The npm registry page is the source link, because it holds the
 * exact published version for every package, which a homepage does not.
 */
export function render(packages) {
	const sorted = [...packages].sort(
		(a, b) =>
			byCodeUnit(a.name, b.name) ||
			byCodeUnit(a.version ?? "", b.version ?? "") ||
			byCodeUnit(a.bundledIn ?? "", b.bundledIn ?? ""),
	);
	const lines = [
		"Pockode web interface: third-party software",
		"",
		"The web interface built into the Pockode server binary includes the",
		"following npm packages, distributed under the licenses reproduced below.",
		"Each entry links to the page its source code can be obtained from.",
	];
	for (const p of sorted) {
		lines.push(
			"",
			RULE,
			p.version
				? `${p.name} ${p.version}`
				: `${p.name} (bundled in ${p.bundledIn})`,
			p.version
				? `https://www.npmjs.com/package/${p.name}/v/${p.version}`
				: `https://www.npmjs.com/package/${p.name}`,
			`License: ${p.license}`,
		);
		for (const file of p.files) lines.push(THIN, file.name, "", file.text);
	}
	return `${lines.join("\n")}\n`;
}
