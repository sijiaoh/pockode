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

	// Trial and error is how an agent works, so a turn routinely has several
	// failed calls in it. Bodies that unfold themselves bury the answer the user
	// is reading — but the row has to say more than "this went wrong", which is
	// what the second line is for.
	it("keeps a failure collapsed and says on the row how it failed", () => {
		draw({
			status: "error",
			result:
				"> vite build\nsrc/main.ts:3:1 - error TS2304\nmake: *** [build] Error 1",
		});

		expect(screen.getByRole("button", { expanded: false })).toBeVisible();
		expect(screen.getByLabelText("failed")).toBeVisible();
		// The last line, not the first: it is the one the live line was already
		// showing, and a build's verdict is at the end while the head is noise.
		expect(screen.getByText("make: *** [build] Error 1")).toBeVisible();
		expect(screen.queryByText(/vite build/)).toBeNull();
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
		it("offers the log it deliberately did not fetch", async () => {
			const user = userEvent.setup();
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

			// The outcome is what the user was waiting for and stays on the row.
			// The log is only a pointer at a file nobody read, so it does not take
			// a card in the strip above the body.
			expect(screen.getByText("Build succeeded in 4m12s")).toBeVisible();
			expect(screen.queryByText("Not fetched")).toBeNull();

			await user.click(screen.getByRole("button", { expanded: false }));
			// The full path, not the file name: the body does not truncate, so its
			// tail is the name already.
			expect(
				screen.getByText(`${mockWorkDir.value}/.pockode/logs/build-1.log`),
			).toBeVisible();
			expect(screen.getByText("Not fetched")).toBeVisible();
			expect(screen.getByRole("button", { name: "Open" })).toBeVisible();
		});

		// A CLI writes a background log wherever it likes, and every route into a
		// file takes a work-directory-relative path — so this is the common half,
		// not the edge. The entry must not tell the reader to open something that
		// has no button.
		it("does not offer to open a log that lives outside the work directory", async () => {
			const user = userEvent.setup();
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

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("/tmp/claude-shell/build-1.log")).toBeVisible();
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

		describe("what a later call fetched of it", () => {
			// The whole point of the feature: the fetched output reads inside the
			// row it belongs to, so nothing has to be matched up by task id.
			it("reads on the row and in the body of the call it belongs to", async () => {
				const user = userEvent.setup();
				draw({
					...background,
					fetches: [{ id: "f1", result: "tick 417\ntick 418\n" }],
				});

				// On the row, and in its accessible name: a fetch does not move
				// again until the next one.
				const line = screen.getByText("tick 418");
				expect(line).toHaveAttribute("aria-hidden", "false");
				expect(screen.getByRole("button", { name: /tick 418/ })).toBeVisible();

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.getByText("Fetched output")).toBeVisible();
				expect(screen.getByText(/tick 417/)).toBeVisible();
			});

			// A reading order, not a clock: nothing here carries a timestamp, so
			// the one order the body can honestly claim is what the agent read
			// first, what was fetched of it, and how it ended.
			it("sits between what the agent read and how it ended", async () => {
				const user = userEvent.setup();
				draw({
					...background,
					status: "success",
					result: "Build succeeded",
					fetches: [{ id: "f1", result: "tick 418" }],
				});

				await user.click(screen.getByRole("button", { expanded: false }));
				const labels = screen
					.getAllByText(
						/Returned to the agent|Fetched output|Outcome · after the turn/,
					)
					.map((node) => node.textContent);
				expect(labels).toEqual([
					"Returned to the agent",
					"Fetched output",
					"Outcome · after the turn",
				]);
			});

			// `TaskOutput` does not say whether it returns the whole output or
			// only what is new, so neither merging the text nor keeping the newest
			// alone can be done without lying under one of the two readings.
			it("keeps every fetch under its own number, oldest first", async () => {
				const user = userEvent.setup();
				draw({
					...background,
					fetches: [
						{ id: "f1", result: "tick 1" },
						{ id: "f2", result: "tick 207" },
						{ id: "f3", result: "tick 418" },
					],
				});

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.getByText("Fetched output · 3 fetches")).toBeVisible();
				expect(
					screen.getAllByText(/^Fetch \d$/).map((node) => node.textContent),
				).toEqual(["Fetch 1", "Fetch 2", "Fetch 3"]);
				expect(screen.getByText("tick 1")).toBeVisible();
				expect(screen.getByText("tick 207")).toBeVisible();
				// Twice: the newest is on the row as well as in its own block.
				expect(screen.getAllByText("tick 418")).toHaveLength(2);
			});

			// What failed is the call that did the fetching; the task it was
			// reading may be running perfectly, so the row says nothing of it.
			it("says a fetch failed without failing the call it read", async () => {
				const user = userEvent.setup();
				draw({
					...background,
					output: "tick 2\n",
					fetches: [
						{ id: "f1", result: "Task bsbvhgo40 not found", isError: true },
					],
				});

				expect(
					screen.getByRole("status", { name: "Bash running" }),
				).toBeVisible();
				expect(screen.queryByLabelText("failed")).toBeNull();
				// The second line is this run's latest word, and a failed fetch is
				// news about somebody else.
				expect(screen.getByText("tick 2")).toBeVisible();

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.getByText("Fetched output · fetch failed")).toBeVisible();
				expect(screen.getByText("Task bsbvhgo40 not found")).toBeVisible();
			});

			it("says so when the fetch came back with nothing", async () => {
				const user = userEvent.setup();
				draw({ ...background, fetches: [{ id: "f1", result: "" }] });

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.getByText("Fetched output · nothing yet")).toBeVisible();
			});

			// An empty `result` beside blocks is how every non-prose result is
			// shaped, so reading emptiness off the text alone would report a fetch
			// that answered with an image as one that answered with nothing.
			it("does not call a fetch that answered in blocks an empty one", async () => {
				const user = userEvent.setup();
				draw({
					...background,
					fetches: [
						{
							id: "f1",
							result: "",
							contents: [{ type: "file", file: { mime: "image/png" } }],
						},
					],
				});

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.getByText("Fetched output")).toBeVisible();
				expect(screen.queryByText(/nothing yet/)).toBeNull();
			});

			// Neither field: the fetch never returned, because the turn was cut
			// short. An empty heading would be noise about nothing.
			it("draws nothing for a fetch that never returned", async () => {
				const user = userEvent.setup();
				draw({ ...background, fetches: [{ id: "f1" }] });

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.queryByText(/Fetched output/)).toBeNull();
			});

			// A background row is by definition not at the tail of the transcript,
			// so nothing about it may unfold itself under a reader.
			it("does not open the body when a fetch arrives", () => {
				const { rerender } = render(
					<ToolCallItem run={run(background)} sessionId="session-1" />,
				);
				rerender(
					<ToolCallItem
						run={run({
							...background,
							fetches: [{ id: "f1", result: "tick" }],
						})}
						sessionId="session-1"
					/>,
				);
				expect(screen.getByRole("button", { expanded: false })).toBeVisible();
				expect(screen.queryByText(/Fetched output/)).toBeNull();
			});
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
			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Exit code 2")).toBeVisible();
		});
	});
});
