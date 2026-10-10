// Takes a suite's scenes through their viewports and themes and saves one
// screenshot per state as <suite dir>/<state>_<viewport>_<theme>.png. Run
// through run.sh, which provides the environment this reads and starts a fresh
// server for each suite.
//
//   node shoot.mjs --suites [--themes=all] [filter...]   # the suites with a scene left
//   node shoot.mjs --suite=<name> [--themes=all] [filter...]
//
// See harness.mjs's `plan` for what a filter matches.

import chat from "./chat/scenes.mjs";
import { plan, run } from "./harness.mjs";
import marketing from "./marketing/scenes.mjs";
import marketingIntro from "./marketing-intro/scenes.mjs";
import question from "./question/scenes.mjs";

const SUITES = [question, chat, marketingIntro, marketing];

const argv = process.argv.slice(2);
if (argv.includes("--suites")) {
	const names = new Set(plan(SUITES, argv).map((j) => j.suite.name));
	if (names.size === 0) {
		const optIn = SUITES.filter((s) => s.optIn).map((s) => s.name);
		console.error(
			`No scene matches those filters (${optIn.join(", ")} run only when a filter names them).`,
		);
		process.exit(2);
	}
	console.log([...names].join("\n"));
} else {
	const name = argv.find((a) => a.startsWith("--suite="))?.slice(8);
	const suite = SUITES.find((s) => s.name === name);
	if (!suite) {
		console.error(`No suite named ${name}.`);
		process.exit(2);
	}
	await run([suite], argv);
}
