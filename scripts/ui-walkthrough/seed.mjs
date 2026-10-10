// Writes the project a suite's server opens and prints its path:
//
//   node seed.mjs <suite> <state dir>
//
// The project is <suite>/project.mjs's default export where there is one, and
// a one-file repository otherwise. Its history is committed under a fixed
// identity, each commit dated `minutesAgo` before WALKTHROUGH_CLOCK, so every
// hash is the same every run; run.sh dates the server's own commits at the
// clock itself, and the identity set here is the one they are made under.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT = {
	name: "project",
	commits: [
		{ message: "init", files: { "README.md": "# Walkthrough project\n" } },
	],
};

const [suite, state] = process.argv.slice(2);
const own = join(import.meta.dirname, suite, "project.mjs");
const project = existsSync(own) ? (await import(own)).default : DEFAULT;
const clock = Date.parse(process.env.WALKTHROUGH_CLOCK);

const dir = join(state, project.name);
mkdirSync(dir, { recursive: true });
const git = (args, env = {}) =>
	execFileSync("git", args, {
		cwd: dir,
		env: { ...process.env, ...env },
		stdio: ["ignore", "ignore", "inherit"],
	});
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", project.author?.name ?? "walkthrough"]);
git([
	"config",
	"user.email",
	project.author?.email ?? "walkthrough@example.com",
]);

for (const { message, minutesAgo = 0, files } of project.commits) {
	for (const [path, content] of Object.entries(files)) {
		const file = join(dir, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	const date = new Date(clock - minutesAgo * 60_000).toISOString();
	git(["add", "-A"]);
	git(["commit", "-q", "-m", message], {
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	});
}

console.log(dir);
