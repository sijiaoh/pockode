// The turns the fake CLI plays for the chat suite. A chat message containing a
// scenario's `prompt` plays its `play`, which writes the turn through the fake
// CLI's `agent` (../fake-cli/claude.mjs). scenes.mjs reads the same objects
// for the titles it opens and the text it waits for, so a line reworded here is
// reworded for both.

import { join } from "node:path";
import { Q } from "../question/scenarios.mjs";

// --- what the tools hand back -------------------------------------------------

/** A Read result: numbered lines, as Claude Code writes them. */
function numbered(lines, from = 1) {
	return lines
		.map((line, i) => `${String(from + i).padStart(6)}→${line}`)
		.join("\n");
}

const DELIVER_TS = [
	'import { signPayload } from "../signing";',
	'import type { Endpoint, WebhookEvent } from "../types";',
	'import { config } from "./config";',
	"",
	"export interface DeliveryResult {",
	"\tstatus: number;",
	"\tattempts: number;",
	"\tdurationMs: number;",
	"}",
	"",
	"/**",
	" * Sends one event to one endpoint. A non-2xx response is logged and the",
	" * event is dropped — there is no retry yet.",
	" */",
	"export async function deliver(",
	"\tendpoint: Endpoint,",
	"\tevent: WebhookEvent,",
	"): Promise<DeliveryResult> {",
	"\tconst started = Date.now();",
	"\tconst body = JSON.stringify(event);",
	"\tconst res = await fetch(endpoint.url, {",
	'\t\tmethod: "POST",',
	"\t\theaders: {",
	'\t\t\t"Content-Type": "application/json",',
	'\t\t\t"X-Webhook-Signature": signPayload(body, endpoint.secret),',
	"\t\t},",
	"\t\tbody,",
	"\t\tsignal: AbortSignal.timeout(config.timeoutMs),",
	"\t});",
	"\tif (!res.ok) {",
	"\t\tconsole.warn(`webhook ${event.id} to ${endpoint.url}: ${res.status}`);",
	"\t}",
	"\treturn { status: res.status, attempts: 1, durationMs: Date.now() - started };",
	"}",
];

// A long file, so a Read body has to clamp.
const QUEUE_TS = Array.from({ length: 180 }, (_, i) =>
	i % 12 === 0
		? `// --- section ${i / 12 + 1} ${"-".repeat(60)}`
		: i % 12 === 1
			? `export function handler${i}(job: Job, attempt = ${i % 5}): Promise<void> {`
			: i % 12 === 11
				? "}"
				: `\tawait queue.push({ id: job.id, kind: "webhook", payload: job.payload, attempt, scheduledAt: Date.now() + ${i * 250} });`,
);

const FAILING_TESTS = `
 RUN  v3.2.4 /work/acme

 ❯ src/webhooks/sender/deliver.test.ts (4 tests | 2 failed) 412ms
   ✓ deliver > signs the payload
   ✓ deliver > reports the status
   × deliver > retries a 503 with backoff
     → expected 1 to be 3 // Object.is equality
   × deliver > gives up after an hour
     → expected "dropped" to be "dead-lettered"

 FAIL  src/webhooks/sender/deliver.test.ts > deliver > retries a 503 with backoff
AssertionError: expected 1 to be 3 // Object.is equality

- Expected
+ Received

- 3
+ 1

 ❯ src/webhooks/sender/deliver.test.ts:41:28
     39|     const result = await deliver(endpoint, event);
     40|
     41|     expect(result.attempts).toBe(3);
       |                             ^
     42|   });

 Test Files  1 failed (1)
      Tests  2 failed | 2 passed (4)
   Duration  1.31s`.trim();

const PASSING_TESTS = `
 RUN  v3.2.4 /work/acme

 ✓ src/webhooks/sender/backoff.test.ts (5 tests) 9ms
 ✓ src/webhooks/sender/deliver.test.ts (6 tests) 431ms

 Test Files  2 passed (2)
      Tests  11 passed (11)
   Duration  1.12s`.trim();

const FINAL_REPLY = `## Webhook retries

Failed deliveries are now retried with **exponential backoff and full jitter**, for up to an hour, and then moved to the dead-letter queue instead of being dropped.

### What changed

| File | Change | Why it matters for self-hosted users who run their own worker |
|---|---|---|
| \`src/webhooks/sender/deliver.ts\` | Retries 408, 429 and 5xx; honours \`Retry-After\` | A receiver that is briefly down no longer loses events |
| \`src/webhooks/sender/backoff.ts\` | New: \`nextDelay(attempt, retryAfter?)\` | One place to tune the curve |
| \`src/webhooks/sender/config.ts\` | \`maxElapsedMs\` defaults to one hour | Configurable per deployment through \`WEBHOOK_MAX_ELAPSED_MS\` |
| \`src/webhooks/dead-letter.ts\` | Records the last status and attempt count | The dashboard can show why an event gave up |

### The curve

\`\`\`ts
export function nextDelay(attempt: number, retryAfterMs?: number): number {
	if (retryAfterMs !== undefined) return Math.min(retryAfterMs, config.maxDelayMs);
	const ceiling = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs); // 1s, 2s, 4s … capped at 5 minutes
	return Math.floor(Math.random() * ceiling); // full jitter: spreads a thundering herd of retries after an outage
}
\`\`\`

### Before you merge

1. Run \`pnpm db:migrate\` — the dead-letter table gained two columns.
2. The background sink I started on port 4010 has exited; nothing is left running.
3. \`docs/webhooks.md\` now documents the retry policy; the changelog has an entry under *Unreleased*.

> The two failures in the first test run were the old behaviour being asserted against — both pass now.`;

// --- the turns ----------------------------------------------------------------

/**
 * The long turn: thinking, reads, a failing command, a long command, a
 * background command, a subagent with its own failed step, edits to more files
 * than the changes card shows unfolded, and a Markdown answer.
 */
async function longTurn(agent) {
	const p = (...parts) => join(agent.cwd, ...parts);
	const deliver = p("src/webhooks/sender/deliver.ts");

	agent.think(
		"The sender drops a failed delivery on the floor. Before adding retries I need to know where deliver() is called from, whether anything already backs off, and what the tests assert today.\n\nIf the queue already re-enqueues on failure, retrying inside deliver() would multiply attempts — check that first.",
	);
	agent.say("I'll start by reading how the sender works today.");
	agent.tool("Read", { file_path: deliver }, numbered(DELIVER_TS));
	agent.tool(
		"Grep",
		{
			pattern: "deliver\\(",
			path: p("src"),
			output_mode: "content",
			"-n": true,
		},
		[
			"src/webhooks/dispatcher.ts:58:      const result = await deliver(endpoint, event);",
			"src/webhooks/replay.ts:23:  return deliver(endpoint, event);",
			"src/webhooks/sender/deliver.test.ts:12:    const result = await deliver(endpoint, event);",
		].join("\n"),
	);
	agent.tool(
		"Glob",
		{ pattern: "src/webhooks/**/*.ts" },
		[
			"src/webhooks/dispatcher.ts",
			"src/webhooks/replay.ts",
			"src/webhooks/dead-letter.ts",
			"src/webhooks/sender/config.ts",
			"src/webhooks/sender/deliver.ts",
			"src/webhooks/sender/deliver.test.ts",
			"src/webhooks/types.ts",
		]
			.map((f) => p(f))
			.join("\n"),
	);
	agent.tool(
		"Read",
		{ file_path: p("src/jobs/queue/handlers.ts") },
		numbered(QUEUE_TS),
	);

	agent.say("Running the existing tests to see what they assert.");
	agent.tool(
		"Bash",
		{
			command: "pnpm vitest run src/webhooks --reporter=verbose",
			description: "Run the webhook tests",
		},
		FAILING_TESTS,
		{ isError: true },
	);
	agent.tool(
		"Bash",
		{
			command:
				'git log --oneline --since="3 weeks ago" -- src/webhooks/sender/ src/webhooks/dispatcher.ts && rg -n --hidden "MAX_ATTEMPTS|retryAfter|backoff|deadLetter" src/webhooks src/jobs/queue --glob "!**/*.snap" | sort -t: -k1,1 -k2,2n | head -n 40',
			description: "Look for earlier retry work",
		},
		[
			"9f3c2e1 Sign webhook payloads with the endpoint secret",
			"41d07aa Move the sender out of the dispatcher",
			"src/webhooks/dead-letter.ts:4:export async function deadLetter(event: WebhookEvent) {",
		].join("\n"),
	);

	// A command left running in the background, which reports later in the turn.
	const sink = agent.call("Bash", {
		command: "pnpm dev:webhook-sink --port 4010 --fail-every 3",
		description: "Start a flaky local webhook receiver",
		run_in_background: true,
	});
	agent.frame({
		type: "system",
		subtype: "task_started",
		task_id: "bsink4010",
		tool_use_id: sink,
		description: "Start a flaky local webhook receiver",
		is_backgrounded: true,
		task_type: "local_bash",
	});
	agent.result(sink, "Command running in background with ID: bsink4010.");

	agent.say("I'll have a subagent survey how the other senders test retries.");
	const task = agent.call("Agent", {
		description: "Survey retry tests in other senders",
		subagent_type: "Explore",
		prompt:
			"Find every test in this repository that exercises retry or backoff behaviour (email sender, Slack notifier, the job queue). For each, report the file, what it fakes (timers, fetch, clock) and how it asserts the number of attempts. Do not change any files.",
	});
	agent.frame({
		type: "system",
		subtype: "task_started",
		task_id: "a7explore",
		tool_use_id: task,
		description: "Survey retry tests in other senders",
		subagent_type: "Explore",
		is_backgrounded: false,
		task_type: "local_agent",
	});
	const sub = { parent: task };
	agent.say("Searching for retry tests across the senders.", task);
	agent.tool(
		"Grep",
		{ pattern: "retr(y|ies)|backoff", path: p("src"), glob: "**/*.test.ts" },
		"Found 4 files\nsrc/email/sender.test.ts\nsrc/slack/notifier.test.ts\nsrc/jobs/queue/retry.test.ts\nsrc/webhooks/sender/deliver.test.ts",
		sub,
	);
	agent.frame({
		type: "system",
		subtype: "task_progress",
		task_id: "a7explore",
		tool_use_id: task,
		description: "Reading src/email/sender.test.ts",
	});
	agent.tool(
		"Read",
		{ file_path: p("src/email/sender.test.ts") },
		numbered([
			'it("retries a 451 three times", async () => {',
			"\tvi.useFakeTimers();",
			"\tconst send = vi.fn().mockRejectedValueOnce(tempFail).mockResolvedValue(ok);",
			"\tawait runWithTimers(() => sender.send(mail));",
			"\texpect(send).toHaveBeenCalledTimes(3);",
			"});",
		]),
		sub,
	);
	agent.tool(
		"Bash",
		{
			command: "pnpm vitest run src/slack/notifier.test.ts -t retry",
			description: "Run the Slack retry tests",
		},
		"Error: Cannot find module '@acme/slack-mock' imported from src/slack/notifier.test.ts\n    at packageResolve (node:internal/modules/esm/resolve:873:9)",
		{ ...sub, isError: true },
	);
	agent.tool(
		"Read",
		{ file_path: p("src/jobs/queue/retry.test.ts"), offset: 1, limit: 40 },
		numbered([
			'describe("queue retry", () => {',
			'\tit("re-enqueues with the delay the handler returns", async () => {',
			"\t\tconst clock = installClock();",
			"\t\tawait queue.run(failingJob);",
			"\t\tclock.tick(4_000);",
			"\t\texpect(queue.pending()).toHaveLength(1);",
			"\t});",
			"});",
		]),
		sub,
	);
	agent.frame({
		type: "system",
		subtype: "task_progress",
		task_id: "a7explore",
		tool_use_id: task,
		description: "Writing up the survey",
	});
	const report =
		"Three senders test retries, all with fake timers:\n\n- **email** (`src/email/sender.test.ts`) — `vi.useFakeTimers()` and a mocked transport; asserts `toHaveBeenCalledTimes(3)`.\n- **job queue** (`src/jobs/queue/retry.test.ts`) — its own `installClock()`; asserts on `queue.pending()`.\n- **Slack** (`src/slack/notifier.test.ts`) — could not run: `@acme/slack-mock` is not installed.\n\nThe webhook sender is the only one with no retry test.";
	agent.say(report, task);
	agent.frame({
		type: "system",
		subtype: "task_notification",
		task_id: "a7explore",
		tool_use_id: task,
		status: "completed",
		summary: "Three senders test retries, all with fake timers",
	});
	agent.result(task, [{ type: "text", text: report }]);

	agent.think(
		"The queue does not re-enqueue webhook jobs, so retrying inside deliver() is safe. Use the email sender's fake-timer pattern for the tests.",
	);
	agent.say("Now the change itself.");
	const edit = (file, old_string, new_string) =>
		agent.tool(
			"Edit",
			{ file_path: p(file), old_string, new_string },
			`The file ${p(file)} has been updated successfully.`,
		);
	const write = (file, content) =>
		agent.tool(
			"Write",
			{ file_path: p(file), content },
			`File created successfully at: ${p(file)}`,
		);

	write(
		"src/webhooks/sender/backoff.ts",
		[
			'import { config } from "./config";',
			"",
			"export function nextDelay(attempt: number, retryAfterMs?: number): number {",
			"\tif (retryAfterMs !== undefined) return Math.min(retryAfterMs, config.maxDelayMs);",
			"\tconst ceiling = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);",
			"\treturn Math.floor(Math.random() * ceiling);",
			"}",
			"",
		].join("\n"),
	);
	edit(
		"src/webhooks/sender/deliver.ts",
		"\tif (!res.ok) {\n\t\tconsole.warn(`webhook ${event.id} to ${endpoint.url}: ${res.status}`);\n\t}\n\treturn { status: res.status, attempts: 1, durationMs: Date.now() - started };",
		"\tlet attempts = 1;\n\twhile (isRetryable(res.status) && Date.now() - started < config.maxElapsedMs) {\n\t\tawait sleep(nextDelay(attempts, retryAfter(res)));\n\t\tres = await send(endpoint, body);\n\t\tattempts++;\n\t}\n\tif (!res.ok) await deadLetter(event, { status: res.status, attempts });\n\treturn { status: res.status, attempts, durationMs: Date.now() - started };",
	);
	agent.tool(
		"Edit",
		{
			file_path: deliver,
			old_string: 'import { config } from "./config";\nimport { send }',
			new_string: 'import { nextDelay } from "./backoff";',
		},
		'<tool_use_error>String to replace not found in file.\nString: import { config } from "./config";\nimport { send }</tool_use_error>',
		{ isError: true },
	);
	edit(
		"src/webhooks/sender/deliver.ts",
		'import { config } from "./config";',
		'import { nextDelay } from "./backoff";\nimport { config } from "./config";',
	);
	edit(
		"src/webhooks/sender/config.ts",
		"\ttimeoutMs: 10_000,",
		"\ttimeoutMs: 10_000,\n\tbaseDelayMs: 1_000,\n\tmaxDelayMs: 5 * 60_000,\n\tmaxElapsedMs: Number(process.env.WEBHOOK_MAX_ELAPSED_MS ?? 60 * 60_000),",
	);
	edit(
		"src/webhooks/dead-letter.ts",
		"export async function deadLetter(event: WebhookEvent) {",
		"export async function deadLetter(\n\tevent: WebhookEvent,\n\tlast: { status: number; attempts: number },\n) {",
	);
	edit(
		"src/webhooks/types.ts",
		"\tdeliveredAt?: string;",
		"\tdeliveredAt?: string;\n\tattempts?: number;\n\tlastStatus?: number;",
	);
	write(
		"src/webhooks/sender/backoff.test.ts",
		'import { describe, expect, it } from "vitest";\nimport { nextDelay } from "./backoff";\n\ndescribe("nextDelay", () => {\n\tit("honours Retry-After", () => {\n\t\texpect(nextDelay(3, 2_000)).toBe(2_000);\n\t});\n});\n',
	);
	edit(
		"docs/webhooks.md",
		"## Delivery\n\nEach event is sent once.",
		"## Delivery\n\nA failed delivery is retried with exponential backoff and full jitter for up to an hour (`WEBHOOK_MAX_ELAPSED_MS`), then dead-lettered.",
	);
	edit(
		"CHANGELOG.md",
		"## Unreleased\n",
		"## Unreleased\n\n- Webhooks: retry failed deliveries with backoff instead of dropping them.\n",
	);

	agent.tool(
		"Bash",
		{
			command: "pnpm vitest run src/webhooks",
			description: "Run the webhook tests again",
		},
		PASSING_TESTS,
	);
	agent.frame({
		type: "system",
		subtype: "task_notification",
		task_id: "bsink4010",
		tool_use_id: sink,
		status: "completed",
		output_file: "/tmp/claude/tasks/bsink4010.output",
		summary:
			'Background command "Start a flaky local webhook receiver" completed (exit code 0)',
	});
	agent.say(FINAL_REPLY);
}

/** A short turn before a request, so the card sits under some history. */
function lookAround(agent) {
	const p = (...parts) => join(agent.cwd, ...parts);
	agent.say("Let me check what the build leaves behind first.");
	agent.tool(
		"Bash",
		{ command: "ls -la build dist .turbo", description: "List build output" },
		"build:\ntotal 8\ndrwxr-xr-x  4 dev dev 4096 Oct  3 18:20 .\n\ndist:\ntotal 1824\n-rw-r--r--  1 dev dev 1859302 Oct  3 18:20 index.js\n\n.turbo:\ntotal 4\n-rw-r--r-- 1 dev dev 112 Oct  3 18:20 turbo-build.log",
	);
	agent.tool(
		"Read",
		{ file_path: p("package.json") },
		numbered([
			"{",
			'\t"name": "@acme/webhooks",',
			'\t"scripts": {',
			'\t\t"build": "turbo run build --filter @acme/webhooks...",',
			'\t\t"clean": "rm -rf build dist .turbo"',
			"\t}",
			"}",
		]),
	);
}

export const CHAT = {
	long: {
		title: "Webhook retries",
		prompt:
			"Add retry with exponential backoff to the webhook sender, and cover it with tests.",
		play: longTurn,
	},
	permission: {
		title: "Clean rebuild",
		prompt: "Clean the build output and rebuild the webhooks package.",
		async play(agent) {
			lookAround(agent);
			const input = {
				command:
					"rm -rf build/ dist/ .turbo && pnpm install --frozen-lockfile && pnpm run build --filter @acme/webhooks...",
				description: "Remove build output and rebuild",
			};
			const id = agent.call("Bash", input);
			await agent.permission(id, "Bash", input, "Build finished in 14.2s.", [
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "pnpm run build:*" }],
					behavior: "allow",
					destination: "localSettings",
				},
			]);
		},
	},
	permissionMulti: {
		title: "Backoff cap",
		prompt: "Cap the webhook backoff at five minutes and document it.",
		async play(agent) {
			const p = (...parts) => join(agent.cwd, ...parts);
			agent.say("Two changes, in parallel: the cap and the docs.");
			const editInput = {
				file_path: p("src/webhooks/sender/config.ts"),
				old_string: "\tmaxDelayMs: 60 * 60_000,",
				new_string:
					"\t// Five minutes: past that a receiver that is down is down, and the\n\t// hour-long budget is better spent on more attempts.\n\tmaxDelayMs: 5 * 60_000,",
			};
			const writeInput = {
				file_path: p("docs/webhooks/retries.md"),
				content:
					"# Retries\n\nA failed delivery is retried with exponential backoff and full jitter.\n\n| Attempt | Longest wait |\n|---|---|\n| 1 | 1s |\n| 2 | 2s |\n| 9+ | 5m |\n",
			};
			const edit = agent.call("Edit", editInput);
			const write = agent.call("Write", writeInput);
			await Promise.all([
				agent.permission(
					edit,
					"Edit",
					editInput,
					`The file ${editInput.file_path} has been updated successfully.`,
				),
				agent.permission(
					write,
					"Write",
					writeInput,
					`File created successfully at: ${writeInput.file_path}`,
				),
			]);
		},
	},
	asking: {
		title: "Durable job queue",
		prompt: "Move the webhook jobs onto a durable queue.",
		async play(agent) {
			const p = (...parts) => join(agent.cwd, ...parts);
			agent.say("Looking at what the jobs run on now.");
			agent.tool(
				"Grep",
				{ pattern: "new MemoryQueue", path: p("src") },
				"src/jobs/queue/index.ts:9:export const queue = new MemoryQueue();",
			);
			agent.tool(
				"Read",
				{ file_path: p("src/jobs/queue/index.ts") },
				numbered(QUEUE_TS.slice(0, 30)),
			);
			agent.say("The queue lives in memory. One decision before I go on.");
			await agent.ask([Q.database]);
			agent.say("Asked. I'll carry on once you answer.");
		},
	},
	running: {
		title: "Flaky dispatcher test",
		prompt: "Find out why the dispatcher test is flaky.",
		async play(agent) {
			const p = (...parts) => join(agent.cwd, ...parts);
			agent.think(
				"Flaky usually means timers or ordering. Read the test, then run it in a loop.",
			);
			agent.tool(
				"Read",
				{ file_path: p("src/webhooks/dispatcher.test.ts") },
				numbered(DELIVER_TS.slice(0, 20)),
			);
			agent.say(
				"The test races the dispatcher's flush against a real 50ms timer. Running it 200 times to confirm before changing anything.",
			);
			agent.call("Bash", {
				command:
					"for i in $(seq 1 200); do pnpm vitest run src/webhooks/dispatcher.test.ts --reporter=dot || break; done",
				description: "Run the dispatcher test 200 times",
			});
			await agent.hang();
		},
	},
	// A turn the CLI ended while its background command still runs, which the
	// server reads as parked on it (blocked: background). Opened mid-wait, so
	// the page settles the reply against the turn rather than watching it.
	parked: {
		title: "Webhook load test",
		prompt: "Run the webhook load test and tell me the p99.",
		waiting: "It takes a few minutes. I'll report the p99 when it finishes.",
		async play(agent) {
			agent.say("Starting the load test against the local receiver.");
			const run = agent.call("Bash", {
				command: "pnpm bench:webhooks --duration 5m --rate 200",
				description: "Run the webhook load test",
				run_in_background: true,
			});
			agent.frame({
				type: "system",
				subtype: "task_started",
				task_id: "bbench200",
				tool_use_id: run,
				description: "Run the webhook load test",
				is_backgrounded: true,
				task_type: "local_bash",
			});
			// The level the server parks the turn on; the lifecycle frames above
			// only join the task to its row.
			const tasksChanged = (tasks) =>
				agent.frame({
					type: "system",
					subtype: "background_tasks_changed",
					tasks,
				});
			tasksChanged([{ task_id: "bbench200", task_type: "local_bash" }]);
			agent.result(run, "Command running in background with ID: bbench200.");
			agent.say(CHAT.parked.waiting);
			agent.frame({
				type: "result",
				subtype: "success",
				is_error: false,
				terminal_reason: "completed",
				result: "",
			});
			// Resumed by an interrupt (Stop in `run.sh up`), the way the CLI
			// resumes by itself once the command reports: in the same reply.
			await agent.hang();
			tasksChanged([]);
			agent.frame({
				type: "system",
				subtype: "task_notification",
				task_id: "bbench200",
				tool_use_id: run,
				status: "completed",
				summary:
					'Background command "Run the webhook load test" completed (exit code 0)',
			});
			agent.say("p99 was 184ms at 200 req/s.");
		},
	},
	thinking: {
		title: "Retry budget",
		prompt: "Should webhook retries share the job queue's retry budget?",
		reading: "Reading both retry paths first.",
		async play(agent) {
			const p = (...parts) => join(agent.cwd, ...parts);
			agent.say(CHAT.thinking.reading);
			agent.tool(
				"Read",
				{ file_path: p("src/jobs/queue/retry.ts") },
				numbered(QUEUE_TS.slice(0, 24)),
			);
			agent.tool(
				"Read",
				{ file_path: p("src/webhooks/sender/deliver.ts") },
				numbered(DELIVER_TS),
			);
			// Long enough for the page to be shot mid-turn before it thinks.
			await agent.sleep(2_500);
			await agent.hang({ thinking: true });
		},
	},
	// Sent by its scene, like `thinking`: a live row's clock counts from when
	// this client saw the call start, so a page that opens on a call already
	// running draws none.
	toolRunning: {
		title: "Migration dry run",
		prompt: "Check the pending migrations apply cleanly.",
		reading: "Looking at what is pending first.",
		async play(agent) {
			const p = (...parts) => join(agent.cwd, ...parts);
			agent.say(CHAT.toolRunning.reading);
			agent.tool(
				"Read",
				{ file_path: p("src/jobs/queue/retry.ts") },
				numbered(QUEUE_TS.slice(0, 12)),
			);
			agent.tool(
				"Grep",
				{ pattern: "ALTER TABLE", path: p("db/migrations") },
				[p("db/migrations/0042_retry_budget.sql")].join("\n"),
			);
			// Three calls in a row fold into a group, and this one is its
			// current step.
			agent.call("Bash", {
				command: "pnpm db:migrate --dry-run --verbose",
				description: "Dry-run the pending migrations",
			});
			await agent.hang();
		},
	},
	attachments: {
		title: "Crash report",
		prompt:
			"The worker crashed overnight — screenshot and log attached. Fix it?",
		async play(agent) {
			const p = (...parts) => join(agent.cwd, ...parts);
			agent.say(
				"The log shows `deliver()` throwing on a `null` endpoint secret — the screenshot is the same stack.",
			);
			agent.tool(
				"Read",
				{ file_path: p("src/webhooks/signing.ts") },
				numbered([
					'import { createHmac } from "node:crypto";',
					"",
					"export function signPayload(body: string, secret: string): string {",
					'\treturn createHmac("sha256", secret).update(body).digest("hex");',
					"}",
				]),
			);
			agent.tool(
				"Edit",
				{
					file_path: p("src/webhooks/signing.ts"),
					old_string:
						"export function signPayload(body: string, secret: string): string {",
					new_string:
						'export function signPayload(body: string, secret: string | null): string {\n\tif (!secret) throw new MissingSecretError("endpoint has no signing secret");',
				},
				`The file ${p("src/webhooks/signing.ts")} has been updated successfully.`,
			);
			agent.tool(
				"Edit",
				{
					file_path: p("src/webhooks/dispatcher.ts"),
					old_string: "\t\tconst result = await deliver(endpoint, event);",
					new_string:
						'\t\tif (!endpoint.secret) {\n\t\t\tawait disable(endpoint, "missing secret");\n\t\t\tcontinue;\n\t\t}\n\t\tconst result = await deliver(endpoint, event);',
				},
				`The file ${p("src/webhooks/dispatcher.ts")} has been updated successfully.`,
			);
			agent.say(
				"Fixed: an endpoint with no secret is now disabled with a reason instead of crashing the worker.",
			);
		},
	},
};
