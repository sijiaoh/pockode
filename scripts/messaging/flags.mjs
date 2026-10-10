// Fails when the README or the site names a `pockode` flag the server does
// not have, one it has deprecated, or one written in the double-dash style.
//
// The server is the truth: it is built and asked for its own `-h`, so a flag
// renamed or removed there is caught here without a list to keep in step.
// What counts as naming a flag:
// - a `pockode` command line (`pockode -password X`, `pockode cluster -port 1`),
//   in any scanned file — the flags are checked against that command's set;
// - a code span that is nothing but a flag (`-relay=false`), in prose files,
//   checked against the server's own set. A flag of another tool is written
//   inside its command instead (`sh -s -- --version 0.16.0`), so it is never
//   mistaken for one of these.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

// Hugo's output and caches and the Lighthouse reports are generated, not written.
const SKIP_DIRS = new Set([
	"public",
	"resources",
	"node_modules",
	".lighthouseci",
]);
const TEXT = new Set([".md", ".html", ".yaml", ".yml", ".toml", ".sh", ".ps1"]);
const PROSE = new Set([".md", ".html", ".yaml", ".yml"]);

// Go's flag package answers these itself; they never appear in PrintDefaults.
const BUILTIN = ["h", "help"];

/** Flags from Go's PrintDefaults output: name → its usage text. */
export function parseDefaults(text) {
	const flags = new Map();
	let current = null;
	for (const line of text.split("\n")) {
		// "  -name type", usage on the next lines, or "  -x type\tusage" for a
		// one-letter name. The type is left out.
		const flag = line.match(/^ {2}-([\w-]+)(?: \S+)?(?:\t(.*))?$/);
		if (flag) {
			current = flag[1];
			flags.set(current, flag[2] ?? "");
		} else if (current && /^ {4}\t/.test(line)) {
			flags.set(current, `${flags.get(current)} ${line.trim()}`.trim());
		} else {
			current = null;
		}
	}
	return flags;
}

const FLAG = /^(-{1,2})([a-zA-Z][\w-]*)(=\S*)?$/;

/**
 * The flags a file names: { written, dashes, name, command, line }, where
 * command is "server" or "cluster". `prose` enables bare code spans.
 */
export function mentions(text, prose) {
	const found = [];
	text.split("\n").forEach((line, index) => {
		const add = (token, command) => {
			const [, dashes, name] = token.match(FLAG);
			found.push({ written: token, dashes, name, command, line: index + 1 });
		};
		// Not part of a longer word or a host name: `pockode.com`,
		// `pockode-linux-amd64` and `.pockode/` are not the command.
		for (const m of line.matchAll(/(?<![\w.-])pockode(?:\.exe)?(?![\w.-])/g)) {
			// The command line ends where its code span, string or pipeline does.
			const rest = line.slice(m.index + m[0].length).split(/[`'<|;&#)]/)[0];
			const tokens = rest.trim().split(/\s+/).filter(Boolean);
			const command = tokens[0] === "cluster" ? "cluster" : "server";
			if (command === "cluster") tokens.shift();
			// "pockode finds this copy" is prose, and `pockode mcp` is internal.
			if (!tokens[0] || !FLAG.test(tokens[0])) continue;
			for (const token of tokens) if (FLAG.test(token)) add(token, command);
		}
		if (prose)
			for (const m of line.matchAll(
				/`(-{1,2}[a-zA-Z][\w-]*(?:=[^`\s]*)?)`|<code[^>]*>(-{1,2}[a-zA-Z][\w-]*(?:=[^<\s]*)?)<\/code>/g,
			))
				add(m[1] ?? m[2], "server");
	});
	return found;
}

/** What is wrong with one mention, or null. */
export function problem(mention, flagSets) {
	const flags = flagSets[mention.command];
	const command = mention.command === "cluster" ? "pockode cluster" : "pockode";
	if (BUILTIN.includes(mention.name)) return null;
	if (!flags.has(mention.name))
		return `${mention.written} is not a flag of \`${command}\``;
	if (/\bdeprecated\b/i.test(flags.get(mention.name)))
		return `${mention.written} is deprecated: ${flags.get(mention.name)}`;
	if (mention.dashes !== "-")
		return `${mention.written} is written with two dashes; the copy uses one (-${mention.name})`;
	return null;
}

function serverFlagSets() {
	const dir = mkdtempSync(join(tmpdir(), "pockode-flags-"));
	try {
		const bin = join(
			dir,
			process.platform === "win32" ? "pockode.exe" : "pockode",
		);
		run("go", ["build", "-o", bin, "."], join(ROOT, "server"));
		const help = (...args) =>
			parseDefaults(run(bin, [...args, "-h"], dir).stderr);
		const sets = { server: help(), cluster: help("cluster") };
		for (const [name, set] of Object.entries(sets))
			if (!set.size) throw new Error(`\`pockode ${name} -h\` listed no flags.`);
		return sets;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`\`${command} ${args.join(" ")}\` exited ${result.status}:\n${result.stderr}`,
		);
	return result;
}

function* files(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) yield* files(path);
		} else if (TEXT.has(extname(entry.name))) {
			yield path;
		}
	}
}

if (import.meta.main) {
	const flagSets = serverFlagSets();
	const problems = [];
	let count = 0;
	for (const path of [join(ROOT, "README.md"), ...files(join(ROOT, "site"))]) {
		const text = readFileSync(path, "utf8");
		for (const mention of mentions(text, PROSE.has(extname(path)))) {
			count++;
			const wrong = problem(mention, flagSets);
			if (wrong)
				problems.push(`${relative(ROOT, path)}:${mention.line}: ${wrong}`);
		}
	}
	if (problems.length) {
		console.error(problems.join("\n"));
		process.exit(1);
	}
	// A scan that silently matched nothing would pass forever.
	if (!count) {
		console.error(
			"No pockode flags found in the README or the site; the scan is broken.",
		);
		process.exit(1);
	}
	console.log(`${count} flag mentions checked against the server's flags.`);
}
