/**
 * What one streamed record costs the chat while a long session is loaded.
 * Run with `vitest.bench.config.ts` (the command and its knobs are there); the
 * numbers go to the console and to `bench-results/<label>.json`.
 *
 * Three measurements, all in real Chromium:
 *
 * - Per record, through the real `useChatMessages` and `MessageList` (and the
 *   attention strip, and optionally a subagent's transcript, as `ChatPanel`
 *   draws them): the wall time from the record arriving to its commit being
 *   laid out, and React's own render time per component, read off the fibers.
 *   Each is taken over the long session and over the same open turn with no
 *   history before it — the difference is what loaded history costs.
 * - Per transcript-wide derivation, over the loaded messages: what each pass
 *   that runs on every record costs on its own.
 * - Per older page (`pages back`, results in `<label>-paging.json`): the
 *   session cut into the server's 50-record pages, the newest mounted, and
 *   each older page timed from its answer to the commit that drew it being
 *   laid out — what paging back costs as the loaded transcript grows.
 *
 * React is its development build unless the bench is run with
 * `BENCH_REACT=production` (see the config); a development build's render
 * and context-propagation times are several times production's, the
 * derivations' are not. The results say which build they were taken on.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profiler, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import AttentionStrip from "../components/Chat/AttentionStrip";
import MessageList from "../components/Chat/MessageList";
import { SubagentTranscript } from "../components/Chat/SubagentTranscript";
import { useChatMessages } from "../hooks/useChatMessages";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import { liveResumes } from "../lib/subagentRun";
import { loadedStopTargets } from "../lib/taskStop";
import { openAssistantIndex } from "../lib/transcript";
import { findLoadedRun } from "../lib/transcriptMemo";
import {
	backgroundTaskRuns,
	currentPlan,
	isTurnOpen,
	openTurnReplyIds,
	overviewMessageId,
	topLevelAgentRuns,
} from "../lib/turnOverview";
import {
	answerPageRequest,
	resetChatHistoryServer,
	streamUpdates,
} from "../test/chatHistoryServer";
import { makeSessionDetail } from "../test/sessionFixtures";
import type { ChatNotification, ChatPage } from "../types/chatItems";
import type { Message, SessionTurn } from "../types/message";
import { refusalAccounts } from "../utils/cliRefusal";
import { discardedMessages } from "../utils/discardedMessage";
import { reactBuild, startRecording, stopRecording } from "./commitProfiler";
import {
	type FunctionCost,
	setCpuThrottle,
	startProfile,
	stopProfile,
} from "./cpuProfile";
import {
	DEFAULT_LONG_SESSION,
	type LongSession,
	liveRecords,
	longSession,
	pagedSession,
} from "./longSession";
import { startTrace, stopTrace, type TraceCost } from "./trace";

vi.mock("../lib/wsStore", async (importOriginal) =>
	(await import("../test/chatHistoryServer")).stubChatHistoryRpc(
		await importOriginal<typeof import("../lib/wsStore")>(),
	),
);

declare const __BENCH__: {
	cpuThrottle: number;
	turns: number;
	events: number;
	label: string;
	trace: boolean;
	css: string;
	longOnly: boolean;
	pages: number;
};
const BENCH = __BENCH__;

// Records are applied with `flushSync`, not `act`: production React has no
// `act`, and the bench runs on either build.
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = false;

const SESSION_ID = "bench";
const WARMUP = 10;
const noop = () => {};

/** The newest messages the harness rendered, for the derivation pass. */
let rendered: Message[] = [];
/** React's own render time, every commit, summed. */
let reactMs = 0;
/** The harness's chat, for the paging pass to ask for older pages. */
let chatOf: ReturnType<typeof useChatMessages> | undefined;
/** Called once a commit has laid out a page more than the last. */
let onPageLanded: ((pages: number) => void) | undefined;

function Harness({ transcriptOf }: { transcriptOf?: string }) {
	const chat = useChatMessages({ sessionId: SESSION_ID });
	const turn = useSessionDetailStore((s) => s.detail?.turn);
	rendered = chat.messages;
	chatOf = chat;
	const pages = chat.loadedHistoryPages;
	useLayoutEffect(() => onPageLanded?.(pages), [pages]);
	return (
		<Profiler
			id="chat"
			onRender={(_id, _phase, actual) => {
				reactMs += actual;
			}}
		>
			<div className="flex flex-col" style={{ height: 844, width: 390 }}>
				<MessageList
					sessionId={SESSION_ID}
					messages={chat.messages}
					hasMoreHistory={chat.hasMoreHistory}
					isLoadingMoreHistory={chat.isLoadingMoreHistory}
					historyError={chat.historyError}
					loadedHistoryPages={chat.loadedHistoryPages}
					onLoadMoreHistory={chat.loadMoreHistory}
					tail={chat.tail}
					openedThoughtIds={chat.openedThoughtIds}
				/>
				{turn && (
					<AttentionStrip
						turn={turn}
						messages={chat.messages}
						onJumpToRequest={noop}
						onJumpToCall={noop}
						onOpenTranscript={noop}
					/>
				)}
				{transcriptOf && (
					<SubagentTranscript
						messages={chat.messages}
						path={[transcriptOf]}
						onPathChange={noop}
						escapeHeld={false}
						partProps={{ sessionId: SESSION_ID }}
					/>
				)}
			</div>
		</Profiler>
	);
}

function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settle() {
	for (let i = 0; i < 3; i++) await nextFrame();
}

function openTurn(background: boolean): SessionTurn {
	const since = new Date().toISOString();
	return background
		? {
				phase: "blocked",
				open: true,
				since,
				blockers: [{ kind: "background", raised_at: since }],
			}
		: { phase: "running", open: true, since };
}

async function mount(
	session: LongSession,
	background: boolean,
	transcript: boolean,
	pages: ChatPage[] = [session.page],
) {
	resetChatHistoryServer(pages);
	useSessionDetailStore
		.getState()
		.setDetail(
			SESSION_ID,
			makeSessionDetail({ id: SESSION_ID, turn: openTurn(background) }),
		);
	const started = performance.now();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	root.render(
		<QueryClientProvider client={new QueryClient()}>
			<Harness transcriptOf={transcript ? session.liveAgentId : undefined} />
		</QueryClientProvider>,
	);
	await vi.waitFor(
		() => expect(container.querySelector("[data-message-id]")).not.toBeNull(),
		{ timeout: 600_000, interval: 50 },
	);
	await settle();
	const unmount = () => {
		root.unmount();
		container.remove();
	};
	return { unmount, mountMs: performance.now() - started };
}

interface Sample {
	wallMs: number[];
	reactMs: number;
	commits: number;
	components: { name: string; renders: number; selfMs: number }[];
	/** Per record, from a second, profiled pass. */
	functions: FunctionCost[];
	/** Per record, from a third, traced pass; only with `BENCH_TRACE`. */
	trace?: TraceCost[];
}

const quantile = (values: number[], q: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/**
 * Streams `count` records from `next`, one per frame, as they arrive live.
 * The wall time is the record's own synchronous path — reducer, render,
 * commit, effects, and the layout they force — and React's render time also
 * takes in whatever the observers set off in the frames after it.
 */
async function stream(
	next: () => ChatNotification,
	count: number,
): Promise<Sample> {
	for (let i = 0; i < WARMUP; i++) {
		flushSync(() => streamUpdates([next()]));
		await settle();
	}
	const wallMs: number[] = [];
	reactMs = 0;
	startRecording();
	for (let i = 0; i < count; i++) {
		const record = next();
		const started = performance.now();
		flushSync(() => streamUpdates([record]));
		document.body.getBoundingClientRect();
		wallMs.push(performance.now() - started);
		await settle();
	}
	const { commits, costs } = stopRecording();
	const renderMs = reactMs / count;

	// Apart from the timed pass: the profiler slows what it samples.
	await startProfile();
	for (let i = 0; i < count; i++) {
		flushSync(() => streamUpdates([next()]));
		document.body.getBoundingClientRect();
		await settle();
	}
	const functions = (await stopProfile()).map((cost) => ({
		key: cost.key,
		selfMs: cost.selfMs / count,
		totalMs: cost.totalMs / count,
	}));

	let trace: TraceCost[] | undefined;
	if (BENCH.trace) {
		await startTrace();
		for (let i = 0; i < count; i++) {
			flushSync(() => streamUpdates([next()]));
			document.body.getBoundingClientRect();
			await settle();
		}
		trace = await stopTrace(count);
	}
	return {
		functions,
		trace,
		wallMs,
		reactMs: renderMs,
		commits: commits / count,
		components: [...costs]
			.map(([name, cost]) => ({
				name,
				renders: cost.renders / count,
				selfMs: cost.selfMs / count,
			}))
			.sort((a, b) => b.selfMs - a.selfMs),
	};
}

/** Alternates a pair's two updates, so calls and results are both sampled. */
function alternating(pair: () => ChatNotification[]) {
	let held: ChatNotification[] = [];
	return () => {
		if (held.length === 0) held = pair();
		return held.shift() as ChatNotification;
	};
}

interface Case {
	name: string;
	background?: boolean;
	transcript?: boolean;
	records: (live: ReturnType<typeof liveRecords>) => () => ChatNotification;
}

const CASES: Case[] = [
	{ name: "text", records: (live) => live.text },
	{
		name: "top-level tool event",
		records: (live) => alternating(live.topLevelCall),
	},
	{
		name: "subagent child event",
		records: (live) => alternating(live.childCall),
	},
	{ name: "subagent child text", records: (live) => live.childText },
	{
		name: "subagent child event, transcript open",
		transcript: true,
		records: (live) => alternating(live.childCall),
	},
	{
		name: "background subagent child event, strip up",
		background: true,
		records: (live) => alternating(live.childCall),
	},
];

/**
 * Per-record time of every transcript-wide pass, over `messages` as a record
 * leaves it: a new array with the open reply a new object, and every other
 * message the same one — so a pass memoized per message (`transcriptMemo`)
 * is timed re-reading the one message a record changed, not answering from
 * its cache.
 */
function derivations(source: Message[], liveAgentId: string) {
	const turnOpen = true;
	const open = openAssistantIndex(source);
	const afterRecord = () => {
		const next = [...source];
		next[open] = { ...next[open] } as Message;
		return next;
	};
	let messages = source;
	const passes: Record<string, () => unknown> = {
		"liveResumes (once per record: MessageList, useAgentsOverview, SubagentTranscript share it)":
			() => liveResumes(messages),
		"loadedStopTargets (MessageList)": () => loadedStopTargets(messages),
		"discardedMessages (MessageList)": () => discardedMessages(messages),
		"topLevelAgentRuns (useAgentsOverview)": () => topLevelAgentRuns(messages),
		"currentPlan (useTurnOverview)": () => currentPlan(messages, turnOpen),
		"backgroundTaskRuns (AttentionStrip, background only)": () =>
			backgroundTaskRuns(messages),
		"refusalAccounts (ChatPanel)": () => refusalAccounts(messages),
		"openAssistantIndex (runs ×3: MessageList, useChatMessages, turnOverview)":
			() => openAssistantIndex(messages),
		isTurnOpen: () => isTurnOpen(messages, "running"),
		openTurnReplyIds: () => openTurnReplyIds(messages, turnOpen),
		overviewMessageId: () => overviewMessageId(messages, turnOpen, true),
		"findLoadedRun (SubagentTranscript)": () =>
			findLoadedRun(messages, liveAgentId),
	};
	const result: Record<string, number> = {};
	for (const [name, pass] of Object.entries(passes)) {
		for (let i = 0; i < 5; i++) {
			messages = afterRecord();
			pass();
		}
		// Batches of runs: the clock is coarsened to 0.1ms in the test frame,
		// which is about what one pass costs.
		const BATCH = 20;
		const times: number[] = [];
		for (let i = 0; i < 15; i++) {
			const batch = Array.from({ length: BATCH }, afterRecord);
			const started = performance.now();
			for (const next of batch) {
				messages = next;
				pass();
			}
			times.push((performance.now() - started) / BATCH);
		}
		result[name] = quantile(times, 0.5);
	}
	return result;
}

const fmt = (ms: number) => ms.toFixed(2);

/** Functions the profile table always lists, whether or not they are on top. */
const WATCHED = [
	"applyUpdate",
	"buildTranscript",
	"handleNotification",
	"useSubagentResumesValue",
	"useStopTargetsValue",
	"useDiscardedMessagesValue",
	"useAgentsOverview",
	"useTurnOverview",
	"liveResumes",
	"loadedStopTargets",
	"discardedMessages",
	"topLevelAgentRuns",
	"currentPlan",
	"openTurnReplyIds",
	"overviewMessageId",
	"refusalAccounts",
	"FittedLine",
	"TurnEnd",
	"MessageList",
	"useTranscriptScroll",
	"useMessagesTail",
	"getBoundingClientRect",
	"commitRoot",
	"performWorkOnRoot",
	"renderRootSync",
	"commitLayoutEffects",
	"commitPassiveMountEffects",
	"(garbage collector)",
];

describe("streaming cost", () => {
	it("measures", async () => {
		if (BENCH.css) {
			const style = document.createElement("style");
			style.textContent = BENCH.css;
			document.head.append(style);
		}
		if (BENCH.cpuThrottle > 1) {
			await setCpuThrottle(BENCH.cpuThrottle);
		}
		const results: Record<string, unknown> = {
			bench: BENCH,
			react: reactBuild(),
			cases: {},
		};
		const lines: string[] = [];
		const log = (line = "") => lines.push(line);
		log(
			`React ${reactBuild()} build · CPU throttle ×${BENCH.cpuThrottle} · ${BENCH.events} records per case`,
		);
		log();

		for (const turns of BENCH.longOnly ? [BENCH.turns] : [0, BENCH.turns]) {
			for (const c of CASES) {
				const session = longSession({
					...DEFAULT_LONG_SESSION,
					turns,
					background: c.background ?? false,
				});
				const { unmount, mountMs } = await mount(
					session,
					c.background ?? false,
					c.transcript ?? false,
				);
				const sample = await stream(
					c.records(liveRecords(session)),
					BENCH.events,
				);
				const key = `${c.name} @ ${turns} turns`;
				(results.cases as Record<string, unknown>)[key] = {
					toolCalls: session.toolCalls,
					messages: rendered.length,
					mountMs,
					...sample,
				};
				log(
					`### ${key} — ${session.toolCalls} calls, ${rendered.length} messages, mount ${fmt(mountMs)}ms`,
				);
				log(
					`wall p50 ${fmt(quantile(sample.wallMs, 0.5))}ms · p95 ${fmt(quantile(sample.wallMs, 0.95))}ms · React render ${fmt(sample.reactMs)}ms/record · ${sample.commits.toFixed(1)} commits/record`,
				);
				log("| component | renders/record | self ms/record |");
				log("|---|---:|---:|");
				for (const cost of sample.components.slice(0, 15)) {
					log(
						`| ${cost.name} | ${cost.renders.toFixed(1)} | ${fmt(cost.selfMs)} |`,
					);
				}
				log();
				log("| function (CPU profile) | self ms/record | total ms/record |");
				log("|---|---:|---:|");
				const shown = new Set<string>();
				for (const cost of [...sample.functions]
					.filter((f) => f.key !== "(idle)")
					.sort((a, b) => b.selfMs - a.selfMs)
					.slice(0, 20)) {
					shown.add(cost.key);
					log(`| ${cost.key} | ${fmt(cost.selfMs)} | ${fmt(cost.totalMs)} |`);
				}
				for (const cost of sample.functions
					.filter(
						(f) =>
							!shown.has(f.key) &&
							WATCHED.some((name) => f.key.startsWith(`${name} `)),
					)
					.sort((a, b) => b.totalMs - a.totalMs)) {
					log(`| ${cost.key} | ${fmt(cost.selfMs)} | ${fmt(cost.totalMs)} |`);
				}
				log();
				if (sample.trace) {
					log(
						"| trace event | ms/record | events/record | layout dirty / total objects | styled elements |",
					);
					log("|---|---:|---:|---:|---:|");
					for (const cost of sample.trace.slice(0, 15)) {
						const objects =
							cost.totalObjects !== undefined
								? `${cost.dirtyObjects ?? "?"} / ${cost.totalObjects}`
								: "";
						log(
							`| ${cost.name} | ${fmt(cost.ms)} | ${cost.count.toFixed(1)} | ${objects} | ${cost.elementCount ?? ""} |`,
						);
					}
					log();
				}

				if (turns > 0 && c === CASES[0]) {
					const passes = derivations(rendered, session.liveAgentId);
					results.derivations = passes;
					log(
						`### transcript-wide passes over ${session.toolCalls} calls (median ms per pass)`,
					);
					log("| pass | ms |");
					log("|---|---:|");
					for (const [name, ms] of Object.entries(passes)) {
						log(`| ${name} | ${ms.toFixed(3)} |`);
					}
					log();
				}
				unmount();
				useSessionDetailStore.getState().clear();
			}
		}

		console.info(lines.join("\n"));
		await commands.writeFile(
			`bench-results/${BENCH.label}.json`,
			JSON.stringify(results, null, 2),
		);
		await commands.writeFile(
			`bench-results/${BENCH.label}.md`,
			lines.join("\n"),
		);
	});

	it("pages back", async () => {
		if (BENCH.cpuThrottle > 1) await setCpuThrottle(BENCH.cpuThrottle);
		const session = longSession({
			...DEFAULT_LONG_SESSION,
			turns: BENCH.turns,
		});
		const pages = pagedSession(session);
		const { unmount, mountMs } = await mount(session, false, false, pages);
		const times: number[] = [];
		let reactTotal = 0;
		for (let i = 0; i < BENCH.pages && chatOf?.hasMoreHistory; i++) {
			const chat = chatOf;
			flushSync(() => {
				void chat.loadMoreHistory();
			});
			await settle();
			const landed = new Promise<void>((resolve) => {
				onPageLanded = (n) => {
					if (n > i) resolve();
				};
			});
			reactMs = 0;
			const started = performance.now();
			if (!answerPageRequest()) throw new Error("no page request in flight");
			await landed;
			document.body.getBoundingClientRect();
			times.push(performance.now() - started);
			await settle();
			reactTotal += reactMs;
		}
		onPageLanded = undefined;
		const lines: string[] = [
			`### paging back — ${session.toolCalls} calls, ${pages.length} pages of 50 records, React ${reactBuild()}`,
			`mount of the newest page ${fmt(mountMs)}ms · ${times.length} pages paged · ${rendered.length} messages at the end · React render ${fmt(reactTotal / times.length)}ms/page`,
			"| pages | p50 ms/page | p95 ms/page |",
			"|---|---:|---:|",
		];
		const BUCKET = 50;
		for (let b = 0; b < times.length; b += BUCKET) {
			const slice = times.slice(b, b + BUCKET);
			lines.push(
				`| ${b + 1}–${b + slice.length} | ${fmt(quantile(slice, 0.5))} | ${fmt(quantile(slice, 0.95))} |`,
			);
		}
		console.info(lines.join("\n"));
		await commands.writeFile(
			`bench-results/${BENCH.label}-paging.json`,
			JSON.stringify(
				{ bench: BENCH, react: reactBuild(), mountMs, times },
				null,
				2,
			),
		);
		await commands.writeFile(
			`bench-results/${BENCH.label}-paging.md`,
			lines.join("\n"),
		);
		unmount();
		useSessionDetailStore.getState().clear();
	});
});
