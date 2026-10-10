// Pockode at work on tidy, a small todo app, for the README and pockode.com:
// the raw captures docs/marketing-assets.md frames — a story and its three
// tasks on the project screen, their agents working at once, an agent asking
// and the answer picked on a phone, a turn of tool calls and the changes it
// made, the diff, a dev server opened through Port Preview, a commit, and the
// desktop layout. A suite for ../shoot.mjs;
// see the README beside it.
//
// Every shot is the same, byte for byte, from one run to the next; the README
// lists what pins each source of difference. The scenes run one at a time, in
// order, through four states the shared steps reach at most once each: setup
// leaves all three tasks running; `shared.ask` lets the third on until it has
// asked its question, the other two still running; `shared.release` lets those
// two finish; `shared.answer` answers the question and lets the story finish.
// A scene takes the step it needs first, so a scene taken alone finds the app
// as it would after the whole run. Scene names are kept apart from the other
// suites' (no `chat`, no `question`), since a filter is a substring.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_URL, mcp, scrollIntoView, settle } from "../harness.mjs";
import { MARKETING, ROLES, STORY, TASK_KEYS, UNDATED } from "./scenarios.mjs";

const CLOCK = process.env.WALKTHROUGH_CLOCK;
const PROJECT_DIR = process.env.WALKTHROUGH_PROJECT_DIR;
const NODE_MODULES = process.env.WALKTHROUGH_NODE_MODULES;
// Where the fake CLI's agents hold until let on (../fake-cli/claude.mjs): in
// the server's data directory, which only a run with a server has.
const gates = () => join(process.env.WALKTHROUGH_DATA_DIR, "walkthrough-gates");
const PHONE = ["390x804"];
const DESKTOP = ["desktop@2x"];
const PREVIEWED = ["390x760"];

// What the app is told it is reachable at (§8.4): it offers Port Preview only
// with a relay address, and the walkthrough runs without a relay. The port is
// the one the storyboard types; tidy's dev server (devserver.mjs) is really on
// WALKTHROUGH_DEV_SERVER_PORT, and the tab the sheet opens is routed there.
const REMOTE_URL = "https://your-pc.cloud.pockode.com";
const PREVIEW_PORT = 5173;
export const PREVIEW_URL = `https://your-pc-${PREVIEW_PORT}.cloud.pockode.com/`;
const DEV_SERVER_URL = `http://localhost:${process.env.WALKTHROUGH_DEV_SERVER_PORT}/`;
// What the tab Open makes logs in with (docs/port-preview.md#logging-in). The
// server issues tickets only with a relay up, so the suite hands this one out
// itself. The path is web/src/lib/portPreview.ts's TICKET_LOGIN_PATH.
const PREVIEW_TICKET = "walkthrough";
const PREVIEW_LOGIN = `${PREVIEW_URL}__pockode/preview/login?`;
const PREVIEW_LOGIN_URL = `${PREVIEW_LOGIN}ticket=${PREVIEW_TICKET}`;

const COMMIT_MESSAGE = "Add due dates to todos";
const DIFF_FILE = "src/components/TodoItem.tsx";

// What every duration the server measured reads as. It times thinking itself,
// and a fake that thinks for no time at all reads as one second or two
// depending on how busy the machine was; an open turn's age would count up.
const DURATION_MS = 4_000;
const DURATION_KEYS = new Set(["duration_ms", "open_elapsed_ms"]);

// --- server side ------------------------------------------------------------

let watch = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns something truthy, and returns that. */
async function until(what, check) {
	for (let i = 0; i < 600; i++) {
		const value = await check();
		if (value) return value;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${what}; see the suite's server.log`);
}

/** A session's detail as the server holds it now. */
async function detail(rpc, sessionId) {
	const id = `marketing-${++watch}`;
	const { session } = await rpc.call("session.detail.subscribe", {
		id,
		session_id: sessionId,
	});
	await rpc.call("session.detail.unsubscribe", { id });
	return session;
}

/** A session's transcript records as the server holds them now. */
async function history(rpc, sessionId) {
	const id = `marketing-${++watch}`;
	const result = await rpc.call("chat.messages.subscribe", {
		id,
		session_id: sessionId,
	});
	await rpc.call("chat.messages.unsubscribe", { id });
	return result.history;
}

/** A work item's detail: the item, its comments, children and questions. */
async function work(rpc, workId) {
	const id = `marketing-${++watch}`;
	const result = await rpc.call("work.detail.subscribe", {
		id,
		work_id: workId,
	});
	await rpc.call("work.detail.unsubscribe", { id });
	return result;
}

/** The session's turn, once it has ended. */
async function untilIdle(rpc, sessionId) {
	return until(`session ${sessionId} to go idle`, async () => {
		const { turn } = await detail(rpc, sessionId);
		return turn.phase === "idle" && !turn.open && turn;
	});
}

/** Lets an agent held at `name` on (../fake-cli/claude.mjs `gate`). */
function open(name) {
	mkdirSync(gates(), { recursive: true });
	writeFileSync(join(gates(), name), "");
}

/**
 * Until the agent of `sessionId` is held at `name` and the server has every
 * frame it wrote before — the last of them the call it holds running.
 */
async function untilParked(rpc, sessionId, name) {
	const parked = join(gates(), `${name}.parked`);
	await until(`an agent to reach ${name}`, () => existsSync(parked));
	const pending = readFileSync(parked, "utf8");
	await until(`${name}'s running call to reach the server`, async () => {
		const last = (await history(rpc, sessionId)).at(-1);
		return last?.type === "tool_call" && last.tool_use_id === pending;
	});
}

/**
 * Fails the run if the question lost its race with its own call. The page
 * joins a question to its `question_post` row by where the server recorded
 * it — after the call — and the fake can only make that likely, not certain
 * (../fake-cli/claude.mjs): lost, the question is drawn as two rows, and the
 * shots would differ from the last run's without a word.
 */
async function expectOneQuestionCard(rpc, sessionId) {
	const types = (await history(rpc, sessionId)).map((record) =>
		record.type === "tool_call" && record.tool_name.endsWith("question_post")
			? "call"
			: record.type,
	);
	if (!types.includes("question_posted"))
		throw new Error("the sort chat's history has no question_posted record");
	if (types.indexOf("question_posted") < types.indexOf("call"))
		throw new Error(
			"the sort chat's question was recorded before its question_post call; run again",
		);
}

const git = (...args) =>
	execFileSync("git", args, { cwd: PROJECT_DIR, encoding: "utf8" }).trim();

// --- browser side -----------------------------------------------------------

/**
 * Every server timestamp a page is sent, as the run's clock, and every
 * duration the server measured, as DURATION_MS. The server stamps sessions,
 * questions and turns with the time it really is; the page shows them as
 * times of day and ages, against a clock pinned to the same instant. An empty
 * or zero time is left alone: it means "never", which the clock would not.
 * With `remoteUrl`, the auth reply also carries it, as a server with a relay
 * would send it.
 */
const isTime = (key, value) =>
	(key.endsWith("_at") || key === "since") &&
	typeof value === "string" &&
	Date.parse(value) > 0;

function pinFrame(message, remoteUrl) {
	if (typeof message !== "string") return message;
	let frame;
	try {
		frame = JSON.parse(message);
	} catch {
		return message;
	}
	const walk = (value) => {
		if (Array.isArray(value)) return value.map(walk);
		if (!value || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, v]) => [
				key,
				isTime(key, v)
					? CLOCK
					: DURATION_KEYS.has(key) && typeof v === "number"
						? DURATION_MS
						: walk(v),
			]),
		);
	};
	const pinned = walk(frame);
	if (remoteUrl && typeof pinned.result?.remote_url === "string")
		pinned.result.remote_url = remoteUrl;
	return JSON.stringify(pinned);
}

/** The reply to a `port_preview.ticket` request, or null for any other frame. */
function ticketReply(message) {
	if (typeof message !== "string") return null;
	let frame;
	try {
		frame = JSON.parse(message);
	} catch {
		return null;
	}
	if (frame.method !== "port_preview.ticket") return null;
	return JSON.stringify({
		jsonrpc: "2.0",
		id: frame.id,
		result: { ticket: PREVIEW_TICKET },
	});
}

// The faces the app asks for first (`--font-sans` / `--font-mono`) and does
// not ship: without them a shot is in whatever system-ui is on the machine.
// Served from the pinned `geist` package run.sh installs, at a path of the
// app's own origin so the page may load them.
//
// One static file per weight the app and the templates use, not the variable
// font: drawn from the variable one, a context now and then — about one in
// twenty — antialiased its 600 and 700 glyphs a few levels differently from
// the rest, and every shot it took differed from the last run's.
const WEIGHTS = {
	400: "Regular",
	500: "Medium",
	600: "SemiBold",
	700: "Bold",
};
const FAMILIES = {
	Geist: ["geist", "geist-sans/Geist"],
	"Geist Mono": ["geist-mono", "geist-mono/GeistMono"],
};
const fontPath = (slug, weight) => `/__walkthrough/fonts/${slug}-${weight}.ttf`;
export const FONTS = Object.fromEntries(
	Object.values(FAMILIES).flatMap(([slug, file]) =>
		Object.entries(WEIGHTS).map(([weight, name]) => [
			fontPath(slug, weight),
			`geist/dist/fonts/${file}-${name}.ttf`,
		]),
	),
);
export const FONT_FACES = Object.entries(FAMILIES)
	.flatMap(([family, [slug]]) =>
		Object.keys(WEIGHTS).map(
			(weight) =>
				`@font-face { font-family: "${family}"; src: url(${fontPath(slug, weight)}); font-weight: ${weight}; }`,
		),
	)
	.join("\n");

/**
 * The first match on screen. A phone keeps the sidebar's session list in the
 * page while its drawer is shut, and the sessions there carry the works'
 * titles.
 */
export const shown = (page, text) =>
	page.getByText(text).filter({ visible: true }).first();

async function openChat(page, sessionId, ready) {
	await page.goto(`${BASE_URL}/s/${sessionId}`);
	await shown(page, ready).waitFor();
	await settle(page);
}

const option = (page, label) =>
	page
		.getByRole("dialog")
		.locator("[data-answer-block] label")
		.filter({ hasText: label })
		.first();

/** The Git tab, from the sidebar — a drawer on a phone, opened first. */
async function openGitPanel(page) {
	const open = page.getByRole("button", { name: "Open sidebar" });
	if (await open.isVisible()) await open.click();
	await page.getByRole("tab", { name: /^Git/ }).click();
	await settle(page);
}

/** A work's page, once its tasks are listed. */
async function openWork(page, workId) {
	await page.goto(`${BASE_URL}/works/${workId}`);
	await shown(page, MARKETING.sort.title).waitFor();
	await settle(page);
}

const SCENES = [
	{
		name: "project",
		viewports: PHONE,
		run: async ({ page, shot }) => {
			await page.goto(`${BASE_URL}/works`);
			await shown(page, STORY.title).waitFor();
			await settle(page);
			await shot("project");
		},
	},
	{
		name: "story",
		viewports: PHONE,
		run: async ({ page, shared, shot }) => {
			await openWork(page, shared.story);
			await shot("story");
		},
	},
	{
		// Storyboard shot 3 (docs/marketing-assets.md §4.4): the story with its
		// tasks running, then task 3's chat with a call still running.
		name: "parallel",
		viewports: DESKTOP,
		run: async ({ page, shared, shot }) => {
			await openWork(page, shared.story);
			// The sidebar's row: it is listed before the story's own.
			await shot("desktop-story", {
				tap: shown(page, MARKETING.sort.title),
			});
			await openChat(page, shared.sort, "I'll read the current ordering");
			await shot("desktop-task");
		},
	},
	{
		// §7's phone-story: the third task waiting on its question while the
		// other two are still at work.
		name: "asking",
		viewports: PHONE,
		run: async ({ page, shared, shot }) => {
			await shared.ask();
			await openWork(page, shared.story);
			await shown(page, "1 to answer").waitFor();
			await shot("story-asking");
		},
	},
	{
		name: "answer",
		viewports: PHONE,
		run: async ({ page, shared, shot }) => {
			await shared.release();
			const recommended = option(page, UNDATED.options[0].label);
			await page.goto(`${BASE_URL}/s/${shared.sort}`);
			await recommended.waitFor();
			await settle(page);
			await shot("question", { tap: recommended });
			await recommended.click();
			await settle(page);
			await shot("question-picked", {
				tap: page.getByRole("dialog").getByRole("button", { name: "Send" }),
			});
		},
	},
	{
		name: "transcript",
		viewports: PHONE,
		run: async ({ page, shared, shot }) => {
			await shared.answer();
			await openChat(page, shared.sort, /\d+ files changed/);
			await scrollIntoView(shown(page, "I'll read the current ordering"));
			await shot("chat-question");
			// One group open, so the calls themselves are on screen.
			await page
				.locator("button[aria-expanded]")
				.filter({ hasText: /^Edited 2 files/ })
				.first()
				.click();
			await settle(page);
			await scrollIntoView(shown(page, "Going with undated after dated."));
			await shot("chat-tools");
			await scrollIntoView(shown(page, /\d+ files changed/));
			await shot("chat-changes", {
				// The card's row: the turn's own Edit row names the file too, and
				// the row's spoken label ("… in src/components") is not the name.
				tap: page
					.getByRole("group", { name: /\d+ files changed/ })
					.last()
					.getByText("TodoItem.tsx", { exact: true }),
			});
		},
	},
	{
		name: "diff",
		viewports: PHONE,
		run: async ({ page, shared, shot }) => {
			await shared.answer();
			await page.goto(`${BASE_URL}/unstaged/${DIFF_FILE}`);
			await shown(page, "dueLabel").waitFor();
			await settle(page);
			await shot("diff");
		},
	},
	{
		// Storyboard shot 6a: the Port Preview sheet with the port entered, then
		// Open — whose tab must land on the preview address and show tidy.
		name: "preview",
		viewports: PHONE,
		remoteUrl: REMOTE_URL,
		run: async ({ page, shared, shot }) => {
			await shared.answer();
			await openChat(page, shared.sort, /\d+ files changed/);
			await page.getByRole("button", { name: "Preview a port" }).click();
			const sheet = page.getByRole("dialog");
			await sheet.getByLabel("Port").fill(String(PREVIEW_PORT));
			await sheet.getByText(`Opens ${new URL(PREVIEW_URL).host}`).waitFor();
			await settle(page);
			const openButton = sheet.getByRole("button", { name: "Open" });
			await shot("preview-sheet", { tap: openButton });
			// The ticket's login, not the password-page fallback a failed
			// ticket request takes, which ends at the same address.
			const login = page
				.context()
				.waitForEvent("request", (r) => r.url() === PREVIEW_LOGIN_URL);
			const [tab] = await Promise.all([
				page.waitForEvent("popup"),
				openButton.click(),
			]);
			await login;
			await tab.getByText("Water the plants").waitFor();
			if (tab.url() !== PREVIEW_URL)
				throw new Error(`Open went to ${tab.url()}, not ${PREVIEW_URL}`);
		},
	},
	{
		// Storyboard shot 6b: the page that tab shows, opened from the dev server
		// directly — there is no relay to go through.
		name: "devserver",
		viewports: PREVIEWED,
		run: async ({ page, shot }) => {
			await page.goto(DEV_SERVER_URL);
			await shown(page, "Water the plants").waitFor();
			await settle(page);
			await shot("preview-page");
		},
	},
	{
		name: "commit",
		viewports: PHONE,
		run: async ({ page, shared, shot }) => {
			await shared.answer();
			// It commits, so the commit is undone before and after, leaving the
			// tree as setup did.
			const undo = () => git("reset", "-q", "--mixed", shared.head);
			undo();
			try {
				await openChat(page, shared.sort, /\d+ files changed/);
				await openGitPanel(page);
				const stageAll = page.getByRole("button", { name: "Stage all files" });
				await stageAll.waitFor();
				await settle(page);
				await shot("git-changes");
				await stageAll.click();
				const commit = page.getByRole("button", { name: /^Commit \(\d+\)$/ });
				await commit.waitFor();
				await commit.click();
				// On a phone the sidebar it was opened from is a dialog too.
				const sheet = page
					.getByRole("dialog")
					.filter({ has: page.locator("textarea") });
				await sheet.locator("textarea").fill(COMMIT_MESSAGE);
				await settle(page);
				const commitButton = sheet.getByRole("button", {
					name: "Commit",
					exact: true,
				});
				await shot("commit-sheet", { tap: commitButton });
				await commitButton.click();
				await sheet.waitFor({ state: "detached" });
				await shown(page, COMMIT_MESSAGE).waitFor();
				await settle(page);
				await shot("committed");
			} finally {
				undo();
			}
		},
	},
	{
		// The story once every task has closed: the reports its tasks left on it.
		name: "reports",
		viewports: PHONE,
		run: async ({ page, shared, shot }) => {
			await shared.answer();
			await openWork(page, shared.story);
			await scrollIntoView(shown(page, /^Comments \(\d+\)$/));
			await shot("story-reports");
		},
	},
	{
		name: "desktop",
		viewports: DESKTOP,
		run: async ({ page, shared, shot }) => {
			await shared.answer();
			await openChat(page, shared.sort, /\d+ files changed/);
			await shot("desktop-chat");
			await openGitPanel(page);
			await shown(page, "TodoItem.tsx").click();
			await shown(page, "dueLabel").waitFor();
			await settle(page);
			await shot("desktop-diff");
		},
	},
];

/**
 * The story, started as a person would start it, and left with all three of
 * its tasks running at once: the coordinator creates and starts them, and each
 * task's agent is let on to a running call in turn, so the order everything
 * happened in — which the sidebar and the list sort by — is the same every
 * run. `ask`, `release` and `answer` take it on from there (see the top of
 * this file); nothing is unread after any of them, so no scene's sidebar
 * depends on which chats another scene opened.
 */
async function setup({ rpc }) {
	await englishRoles(rpc);
	const [storyRole] = JSON.parse(
		await mcp("agent_role_list", { work_type: "story" }),
	);
	const created = await mcp("story_create", {
		...STORY,
		agent_role_id: storyRole.id,
	});
	const story = created.match(/\(ID: ([^)]+)\)/)[1];
	await mcp("story_start", { id: story });

	const { work: started, children } = await until(
		"the story to start its tasks",
		async () => {
			const item = await work(rpc, story);
			const done =
				item.work.wait === "child" &&
				item.children.length === TASK_KEYS.length &&
				item.children.every((c) => c.status === "active") &&
				(await detail(rpc, item.work.session_id)).turn.phase === "idle";
			return done && item;
		},
	);
	const shared = { story, storySession: started.session_id };
	for (const key of TASK_KEYS) {
		const task = children.find((c) => c.title === MARKETING[key].title);
		shared[key] = (await work(rpc, task.id)).work.session_id;
	}
	for (const key of TASK_KEYS) {
		open(`go-${key}`);
		await untilParked(rpc, shared[key], `resume-${key}`);
	}
	const sessions = [shared.storySession, ...TASK_KEYS.map((k) => shared[k])];
	const markRead = async () => {
		for (const id of sessions)
			await rpc.call("session.mark_read", { session_id: id });
	};
	await markRead();

	/** Until the story has heard of `n` closed tasks, and acted on it. */
	const untilStoryHeard = (n) =>
		until(`the story to hear of ${n} closed tasks`, async () => {
			const closed = (await history(rpc, shared.storySession)).filter(
				(r) => r.subtype === "child_done",
			);
			return (
				closed.length === n &&
				(await detail(rpc, shared.storySession)).turn.phase === "idle"
			);
		});

	// None of the steps below can be taken twice — a gate opened or a question
	// answered stays so — so a failure is kept, and every later scene fails at
	// once with the reason rather than a retry timing out on a state that has
	// already moved on.
	let asking;
	shared.ask = () => {
		asking ??= (async () => {
			open("resume-sort");
			await until("task 3's question to reach the story", async () => {
				const posted = (await untilIdle(rpc, shared.sort)).unanswered ?? [];
				const story = await work(rpc, shared.story);
				return (
					posted.length === 1 &&
					(story.pending_questions ?? []).length === 1 &&
					(await detail(rpc, shared.storySession)).turn.phase === "idle"
				);
			});
			await expectOneQuestionCard(rpc, shared.sort);
			await markRead();
		})();
		return asking;
	};

	let released;
	shared.release = () => {
		released ??= (async () => {
			await shared.ask();
			// One at a time, for the same reason setup let them on one at a time,
			// each finished — its own last word too — before the next moves.
			const finishing = TASK_KEYS.filter((key) => key !== "sort");
			for (const [i, key] of finishing.entries()) {
				open(`resume-${key}`);
				await untilIdle(rpc, shared[key]);
				await untilStoryHeard(i + 1);
			}
			await markRead();
		})();
		return released;
	};

	let answered;
	shared.answer = () => {
		answered ??= (async () => {
			await shared.release();
			const [asked] = (await untilIdle(rpc, shared.sort)).unanswered ?? [];
			if (!asked)
				throw new Error(
					"the sort task has no unanswered question; see its server.log",
				);
			await rpc.call("chat.message", {
				session_id: shared.sort,
				content: "",
				answering: [
					{ request_id: asked.request_id, answers: [UNDATED.options[0].label] },
				],
			});
			await untilIdle(rpc, shared.sort);
			await until("the story to close", async () => {
				const { work: item } = await work(rpc, shared.story);
				return (
					item.status === "closed" &&
					(await detail(rpc, shared.storySession)).turn.phase === "idle"
				);
			});
			await markRead();
		})();
		return answered;
	};
	shared.head = git("rev-parse", "HEAD");
	return shared;
}

/**
 * The default story role and the first task role, as ROLES has them: their
 * names are on every row, and their steps on the story's page.
 */
export async function englishRoles(rpc) {
	const roles = JSON.parse(await mcp("agent_role_list", {}));
	for (const type of ["story", "task"]) {
		const { id } = roles.find((r) => r.work_type === type);
		await rpc.call("agent_role.update", { id, ...ROLES[type] });
	}
}

export default {
	name: "marketing",
	dir: "marketing",
	// Minutes longer than every other suite together, and a dev server on a
	// port of its own: a plain `shoot` is for a design pass, and leaves it out.
	optIn: true,
	viewports: [...PHONE, ...PREVIEWED, ...DESKTOP],
	themes: ["abyss-dark"],
	serial: true,
	scenes: SCENES,
	setup,
	contextOptions: { locale: "en-US", timezoneId: "UTC" },
	// A colour still easing in — a dialog's, a tab's — is a few levels off in
	// one run and not the next; reduced motion does not stop CSS transitions.
	screenshotOptions: { animations: "disabled" },
	// A tile painted again in part — under the pointer, say — comes out with
	// its antialiasing a few levels off from one painted whole.
	browserArgs: ["--disable-partial-raster"],
	async prepare(context, scene) {
		await context.clock.setFixedTime(CLOCK);
		// The sidebar's "show task sessions" toggle (web/src/lib/sessionStore.ts):
		// off, it lists none of the four sessions this suite has, and the app
		// opens an empty chat of its own to have one.
		await context.addInitScript(() =>
			localStorage.setItem("show-task-sessions", "true"),
		);
		// What the app now offers to preview is answered by the dev server, so
		// nothing leaves the machine. Registered before the font routes, so that
		// theirs, added later and so tried first, still serve tidy's fonts.
		if (scene.remoteUrl)
			await context.route(`${PREVIEW_URL}**`, async (route) =>
				route.fulfill({
					response: await route.fetch({
						url: new URL(
							new URL(route.request().url()).pathname,
							DEV_SERVER_URL,
						).href,
					}),
				}),
			);
		// The host redeems a ticket by redirecting to its root
		// (server/relay/preview_auth.go's serveTicketLogin). Sent on by the page
		// rather than with a 303: a fulfilled redirect is followed past the
		// routes, out to the network. Added after the route above, so it is
		// tried first.
		if (scene.remoteUrl)
			await context.route(
				(url) => url.href.startsWith(PREVIEW_LOGIN),
				(route) =>
					route.fulfill({
						contentType: "text/html",
						body: `<script>location.replace(${JSON.stringify(PREVIEW_URL)})</script>`,
					}),
			);
		await context.routeWebSocket(/\/ws$/, (ws) => {
			const server = ws.connectToServer();
			ws.onMessage((message) => {
				const ticket = scene.remoteUrl && ticketReply(message);
				if (ticket) ws.send(ticket);
				else server.send(message);
			});
			server.onMessage((message) =>
				ws.send(pinFrame(message, scene.remoteUrl)),
			);
		});
		for (const [path, file] of Object.entries(FONTS)) {
			const body = readFileSync(join(NODE_MODULES, file));
			// On any origin: tidy's page is drawn in Geist too.
			await context.route(`**${path}`, (route) =>
				route.fulfill({ contentType: "font/ttf", body }),
			);
		}
		await context.addInitScript((css) => {
			document.addEventListener("DOMContentLoaded", () => {
				const style = document.createElement("style");
				style.textContent = css;
				document.head.append(style);
			});
		}, FONT_FACES);
	},
};
