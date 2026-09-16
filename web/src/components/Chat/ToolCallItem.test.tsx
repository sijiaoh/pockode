import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ToolRun } from "../../types/message";
import ToolCallItem from "./ToolCallItem";

const mockWorkDir = vi.hoisted(() => ({ value: "/Users/test/project" }));

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: mockWorkDir.value }),
}));

// Highlighting is shiki's job and is asynchronous; the body's contract here is
// that the text is in it.
vi.mock("../../lib/shikiUtils", () => ({
	CodeHighlighter: ({ children }: { children: string }) => (
		<pre>{children}</pre>
	),
}));

const run = (overrides: Partial<ToolRun> = {}): ToolRun => ({
	id: "t1",
	name: "Bash",
	input: { command: "npm run build" },
	status: "running",
	...overrides,
});

const draw = (overrides: Partial<ToolRun> = {}) =>
	render(<ToolCallItem run={run(overrides)} sessionId="session-1" />);

describe("ToolCallItem", () => {
	// The row is allowed to lie about length; the body is not. Before this the
	// command was cut in the row and appeared nowhere else at all.
	it("keeps a long command whole in the body it truncates in the row", async () => {
		const user = userEvent.setup();
		const command = `echo ${"x".repeat(300)}`;
		draw({ input: { command }, status: "success", result: "" });

		// One in the row, where CSS cuts it at whatever width it has, and one in
		// the body, where it is selectable and copyable in full. Nothing slices
		// the string itself — a character count cannot know how wide the screen
		// is.
		expect(screen.getAllByText(command)).toHaveLength(1);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getAllByText(command)).toHaveLength(2);
	});

	// It used to be drawn only when there was a result, so a running call and a
	// call that answered with an image alone could not be opened at all.
	it("can be opened while the call is still running", async () => {
		const user = userEvent.setup();
		draw();
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Invocation")).toBeVisible();
	});

	// A search's `path` is the scope it ran in, not what it was looking for. If
	// the body took the file-path branch on it, the pattern — the whole of what
	// the row truncated — would appear in no part of the UI.
	it("shows a scoped Grep's pattern in the body, not just its directory", async () => {
		const user = userEvent.setup();
		draw({
			name: "Grep",
			input: { pattern: "createAuthStore", path: "src/lib" },
			status: "success",
			result: "",
		});
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("createAuthStore")).toBeVisible();
	});

	it("shows a spinner while the call is running and an icon once it is not", () => {
		const { rerender } = draw();
		expect(screen.getByRole("status", { name: "Bash running" })).toBeVisible();

		rerender(
			<ToolCallItem
				run={run({ status: "success", result: "ok" })}
				sessionId="session-1"
			/>,
		);
		expect(screen.getByLabelText("succeeded")).toBeVisible();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	// A failed Bash and a successful one used to render identically.
	it("opens a failure without being asked, and says so in colour", () => {
		draw({ status: "error", result: "make: *** [build] Error 1" });
		expect(screen.getByLabelText("failed")).toBeVisible();
		expect(screen.getByText(/Error 1/)).toBeVisible();
	});

	describe("the second line", () => {
		it("shows what the call is doing, out of the row's accessible name", () => {
			draw({ activity: "Compiling 120 modules" });
			const line = screen.getByText("Compiling 120 modules");
			expect(line).toBeVisible();
			// The row is a button; a name that changes several times a second is
			// re-announced at every focus and is worse than no progress at all.
			expect(line).toHaveAttribute("aria-hidden", "true");
			expect(
				screen.getByRole("button", { name: /Bash running/ }),
			).toBeVisible();
		});

		it("falls back to the last line the command printed", () => {
			draw({ output: "vite v7.1.14\nbuilding for production…\n" });
			expect(screen.getByText("building for production…")).toBeVisible();
		});
	});

	describe("a call that went to the background", () => {
		const background = {
			status: "background" as const,
			fromBackground: true,
			placeholderResult: "Command running in background with ID: bash_1",
		};

		it("keeps spinning and says why the conversation moved on", () => {
			draw(background);
			expect(
				screen.getByRole("status", { name: "Bash running" }),
			).toBeVisible();
			expect(screen.getByText("background")).toBeVisible();
		});

		// A replayed background call has no activity — it is never persisted —
		// and still reads correctly, because the status carries it.
		it("reads correctly with no progress line at all", () => {
			draw(background);
			expect(screen.getByText("background")).toBeVisible();
		});

		it("settles without losing its second line", () => {
			const { rerender } = render(
				<ToolCallItem
					run={run({ ...background, activity: "Compiling" })}
					sessionId="session-1"
				/>,
			);
			expect(screen.getByText("Compiling")).toBeVisible();

			rerender(
				<ToolCallItem
					run={run({
						...background,
						status: "success",
						result: "Build succeeded in 4m12s",
					})}
					sessionId="session-1"
				/>,
			);
			// The line is still there, now saying the thing the user was waiting
			// for — the row's height does not change as it settles.
			const line = screen.getByText("Build succeeded in 4m12s");
			expect(line).toBeVisible();
			expect(line).not.toHaveAttribute("aria-hidden", "true");
			expect(screen.getByText("background")).toBeVisible();
		});

		// A background task's log can be arbitrarily large, so the server names
		// the file rather than pushing it into the transcript — and the row has to
		// say that is a choice, not a failure to read it.
		it("offers the log it deliberately did not fetch", () => {
			const onOpenFile = vi.fn();
			render(
				<ToolCallItem
					run={run({
						...background,
						status: "success",
						result: "",
						contents: [
							{ type: "text", text: "Build succeeded in 4m12s" },
							{
								type: "file",
								file: {
									mime: "",
									path: `${mockWorkDir.value}/.pockode/logs/build-1.log`,
									omitted: "not_fetched",
								},
							},
						],
					})}
					sessionId="session-1"
					onOpenFile={onOpenFile}
				/>,
			);

			// Visible without expanding anything: it is what the user was waiting
			// for, and the wording says nothing is wrong with it.
			expect(screen.getByText("build-1.log")).toBeVisible();
			expect(screen.getByText("Not fetched")).toBeVisible();
			expect(screen.getByRole("button", { name: "Open" })).toBeVisible();
			expect(screen.getByText("Build succeeded in 4m12s")).toBeVisible();
		});

		// A CLI writes a background log wherever it likes, and every route into a
		// file takes a work-directory-relative path — so this is the common half,
		// not the edge. The entry must not tell the reader to open something that
		// has no button.
		it("does not offer to open a log that lives outside the work directory", () => {
			render(
				<ToolCallItem
					run={run({
						...background,
						status: "success",
						result: "",
						contents: [
							{ type: "text", text: "Build succeeded in 4m12s" },
							{
								type: "file",
								file: {
									mime: "",
									path: "/tmp/claude-shell/build-1.log",
									omitted: "not_fetched",
								},
							},
						],
					})}
					sessionId="session-1"
					onOpenFile={vi.fn()}
				/>,
			);

			expect(screen.getByText("Not fetched")).toBeVisible();
			expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
		});

		// Showing only the outcome would assert the agent read something it never
		// did: the placeholder is what it read.
		it("shows the placeholder and the outcome under their own labels", async () => {
			const user = userEvent.setup();
			draw({
				...background,
				status: "success",
				result: "Build succeeded in 4m12s",
			});

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Returned to the agent")).toBeVisible();
			expect(screen.getByText(/bash_1/)).toBeVisible();
			expect(screen.getByText("Outcome · after the turn")).toBeVisible();
		});
	});

	describe("figures an engine reported", () => {
		it("shows a duration the engine measured", () => {
			draw({ status: "success", result: "", durationMs: 252_000 });
			expect(screen.getByText("4m 12s")).toBeVisible();
		});

		// Claude reports none, and inventing one from arrival times would be
		// wrong on every replay.
		it("shows none when the engine reported none", () => {
			draw({ status: "success", result: "ok" });
			expect(screen.queryByText(/\ds/)).not.toBeInTheDocument();
		});

		// It is only interesting when it is non-zero, and then the glyph has
		// already said so — which is why it is in the body and not on the row.
		it("puts a non-zero exit code in the body", async () => {
			const user = userEvent.setup();
			draw({ status: "error", result: "boom", exitCode: 2 });
			await user.click(screen.getByRole("button", { expanded: true }));
			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Exit code 2")).toBeVisible();
		});
	});
});
