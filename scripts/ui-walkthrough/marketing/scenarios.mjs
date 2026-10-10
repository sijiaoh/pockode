// The turns the fake CLI plays for the marketing suite, on tidy (project.mjs)
// and to docs/marketing-assets.md §8: the story "Add due dates to todos", its
// coordinator, and the agents of its three tasks. Every message Pockode sends a
// work names the work's title, which is how a message finds its scenario
// (`prompt`) — all but an answer, which quotes its question instead and is
// played only in the conversation that asked it (`follows`). scenes.mjs reads
// the same objects for the titles it opens and the text it waits for.
//
// Everything a work does in Pockode it does through the real MCP path
// (`agent.mcp`): the coordinator creates and starts the tasks, each task reports
// on the story and closes itself, so the work store, the comments and the
// questions are the ones real agents leave. The edits are real too: each
// changes the files on disk before it reports the change, so the Git panel and
// the diff show what the turn's changes card says. Together the three tasks
// leave 6 files changed, +142 −18 (§8.5); the third alone is 3 files, +86 −9.
//
// The task agents run at once, so each holds at gates (`agent.gate`) the suite
// opens one agent at a time: `go-<key>` before it does anything, and
// `resume-<key>` with a tool call still running — the "work in parallel" state
// the suite shoots before letting any of them finish.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILES } from "./project.mjs";

/** A Read result: numbered lines, as Claude Code writes them. */
function numbered(text) {
	return text
		.replace(/\n$/, "")
		.split("\n")
		.map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
		.join("\n");
}

function read(agent, file) {
	agent.tool(
		"Read",
		{ file_path: join(agent.cwd, file) },
		numbered(FILES[file]),
	);
}

/**
 * Makes one edit of a turn's on disk, and reports it. With `gate`, the call is
 * left running at that gate, and the edit made once the suite lets it on.
 */
async function change(agent, { file, old_string, new_string }, gate) {
	const path = join(agent.cwd, file);
	const id = agent.call("Edit", { file_path: path, old_string, new_string });
	if (gate) await agent.gate(gate, id);
	const text = readFileSync(path, "utf8");
	if (!text.includes(old_string))
		throw new Error(`${file} has no ${JSON.stringify(old_string)}`);
	writeFileSync(path, text.replace(old_string, new_string));
	agent.result(id, `The file ${path} has been updated successfully.`);
}

// What a turn reports it spent, fixed so the session panel reads the same every
// run. The fake's result frame carries it (../fake-cli/claude.mjs).
const usage = (input, output, cacheRead, costUsd) => ({
	contextTokens: input + cacheRead,
	modelUsage: {
		"claude-opus-5-5": {
			inputTokens: input,
			outputTokens: output,
			cacheReadInputTokens: cacheRead,
			cacheCreationInputTokens: 0,
			contextWindow: 200_000,
		},
	},
	costUsd,
});

// --- the question (§8.3) ------------------------------------------------------

export const UNDATED = {
	header: "Undated",
	question: "Where should todos without a due date go?",
	options: [
		{
			label: "After dated todos",
			description:
				"Undated items sink to the bottom, so what's due soonest is always on top.",
			recommended: true,
		},
		{
			label: "Before dated todos",
			description: "Undated items stay first, the way the list looks today.",
		},
	],
};

// --- what each task changes -----------------------------------------------------

/** Task 1: a due date on the model and the API. */
const STORE_CHANGES = [
	{
		file: "src/types.ts",
		old_string: "\tcreatedAt: string;\n}",
		new_string:
			"\tcreatedAt: string;\n\t/** A calendar date, YYYY-MM-DD; absent when there is no deadline. */\n\tdue?: string;\n}",
	},
	{
		file: "src/api/todos.ts",
		old_string:
			"export function addTodo(title: string): Todo {\n\tconst todo: Todo = {\n\t\tid: crypto.randomUUID(),\n\t\ttitle: title.trim(),\n\t\tdone: false,\n\t\tcreatedAt: new Date().toISOString(),\n\t};",
		new_string:
			"export function addTodo(title: string, due?: string): Todo {\n\tconst todo: Todo = {\n\t\tid: crypto.randomUUID(),\n\t\ttitle: title.trim(),\n\t\tdone: false,\n\t\tcreatedAt: new Date().toISOString(),\n\t\t...(due && { due }),\n\t};",
	},
	{
		file: "src/api/todos.ts",
		old_string:
			"export function toggleTodo(id: string): void {\n\tsaveTodos(\n\t\tlistTodos().map((t) => (t.id === id ? { ...t, done: !t.done } : t)),\n\t);\n}",
		new_string:
			"function updateTodo(id: string, update: (todo: Todo) => Todo): void {\n\tsaveTodos(listTodos().map((t) => (t.id === id ? update(t) : t)));\n}\n\n/** Sets or clears a todo's due date. */\nexport function setDue(id: string, due: string | undefined): void {\n\tupdateTodo(id, ({ due: _, ...rest }) => (due ? { ...rest, due } : rest));\n}\n\nexport function toggleTodo(id: string): void {\n\tupdateTodo(id, (t) => ({ ...t, done: !t.done }));\n}",
	},
];

/** Task 2: a date picker beside the title. */
const FORM_CHANGES = [
	{
		file: "src/components/TodoForm.tsx",
		old_string:
			'import { useState } from "react";\n\ninterface Props {\n\tonAdd: (title: string) => void;\n}',
		new_string:
			'import { useRef, useState } from "react";\n\ninterface Props {\n\tonAdd: (title: string, due?: string) => void;\n}\n\n/** "May 15" for a YYYY-MM-DD date, read as a calendar day wherever we are. */\nfunction shortDate(due: string): string {\n\treturn new Date(`${due}T00:00:00Z`).toLocaleDateString("en-US", {\n\t\tmonth: "short",\n\t\tday: "numeric",\n\t\ttimeZone: "UTC",\n\t});\n}',
	},
	{
		file: "src/components/TodoForm.tsx",
		old_string: '\tconst [title, setTitle] = useState("");\n',
		new_string:
			'\tconst [title, setTitle] = useState("");\n\tconst [due, setDue] = useState<string>();\n\tconst picker = useRef<HTMLInputElement>(null);\n',
	},
	{
		file: "src/components/TodoForm.tsx",
		old_string:
			'\t\t<form\n\t\t\tclassName="todo-form"\n\t\t\tonSubmit={(e) => {\n\t\t\t\te.preventDefault();\n\t\t\t\tif (!title.trim()) return;\n\t\t\t\tonAdd(title);\n\t\t\t\tsetTitle("");\n',
		new_string:
			'\t\t<form\n\t\t\tclassName={due ? "todo-form has-due" : "todo-form"}\n\t\t\tonSubmit={(e) => {\n\t\t\t\te.preventDefault();\n\t\t\t\tif (!title.trim()) return; // a date alone is not a todo\n\t\t\t\tonAdd(title, due);\n\t\t\t\tsetTitle("");\n\t\t\t\tsetDue(undefined);\n',
	},
	{
		file: "src/components/TodoForm.tsx",
		old_string: '\t\t\t\tplaceholder="Add a todo…"\n\t\t\t/>\n',
		new_string:
			'\t\t\t\tplaceholder="Add a todo…"\n\t\t\t/>\n\t\t\t<button\n\t\t\t\ttype="button"\n\t\t\t\tclassName={due ? "date-chip set" : "date-chip"}\n\t\t\t\tonClick={() => picker.current?.showPicker()}\n\t\t\t>\n\t\t\t\t{due ? shortDate(due) : "Due date"}\n\t\t\t</button>\n\t\t\t{due && (\n\t\t\t\t<button\n\t\t\t\t\ttype="button"\n\t\t\t\t\tclassName="date-clear"\n\t\t\t\t\taria-label="Clear due date"\n\t\t\t\t\tonClick={() => setDue(undefined)}\n\t\t\t\t>\n\t\t\t\t\t×\n\t\t\t\t</button>\n\t\t\t)}\n\t\t\t{/* Hidden: the chip opens it, and shows what it holds. */}\n\t\t\t<input\n\t\t\t\tref={picker}\n\t\t\t\ttype="date"\n\t\t\t\thidden\n\t\t\t\tvalue={due ?? ""}\n\t\t\t\tonChange={(e) => setDue(e.target.value || undefined)}\n\t\t\t/>\n',
	},
];

/** Task 3: the ordering the question settles, the overdue badge, tests. */
const SORT_CHANGES = [
	{
		file: "src/lib/sort.ts",
		old_string:
			"/** Open todos first, then done ones; oldest first within each. */\nexport function sortTodos(todos: Todo[]): Todo[] {\n\treturn [...todos].sort((a, b) => {\n\t\tif (a.done !== b.done) return a.done ? 1 : -1;\n\t\treturn a.createdAt.localeCompare(b.createdAt);\n\t});\n}",
		new_string:
			"/** Today as YYYY-MM-DD, the form a due date is stored in. */\nexport function today(now = new Date()): string {\n\treturn now.toISOString().slice(0, 10);\n}\n\n/**\n * Whether an open todo's due date has passed. A todo due today is not\n * overdue until tomorrow.\n */\nexport function isOverdue(todo: Todo, now = new Date()): boolean {\n\treturn !todo.done && !!todo.due && todo.due < today(now);\n}\n\n/**\n * Open todos first, then done ones. Within each, the soonest due date first\n * and undated todos after every dated one; ties keep the order they were\n * added in.\n */\nexport function sortTodos(todos: Todo[]): Todo[] {\n\treturn [...todos].sort(\n\t\t(a, b) =>\n\t\t\tNumber(a.done) - Number(b.done) ||\n\t\t\tcompareDue(a.due, b.due) ||\n\t\t\ta.createdAt.localeCompare(b.createdAt),\n\t);\n}\n\nfunction compareDue(a?: string, b?: string): number {\n\tif (a === b) return 0;\n\tif (!a) return 1;\n\tif (!b) return -1;\n\treturn a.localeCompare(b);\n}",
	},
	{
		file: "src/lib/sort.test.ts",
		old_string: 'import { sortTodos } from "./sort";',
		new_string: 'import { isOverdue, sortTodos, today } from "./sort";',
	},
	{
		file: "src/lib/sort.test.ts",
		old_string:
			'\tit("puts done todos last", () => {\n\t\tconst sorted = sortTodos([todo("a", { done: true }), todo("b")]);\n',
		new_string:
			'\tit("puts done todos last, overdue or not", () => {\n\t\tconst sorted = sortTodos([\n\t\t\ttodo("a", { done: true, due: "2026-05-01" }),\n\t\t\ttodo("b"),\n\t\t]);\n',
	},
	{
		file: "src/lib/sort.test.ts",
		old_string:
			'\t\texpect(sorted.map((t) => t.title)).toEqual(["b", "a"]);\n\t});\n});',
		new_string:
			'\t\texpect(sorted.map((t) => t.title)).toEqual(["b", "a"]);\n\t});\n\n\tit("puts the soonest due date first", () => {\n\t\tconst sorted = sortTodos([\n\t\t\ttodo("later", { due: "2026-05-15" }),\n\t\t\ttodo("sooner", { due: "2026-05-10" }),\n\t\t]);\n\t\texpect(sorted.map((t) => t.title)).toEqual(["sooner", "later"]);\n\t});\n\n\tit("puts undated todos after dated ones", () => {\n\t\tconst sorted = sortTodos([\n\t\t\ttodo("someday"),\n\t\t\ttodo("dated", { due: "2026-05-15" }),\n\t\t]);\n\t\texpect(sorted.map((t) => t.title)).toEqual(["dated", "someday"]);\n\t});\n});\n\ndescribe("isOverdue", () => {\n\tconst now = new Date("2026-05-12T10:24:00Z");\n\n\tit("is overdue only before today, and never once done", () => {\n\t\texpect(isOverdue(todo("a", { due: "2026-05-10" }), now)).toBe(true);\n\t\texpect(isOverdue(todo("b", { due: "2026-05-12" }), now)).toBe(false);\n\t\texpect(isOverdue(todo("c", { due: "2026-05-10", done: true }), now)).toBe(\n\t\t\tfalse,\n\t\t);\n\t});\n\n\tit("reads today in UTC, the zone a due date is stored in", () => {\n\t\texpect(today(new Date("2026-05-12T23:30:00Z"))).toBe("2026-05-12");\n\t});\n});',
	},
	{
		file: "src/components/TodoItem.tsx",
		old_string: 'import type { Todo } from "../types";',
		new_string:
			'import { isOverdue, today } from "../lib/sort";\nimport type { Todo } from "../types";\n\nfunction dueLabel(todo: Todo): string | undefined {\n\tif (!todo.due) return undefined;\n\tif (todo.due === today()) return "Today";\n\tconst date = new Date(`${todo.due}T00:00:00Z`).toLocaleDateString("en-US", {\n\t\tmonth: "short",\n\t\tday: "numeric",\n\t\ttimeZone: "UTC",\n\t});\n\treturn isOverdue(todo) ? `Overdue · ${date}` : date;\n}',
	},
	{
		file: "src/components/TodoItem.tsx",
		old_string:
			'export function TodoItem({ todo, onToggle }: Props) {\n\treturn (\n\t\t<li className={todo.done ? "todo done" : "todo"}>',
		new_string:
			'export function TodoItem({ todo, onToggle }: Props) {\n\tconst due = dueLabel(todo);\n\tconst classes = ["todo", todo.done && "done", isOverdue(todo) && "overdue"];\n\n\treturn (\n\t\t<li className={classes.filter(Boolean).join(" ")}>',
	},
	{
		file: "src/components/TodoItem.tsx",
		old_string: '\t\t\t<span className="title">{todo.title}</span>\n',
		new_string:
			'\t\t\t<span className="title">{todo.title}</span>\n\t\t\t{due && <span className="due">{due}</span>}\n',
	},
];

// --- the work (§8.2) -------------------------------------------------------------

export const STORY = {
	title: "Add due dates to todos",
	body: "Let a todo have a due date: pick one when adding it, see it on the row, and have the soonest come first and overdue ones stand out.",
};

/**
 * What the suite makes of the two default roles the story and its tasks run
 * under, in English like everything else on screen. The PM stays the default
 * story role (§8.2); its steps end before a commit, which is the user's to
 * make from the Git panel.
 */
export const ROLES = {
	story: {
		name: "PM",
		role_prompt:
			"A world-class PM who knows how coding agents work best.\n\nBreak a story into tasks by feature, each small enough for one agent, and leave the how to whoever takes it.",
		steps: [
			"Break the story into tasks",
			"Start the tasks and see them through",
		],
	},
	task: {
		name: "Engineer",
		role_prompt: "A world-class engineer.\n\nDo not commit.",
		steps: [],
	},
};

/** The text every message Pockode sends a work carries its title in. */
const workContext = (title) => `You are working on: "${title}"`;

function workId(text) {
	const id = text.match(/You are working on: ".*?" \(Work ID: ([^)\s]+)\)/);
	if (!id) throw new Error("no work context in this message");
	return id[1];
}

/**
 * What a task's kickoff asks for first: the work, and the story's notes. The
 * conversation remembers which task it is, for the turns whose messages do not
 * say.
 */
async function readWork(agent, text, task) {
	const id = workId(text);
	const { story_id: storyId } = JSON.parse(await agent.mcp("work_get", { id }));
	await agent.mcp("work_comment_list", { work_id: storyId });
	agent.remember({ task, id, storyId });
}

/** A task's last word: its report on the story, then closing itself. */
async function report(agent, body) {
	const { id, storyId } = agent.memory;
	await agent.mcp("work_comment_add", { work_id: storyId, body });
	await agent.mcp("step_done", { id });
}

// --- the coordinator ---------------------------------------------------------------

/**
 * Step 1: the three tasks, under the task role. Run again by a nudge, it
 * creates only what is missing, as an agent that looked first would.
 */
async function plan(agent, text) {
	const id = workId(text);
	await agent.mcp("work_get", { id });
	agent.say(
		"Three pieces, each one agent can finish alone: storing the date, picking it in the form, and ordering the list by it.",
	);
	const roles = JSON.parse(
		await agent.mcp("agent_role_list", { work_type: "task" }),
	);
	const role = roles.find((r) => r.name === ROLES.task.name);
	const made = JSON.parse(await agent.mcp("task_list", { story_id: id }));
	for (const task of TASKS.filter(
		(t) => !made.some((m) => m.title === t.title),
	))
		await agent.mcp("task_create", {
			story_id: id,
			title: task.title,
			body: task.body,
			agent_role_id: role.id,
		});
	await agent.mcp("step_done", { id });
	agent.say("Tasks are in. Starting them next.");
}

/** Step 2: start every task, in the order they were planned, and wait. */
async function startTasks(agent, text) {
	const id = workId(text);
	const tasks = JSON.parse(await agent.mcp("task_list", { story_id: id }));
	for (const { title } of TASKS)
		await agent.mcp("task_start", {
			id: tasks.find((t) => t.title === title).id,
		});
	agent.say(
		"All three are running side by side. I'll read each report as it comes in.",
	);
	await agent.mcp("story_wait", { id });
}

/**
 * A task asked the user something. Where undated todos go is a product call,
 * not one the coordinator made, so it takes the question to the user rather
 * than guess — which is what the story's rules ask of it.
 */
async function forward(agent) {
	agent.say(
		"Where undated todos go is your call, not something I decided. Asking you.",
	);
	await agent.ask([UNDATED]);
}

/** A task closed: read its report, and wait for the rest or finish. */
async function taskClosed(agent, text) {
	const id = workId(text);
	const [, title] = text.match(/Task "(.+?)" \(ID: [^)]+\) has been closed/);
	await agent.mcp("work_comment_list", { work_id: id });
	const tasks = JSON.parse(await agent.mcp("task_list", { story_id: id }));
	if (tasks.some((t) => t.status !== "closed")) {
		agent.say(`*${title}* is done. Waiting for the rest.`);
		await agent.mcp("story_wait", { id });
		return;
	}
	agent.say(
		"All three tasks are done: todos carry a due date, the form sets it, and the list is ordered by it with overdue ones flagged. Ready for you to review and commit.",
	);
	await agent.mcp("step_done", { id });
}

async function coordinate(agent, text) {
	if (text.includes("has asked the user")) return forward(agent);
	if (text.includes("has been closed")) return taskClosed(agent, text);
	// Ahead of "Step 1 of": the advance message says "Step 1 of 2 completed".
	if (text.includes("Proceeding to the next step"))
		return startTasks(agent, text);
	if (text.includes("Step 1 of")) return plan(agent, text);
	agent.say("Noted.");
}

// --- the tasks ---------------------------------------------------------------------

const PASSING_TESTS = `
 RUN  v4.0.8 /home/demo/tidy

 ✓ src/lib/sort.test.ts (5 tests) 5ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  398ms`.trim();

const SORT_REPLY = `Overdue todos are flagged and the list is ordered by due date, with **undated todos after dated ones** as you chose.

- \`sortTodos\` puts the soonest due date first, undated next, done todos last.
- A row shows *Today*, a date, or **Overdue · May 10** in red.
- Four new tests cover the order and the overdue rule — all 5 pass.`;

async function store(agent, text) {
	await agent.gate("go-store");
	await readWork(agent, text, "store");
	read(agent, "src/types.ts");
	read(agent, "src/api/todos.ts");
	agent.say("Adding an optional `due` date and a way to set it.");
	const [first, ...rest] = STORE_CHANGES;
	await change(agent, first, "resume-store");
	for (const c of rest) await change(agent, c);
	await report(
		agent,
		"Done. `Todo` has an optional `due` (YYYY-MM-DD); `addTodo(title, due?)` takes one and `setDue(id, due)` sets or clears it. Changed `src/types.ts` and `src/api/todos.ts`.",
	);
	agent.say(
		"`Todo` has an optional `due` (YYYY-MM-DD); `addTodo` takes one and `setDue` sets or clears it.",
	);
}

async function form(agent, text) {
	await agent.gate("go-form");
	await readWork(agent, text, "form");
	read(agent, "src/components/TodoForm.tsx");
	agent.say("A *Due date* chip beside the title, opening the native picker.");
	const [first, ...rest] = FORM_CHANGES;
	await change(agent, first, "resume-form");
	for (const c of rest) await change(agent, c);
	await report(
		agent,
		"Done. The form has a *Due date* chip that opens the system date picker and then shows the date it holds; `onAdd` passes it on. Changed `src/components/TodoForm.tsx`.",
	);
	agent.say(
		"The form has a *Due date* chip that opens the system date picker and then shows the date it holds.",
	);
}

/** Task 3's first turn: reads, then asks where undated todos go. */
async function sortAsk(agent, text) {
	await agent.gate("go-sort");
	await readWork(agent, text, "sort");
	agent.say("I'll read the current ordering and the row before changing them.");
	read(agent, "src/lib/sort.ts");
	const row = "src/components/TodoItem.tsx";
	const id = agent.call("Read", { file_path: join(agent.cwd, row) });
	await agent.gate("resume-sort", id);
	agent.result(id, numbered(FILES[row]));
	agent.say(
		"Todos are sorted done-last, oldest first. Due dates need one decision about todos that have none.",
	);
	await agent.ask([UNDATED]);
	agent.say("I'll carry on as soon as you pick one.");
}

/** Task 3's second turn, played by the answer: the change itself. */
async function sortBuild(agent) {
	agent.think(
		"Undated after dated. Compare done-ness, then due date with undated last, then createdAt so ties stay stable. The row needs the same 'today' as the sort, so export it from sort.ts.",
	);
	agent.say("Going with undated after dated. The ordering first.");
	const inLib = (c) => c.file.startsWith("src/lib/");
	for (const c of SORT_CHANGES.filter(inLib)) await change(agent, c);
	agent.tool(
		"Bash",
		{ command: "pnpm test src/lib", description: "Run the sort tests" },
		PASSING_TESTS,
	);
	agent.say("Now the badge on the row.");
	for (const c of SORT_CHANGES.filter((c) => !inLib(c))) await change(agent, c);
	await report(
		agent,
		"Done. The list is ordered by due date with undated todos last (the user's pick), done todos after both; a row shows *Today*, its date, or *Overdue · May 10*. Four new tests, all 5 passing. Changed `src/lib/sort.ts`, `src/lib/sort.test.ts` and `src/components/TodoItem.tsx`.",
	);
	agent.say(SORT_REPLY);
}

const TASKS = [
	{
		key: "store",
		title: "Store a due date on each todo",
		body: "Give each todo an optional due date (YYYY-MM-DD) in `src/types.ts`, and let `src/api/todos.ts` set and clear it.",
		play: store,
		usage: usage(6, 1_240, 15_600, 0.16),
	},
	{
		key: "form",
		title: "Date picker in the todo form",
		body: "Let `src/components/TodoForm.tsx` pick a due date for the todo it adds.",
		play: form,
		usage: usage(5, 1_610, 14_900, 0.19),
	},
	{
		key: "sort",
		title: "Sort and highlight overdue todos",
		body: "Order the list by due date in `src/lib/sort.ts`, with tests, and make overdue todos stand out in `src/components/TodoItem.tsx`.",
		play: sortAsk,
		usage: usage(6, 980, 17_200, 0.12),
	},
];

/** The tasks' keys, in the order they are planned and started. */
export const TASK_KEYS = TASKS.map((t) => t.key);

/**
 * Keyed for scenes.mjs and the fake CLI alike, the story first: the message
 * passing task 3's question up quotes it, and the first scenario whose `prompt`
 * a message contains is the one that plays it.
 */
export const MARKETING = {
	story: {
		prompt: workContext(STORY.title),
		play: coordinate,
		usage: usage(4, 640, 12_800, 0.07),
	},
	...Object.fromEntries(
		TASKS.map((task) => [
			task.key,
			{ ...task, prompt: workContext(task.title) },
		]),
	),
	// Task 3's second turn, played by the answer: the message an answer arrives
	// as quotes its question. Only in task 3's conversation — the coordinator
	// asked the user the same question, and an answer to its copy is not this.
	sortBuild: {
		prompt: UNDATED.question,
		follows: "sort",
		play: sortBuild,
		usage: usage(14, 6_920, 41_380, 0.74),
	},
};
