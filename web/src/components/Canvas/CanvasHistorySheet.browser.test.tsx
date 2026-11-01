import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canvasActions } from "../../lib/canvasStore";
import { resetPageHosts } from "../../lib/pageHosts";
import { useWSStore } from "../../lib/wsStore";
import { hitAt } from "../../test/hitAt";
import { CanvasHistorySheet } from "./CanvasHistorySheet";

const actions = useWSStore.getState().actions;

beforeEach(() => {
	canvasActions.receive("s1", { revision: 2 });
	vi.spyOn(actions, "canvasHistory").mockResolvedValue([
		{ revision: 2, change_kind: "update", drawn_at: "", bytes: 10 },
		{ revision: 1, change_kind: "render", drawn_at: "", bytes: 10 },
	]);
	vi.spyOn(actions, "canvasSnapshot").mockImplementation(
		async (_, revision) => ({
			revision,
			html: `<p>${revision}</p>`,
			change: { kind: "render" },
			drawn_at: "",
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	canvasActions.forget("s1");
	resetPageHosts();
});

// The sheet is a layer over the page, which shields the live canvas under
// it — never the page the sheet itself shows.
it("leaves the history view's page within reach", async () => {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<CanvasHistorySheet
				sessionId="s1"
				initialRevision={1}
				onClose={() => {}}
				onGoToCanvas={() => {}}
			/>
		</QueryClientProvider>,
	);
	const frame = await screen.findByTitle("Canvas revision 1");
	expect(hitAt(frame)).toBe(frame);
});
