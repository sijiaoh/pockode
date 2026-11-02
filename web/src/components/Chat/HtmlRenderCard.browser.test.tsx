import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { page } from "vitest/browser";
import {
	resetChatUIConfig,
	setChatUIConfig,
} from "../../lib/registries/chatUIRegistry";
import { renderTranscript } from "../../test/transcriptFixture";
import { FullScreenHost } from "./FullScreenHost";
import { HtmlRenderCard } from "./HtmlRenderCard";

vi.mock("../../lib/wsStore", async (importOriginal) =>
	(await import("../../test/chatHistoryServer")).stubChatHistoryRpc(
		await importOriginal<typeof import("../../lib/wsStore")>(),
	),
);

const TITLE = "Wide table";
const PROSE = "Here is the table you asked for.";
const WIDE_PX = 3000;

/**
 * How the page sees its own viewport, posted to the test whenever it changes:
 * whether it scrolls each way, and how far it is scrolled sideways.
 */
const REPORTER = `<script>function say(){parent.parent.postMessage({viewport:{x:document.documentElement.scrollWidth>document.documentElement.clientWidth,y:document.documentElement.scrollHeight>document.documentElement.clientHeight,scrollX:scrollX}},"*")}addEventListener("resize",say);addEventListener("scroll",say);addEventListener("message",function(e){if(e.data==="scroll-right"){scrollTo(500,0)}});addEventListener("load",say);</script>`;

/**
 * Taller than the card's placeholder, so the frame is sized after it loads.
 * The scrollbar is styled so that it takes room where the engine draws one:
 * WebKit does; headless Chromium hides scrollbars whatever their style, so
 * there the frame's height is the page's alone.
 */
const WIDE_PAGE = `<style>::-webkit-scrollbar{width:20px;height:20px;background:#ccc}</style><div style="width:${WIDE_PX}px;height:300px;background:linear-gradient(90deg,#eee,#999)">wide</div>${REPORTER}`;

interface Viewport {
	x: boolean;
	y: boolean;
	scrollX: number;
}

/**
 * Each report with the window it came from: the card's page stays mounted
 * under the full-screen view, so a report says nothing of the page it is
 * about without its source.
 */
let reports: { source: MessageEventSource | null; viewport: Viewport }[] = [];
function onReport(event: MessageEvent) {
	const data: unknown = event.data;
	if (data && typeof data === "object" && "viewport" in data) {
		reports.push({ source: event.source, viewport: data.viewport as Viewport });
	}
}
const lastReport = (from?: Window | null) =>
	reports.filter((report) => !from || report.source === from).at(-1)?.viewport;

beforeAll(() => window.addEventListener("message", onReport));
afterAll(() => window.removeEventListener("message", onReport));
beforeEach(() => {
	reports = [];
});

function pageRecords(html: string): unknown[][] {
	return [
		[
			{ type: "message", content: "Show me the table" },
			{ type: "text", content: PROSE },
			{
				type: "tool_call",
				tool_use_id: "page-1",
				tool_name: "mcp__pockode__html_render",
				tool_input: { title: TITLE, html },
			},
			{ type: "tool_result", tool_use_id: "page-1", tool_result: "p1" },
			{ type: "done" },
		],
	];
}

const card = () => screen.getByRole("region", { name: TITLE });
const pageFrame = () =>
	card().querySelector("iframe")?.contentWindow?.frames[0] ?? null;

describe("an HTML card in the transcript", () => {
	beforeEach(async () => {
		await page.viewport(1600, 900);
	});
	afterEach(async () => {
		await page.viewport(414, 896);
	});

	it("takes the transcript's width up to its cap, centered, while prose keeps the column", async () => {
		const { scroller } = await renderTranscript({
			pages: pageRecords("<p>narrow</p>"),
			width: 1600,
		});
		const pane = scroller.getBoundingClientRect();
		const box = card().getBoundingClientRect();

		expect(box.width).toBe(1280);
		const center = pane.left + scroller.clientWidth / 2;
		expect(Math.abs(box.left + box.width / 2 - center)).toBeLessThanOrEqual(1);
		// The reading column: `max-w-3xl` inside the track's `sm:px-4`.
		expect(screen.getByText(PROSE).getBoundingClientRect().width).toBe(736);
	});

	it("stays in the column beside an extension's avatar, which it would cover", async () => {
		setChatUIConfig({
			AssistantAvatar: ({ className }) => (
				<div className={className} data-testid="avatar" />
			),
		});
		try {
			await renderTranscript({
				pages: pageRecords("<p>narrow</p>"),
				width: 1600,
			});
			const avatar = screen.getByTestId("avatar").getBoundingClientRect();
			const box = card().getBoundingClientRect();
			expect(box.left).toBeGreaterThanOrEqual(avatar.right);
			expect(box.width).toBe(
				screen.getByText(PROSE).getBoundingClientRect().width,
			);
		} finally {
			resetChatUIConfig();
		}
	});

	it("fills the transcript inside its gutters when the transcript is narrower than the cap", async () => {
		const { scroller } = await renderTranscript({
			pages: pageRecords("<p>narrow</p>"),
			width: 900,
		});
		const pane = scroller.getBoundingClientRect();
		const box = card().getBoundingClientRect();

		// `sm:px-4` on the track.
		expect(box.left - pane.left).toBeCloseTo(16, 0);
		expect(box.width).toBeCloseTo(scroller.clientWidth - 32, 0);
	});

	it("scrolls a page wider than itself sideways inside its frame, never the transcript", async () => {
		const { scroller } = await renderTranscript({
			pages: pageRecords(WIDE_PAGE),
			width: 900,
		});
		await expect.poll(() => lastReport()?.x).toBe(true);

		pageFrame()?.postMessage("scroll-right", "*");
		await expect.poll(() => lastReport()?.scrollX).toBe(500);
		expect(scroller.scrollWidth).toBe(scroller.clientWidth);
		// Its sideways scrollbar is under the page, not over its last rows: the
		// frame is sized to both, so the page never scrolls down.
		await expect.poll(() => lastReport()?.y).toBe(false);
	});
});

describe("an HTML page in full screen", () => {
	it("scrolls a page wider than the screen sideways", async () => {
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<FullScreenHost>
					<HtmlRenderCard
						run={{
							id: "tool-wide",
							name: "mcp__pockode__html_render",
							input: { title: TITLE, html: WIDE_PAGE },
							status: "success",
						}}
						sessionId="session-1"
					/>
				</FullScreenHost>
			</QueryClientProvider>,
		);
		await user.click(
			await screen.findByRole("button", { name: "Open page in full screen" }),
		);
		const dialog = screen.getByRole("dialog", { name: TITLE });
		const frame = within(dialog).getByTitle(TITLE) as HTMLIFrameElement;
		const fullScreenPage = () => frame.contentWindow?.frames[0] ?? null;
		await expect.poll(() => lastReport(fullScreenPage())?.x).toBe(true);

		fullScreenPage()?.postMessage("scroll-right", "*");
		await expect.poll(() => lastReport(fullScreenPage())?.scrollX).toBe(500);
	});
});
