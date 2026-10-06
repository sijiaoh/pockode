// Takes every suite's scenes through their viewports and themes and saves one
// screenshot per state as <suite dir>/<state>_<viewport>_<theme>.png. Run
// through run.sh, which provides the environment this reads.
//
//   node shoot.mjs [--themes=all] [filter...]
//
// See harness.mjs's `run` for what a filter matches.

import chat from "./chat/scenes.mjs";
import { run } from "./harness.mjs";
import question from "./question/scenes.mjs";

await run([question, chat], process.argv.slice(2));
