import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDiffSettingsStore } from "../../lib/diffSettingsStore";
import type { ContentPart, ToolRun } from "../../types/message";
import { OpenWorkDetailContext } from "./openWorkDetailContext";
import { StopTargetsContext } from "./stopTargetsContext";
import ToolCallItem from "./ToolCallItem";
import { PartBlocks } from "./ToolList";
import { ToolJumpContext } from "./toolJumpContext";
import { TranscriptViewContext } from "./transcriptViewContext";

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
	getLanguageFromPath: () => undefined,
	isMarkdownFile: () => false,
}));

// The diff itself is the library's to draw; what the body owes it is the
// patch and whether to wrap.
vi.mock("../ui/DiffViewer", () => ({
	DiffViewer: ({ hunks, wrap }: { hunks: string[]; wrap?: boolean }) => (
		<pre data-testid="diff" data-wrap={String(Boolean(wrap))}>
			{hunks.join("")}
		</pre>
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
		expect(screen.getByText("Command")).toBeVisible();
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

	describe("the body", () => {
		const open = async () => {
			const user = userEvent.setup();
			await user.click(screen.getAllByRole("button", { expanded: false })[0]);
			return user;
		};
		const precedes = (a: HTMLElement, b: HTMLElement) =>
			Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

		// The command is what has to be read before its output can be trusted.
		it("puts a command before its output, under their own names", async () => {
			draw({ status: "success", result: "built in 2s" });
			await open();

			expect(
				precedes(screen.getByText("Command"), screen.getByText("Output")),
			).toBe(true);
			expect(screen.getByText("built in 2s")).toBeVisible();
		});

		// The output reads as if the call finished normally unless it says so.
		it("says when its output came back after the interrupt", async () => {
			draw({ status: "interrupted", result: "built in 2s" });
			await open();
			expect(
				screen.getByText("Returned after the turn was interrupted."),
			).toBeVisible();
		});

		// The row already says which file was read; the answer is what the row
		// was opened for, and the input is folded under it.
		it("puts a Read's content first and folds the file it was asked for", async () => {
			draw({
				name: "Read",
				input: { file_path: "/Users/test/project/src/main.ts" },
				status: "success",
				result: "     1\tconsole.log(1);",
			});
			const user = await open();

			const file = screen.getByRole("button", { name: "File" });
			expect(precedes(screen.getByText("Content"), file)).toBe(true);
			expect(file).toHaveAttribute("aria-expanded", "false");
			expect(screen.queryByRole("button", { name: "src/main.ts" })).toBeNull();

			await user.click(file);
			expect(screen.getByRole("button", { name: "src/main.ts" })).toBeVisible();
		});

		// Until it answers, the call is all the body has to say.
		it("leaves a running Read's file open while there is nothing above it", async () => {
			draw({
				name: "Read",
				input: { file_path: "/Users/test/project/src/main.ts" },
			});
			await open();

			expect(screen.getByRole("button", { name: "File" })).toHaveAttribute(
				"aria-expanded",
				"true",
			);
		});

		it("names an unknown tool's blocks plainly", async () => {
			draw({
				name: "mcp__srv__lookup",
				input: { id: 7 },
				status: "success",
				result: "found",
			});
			await open();

			expect(
				precedes(screen.getByText("Parameters"), screen.getByText("Result")),
			).toBe(true);
		});

		// The work directory is what every path here shares; written out and
		// broken anywhere it took four lines on a phone. Cut to one line, it is
		// still in the body in full, a tap away rather than behind a hover.
		it("shows a file relative to the work directory, on one line", async () => {
			const onOpenFile = vi.fn();
			const path = "/Users/test/project/src/lib/main.ts";
			render(
				<ToolCallItem
					run={run({
						name: "Edit",
						input: { file_path: path, old_string: "a", new_string: "b" },
					})}
					sessionId="session-1"
					onOpenFile={onOpenFile}
				/>,
			);
			const user = await open();
			const writeText = vi.spyOn(navigator.clipboard, "writeText");

			const line = screen.getByRole("button", { name: "src/lib/main.ts" });
			expect(within(line).getByText("main.ts")).toHaveClass("truncate");
			await user.click(line);
			expect(screen.getByText(path)).toHaveClass("break-all");

			await user.click(screen.getByRole("button", { name: "Open" }));
			expect(onOpenFile).toHaveBeenCalledWith("src/lib/main.ts");
			// The header still hands over the path in full.
			await user.click(screen.getByRole("button", { name: "Copy path" }));
			expect(writeText).toHaveBeenLastCalledWith(path);
		});

		// The list is in the input; the answer is a sentence telling the agent
		// to keep using the tool, and a screen of JSON above the list was all
		// the body used to open on.
		it("shows a TodoWrite as its checklist and nothing else", async () => {
			draw({
				name: "TodoWrite",
				input: {
					todos: [
						{ content: "Write tests", status: "completed", activeForm: "" },
						{ content: "Ship it", status: "pending", activeForm: "" },
					],
				},
				status: "success",
				result: "Todos have been modified successfully.",
			});
			await open();

			expect(screen.getByText("Todos")).toBeVisible();
			expect(screen.getByText("Write tests")).toHaveClass("line-through");
			expect(screen.getByText("Ship it")).toBeVisible();
			// Never cut: every item on the list is the point.
			expect(
				screen.getByText("Ship it").closest(".overflow-y-hidden"),
			).toBeNull();
			expect(screen.queryByText(/"todos"/)).toBeNull();
			expect(screen.queryByText(/modified successfully/)).toBeNull();
			expect(screen.queryByText("Parameters")).toBeNull();
		});

		it("still says why a TodoWrite failed", async () => {
			draw({
				name: "TodoWrite",
				input: { todos: [{ content: "Ship it", status: "pending" }] },
				status: "error",
				result: "InputValidationError: activeForm is required",
			});
			await open();

			expect(screen.getByText("Ship it")).toBeVisible();
			expect(
				screen.getByText("InputValidationError: activeForm is required", {
					selector: "pre",
				}),
			).toBeVisible();
		});

		// MCP arguments are named fields; as JSON they were quotes, braces and a
		// sideways scroll around the few words that mattered.
		it("lists an unknown tool's arguments by name", async () => {
			const input = {
				query: "open issues",
				limit: 5,
				filter: { state: "open" },
			};
			draw({ name: "mcp__github__search", input });
			const user = await open();
			const writeText = vi.spyOn(navigator.clipboard, "writeText");

			const field = (name: string) =>
				screen.getByText(name, { selector: "dt" }).nextElementSibling;
			expect(field("query")).toHaveTextContent(/^open issues$/);
			expect(field("limit")).toHaveTextContent(/^5$/);
			expect(field("filter")).toHaveTextContent('"state": "open"');
			// Copied as the JSON it is, to be pasted somewhere that reads JSON.
			await user.click(screen.getByRole("button", { name: "Copy parameters" }));
			expect(writeText).toHaveBeenLastCalledWith(
				JSON.stringify(input, null, 2),
			);
		});

		describe("a change", () => {
			const edit = {
				name: "Edit",
				input: {
					file_path: "/Users/test/project/src/a.ts",
					old_string: "one\ntwo\n",
					new_string: "one\n2\nthree\n",
				},
				status: "success" as const,
				result: "The file has been updated.",
			};

			afterEach(() => {
				useDiffSettingsStore.setState({ wrapLines: false });
				localStorage.clear();
			});

			it("counts the lines it adds and removes in its header", async () => {
				draw(edit);
				await open();

				const header = screen.getByText("Change").parentElement?.parentElement;
				expect(header).toHaveTextContent("+2 −1");
			});

			// The view is drawn from the input, so a refused change looks exactly
			// like one that landed unless the body says otherwise — and the
			// result, the one place the reason is, is shown nowhere else.
			it("says why a refused change was not applied, before the change", async () => {
				draw({
					...edit,
					status: "error",
					result:
						"<tool_use_error>String to replace not found in file.\nString: one</tool_use_error>",
				});
				await open();

				// The row's second line holds the reason alone; the body all of it.
				const error = screen.getByText(/String: one$/);
				expect(error).toHaveTextContent(/^String to replace not found/);
				expect(precedes(error, screen.getByText("Change"))).toBe(true);
				expect(screen.queryByText(/tool_use_error/)).toBeNull();
				const header = screen.getByText("Change").parentElement?.parentElement;
				expect(header).toHaveTextContent(/not applied\s*\+2 −1$/);
			});

			// A new file has no counts to mute; the header still says it never
			// landed.
			it("marks a refused Write as not applied too", async () => {
				draw({
					name: "Write",
					input: { file_path: "/Users/test/project/src/a.ts", content: "x" },
					status: "error",
					result:
						"<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>",
				});
				await open();

				expect(screen.getByText("Error")).toBeVisible();
				expect(
					screen.getByText("Content").parentElement?.parentElement,
				).toHaveTextContent(/not applied$/);
			});

			// A phone's width cuts most lines of code; scrolling each one sideways
			// to read it is what the switch spares.
			it("wraps long lines on request, and remembers it", async () => {
				draw(edit);
				const user = await open();

				const toggle = screen.getByRole("button", { name: "Wrap long lines" });
				expect(toggle).toHaveAttribute("aria-pressed", "false");
				expect(screen.getByTestId("diff")).toHaveAttribute(
					"data-wrap",
					"false",
				);

				await user.click(toggle);
				expect(toggle).toHaveAttribute("aria-pressed", "true");
				expect(screen.getByTestId("diff")).toHaveAttribute("data-wrap", "true");
				expect(localStorage.getItem("pockode:diffWrapLines")).toBe("true");
			});

			// A new file is content, not a diff: every line would count as added
			// whether or not it overwrote one.
			it("leaves a written file's header without a count or a switch", async () => {
				draw({
					name: "Write",
					input: { file_path: "/Users/test/project/a.txt", content: "x\ny\n" },
					status: "success",
					result: "File created",
				});
				await open();

				expect(
					screen.getByText("Content").parentElement?.parentElement,
				).not.toHaveTextContent("+");
				expect(
					screen.queryByRole("button", { name: "Wrap long lines" }),
				).toBeNull();
			});
		});

		describe("a command's output", () => {
			afterEach(() => {
				vi.restoreAllMocks();
			});

			// On a phone a sideways scroll hid the end of nearly every line.
			it("wraps", async () => {
				draw({ status: "success", result: "built in 2s" });
				await open();
				expect(screen.getByText("built in 2s")).toHaveClass(
					"whitespace-pre-wrap",
				);
			});

			// A test run's or a build's verdict is its last lines, so that is
			// the end a long output is cut to keep.
			it("keeps its end in view and counts what it cut", async () => {
				// jsdom does no layout: every element is as tall as a long log, and
				// the box as tall as its budget allows — 320px cut, plus the six
				// lines' tolerance uncut, and all of it open.
				vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(
					2000,
				);
				vi.spyOn(
					HTMLElement.prototype,
					"clientHeight",
					"get",
				).mockImplementation(function (this: HTMLElement) {
					if (this.hasAttribute("data-clamped")) return 320;
					return this.style.maxHeight ? 416 : 2000;
				});
				const result = `${Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n")}\n`;
				draw({ status: "success", result });
				const user = await open();

				const output = screen.getByText(/line 119/);
				expect(output.closest("[data-clamped]")).toHaveClass("justify-end");
				const button = screen.getByRole("button", {
					name: "Show 101 earlier lines of output",
				});
				await user.click(button);
				expect(output.closest("[data-clamped]")).toBeNull();
				expect(button).toHaveAccessibleName("Show less of output");
			});

			// Why it failed is nearly always said at the end.
			it("marks where a failed command says why", async () => {
				const result = ["a", "b", "c", "d", "e", "f", "FAIL"].join("\n");
				draw({ status: "error", result });
				await open();

				const pre = (text: RegExp) =>
					screen.getByText(text, {
						selector: "pre",
						normalizer: (raw) => raw,
					});
				expect(pre(/FAIL/)).toHaveClass("text-th-error");
				expect(pre(/FAIL/).textContent).toBe("c\nd\ne\nf\nFAIL");
				expect(pre(/^a\nb$/)).toHaveClass("text-th-text-muted");
			});
		});

		// A button laid over a block covers the end of its first line; in the
		// header it covers nothing. The output is copied as the text it reads
		// as, not with the colour codes it was printed in.
		it("copies from each block's header", async () => {
			draw({
				status: "success",
				result: "\u001b[32mok\u001b[0m",
			});
			// user-event puts a clipboard of its own on `navigator` at setup, so
			// the spy goes on after it.
			const user = await open();
			const writeText = vi.spyOn(navigator.clipboard, "writeText");

			const command = screen.getByRole("button", { name: "Copy command" });
			const output = screen.getByRole("button", { name: "Copy output" });
			await user.click(command);
			expect(writeText).toHaveBeenLastCalledWith("npm run build");
			await user.click(output);
			expect(writeText).toHaveBeenLastCalledWith("ok");
		});
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

	// jsdom lays nothing out, so whether the bar really sticks is the browser's
	// to show; what is held here is what the stylesheet hangs on.
	describe("an open row", () => {
		it("pins its title line and leaves the second line under it", async () => {
			draw({ activity: "Compiling 120 modules" });
			const row = screen.getByRole("button", { name: /Bash running/ });
			await userEvent.click(row);

			expect(row.parentElement).toHaveClass("row-bar");
			const line = screen.getByText("Compiling 120 modules");
			expect(line).toBeVisible();
			expect(row).not.toContainElement(line);
		});

		it("is marked stuck only while its title is pinned over its body", async () => {
			render(
				<div style={{ overflowY: "auto" }}>
					<ToolCallItem run={run()} sessionId="session-1" />
				</div>,
			);
			const row = screen.getByRole("button", { name: /Bash running/ });
			await userEvent.click(row);
			const bar = row.parentElement as HTMLElement;
			const item = bar.parentElement as HTMLElement;
			const scroller = item.parentElement as HTMLElement;
			const at = (el: HTMLElement, top: number, height: number) =>
				vi
					.spyOn(el, "getBoundingClientRect")
					.mockReturnValue(DOMRect.fromRect({ y: top, height }));
			at(scroller, 100, 600);
			const scrollTo = (rowTop: number, barTop: number) => {
				at(item, rowTop, 800);
				at(bar, barTop, 44);
				fireEvent.scroll(scroller);
			};

			scrollTo(40, 100);
			expect(bar).toHaveAttribute("data-stuck");
			// Not yet scrolled past: the bar is where the row starts.
			scrollTo(100, 100);
			expect(bar).not.toHaveAttribute("data-stuck");
			// The end of the row carrying the bar out over the edge.
			scrollTo(-760, 56);
			expect(bar).not.toHaveAttribute("data-stuck");

			scrollTo(40, 100);
			await userEvent.click(row);
			expect(bar).not.toHaveClass("row-bar");
			expect(bar).not.toHaveAttribute("data-stuck");
		});

		describe("folding", () => {
			const at = (el: Element, top: number, height = 44) =>
				vi
					.spyOn(el, "getBoundingClientRect")
					.mockReturnValue(DOMRect.fromRect({ y: top, height }));

			/**
			 * Opens the row inside a transcript whose top edge is at 100, and
			 * returns where the fold asks the transcript to hold the reader.
			 * `outerBar` stands in for an open row this one is nested in.
			 */
			async function openInTranscript({ outerBar = false } = {}) {
				const view = {
					top: () => 100,
					bottom: () => 700,
					scrollTop: () => 0,
					coveredAbove: () => 0,
					holdAt: vi.fn(),
				};
				const item = <ToolCallItem run={run()} sessionId="session-1" />;
				render(
					<TranscriptViewContext value={view}>
						{outerBar ? (
							<div>
								<div className="row-bar" data-testid="outer-bar" />
								<div>{item}</div>
							</div>
						) : (
							item
						)}
					</TranscriptViewContext>,
				);
				const button = screen.getByRole("button", { name: /Bash running/ });
				await userEvent.click(button);
				const row = button.parentElement?.parentElement as HTMLElement;
				const title = screen.getByText("Bash").parentElement as HTMLElement;
				return { view, button, row, title };
			}

			it("lands a row folded from its pinned bar at the top of the view", async () => {
				const { view, button, row } = await openInTranscript();
				at(row, -900, 1200);

				await userEvent.click(button);

				expect(view.holdAt).toHaveBeenCalledExactlyOnceWith(row, 0);
			});

			it("keeps the title where it was when the row is folded on screen", async () => {
				const { view, button, row, title } = await openInTranscript();
				at(row, 300, 1200);
				// Where the fold moves it to, after the open position was read:
				// what is held is where the reader saw it, not where it went.
				vi.spyOn(title, "getBoundingClientRect")
					.mockReturnValueOnce(DOMRect.fromRect({ y: 314, height: 16 }))
					.mockReturnValue(DOMRect.fromRect({ y: 306, height: 16 }));

				await userEvent.click(button);

				expect(view.holdAt).toHaveBeenCalledExactlyOnceWith(title, 214);
			});

			it("lands a nested row under the outer row's pinned bar", async () => {
				const { view, button, row } = await openInTranscript({
					outerBar: true,
				});
				at(screen.getByTestId("outer-bar"), 100, 44);
				// Started above the view, but only just: still covered by the
				// outer bar, which is what it has to land below.
				at(row, 120, 1200);

				await userEvent.click(button);

				expect(view.holdAt).toHaveBeenCalledExactlyOnceWith(row, 44);
			});

			it("lands the same from the keyboard, and keeps focus on the row", async () => {
				const { view, button, row } = await openInTranscript();
				at(row, -900, 1200);

				button.focus();
				await userEvent.keyboard("{Enter}");

				expect(button).toHaveAttribute("aria-expanded", "false");
				expect(view.holdAt).toHaveBeenCalledExactlyOnceWith(row, 0);
				expect(button).toHaveFocus();
			});

			// A row the user kept open while its group was closed goes back into
			// the group as it folds, and is no longer there to land on.
			describe("out of sight into its group", () => {
				async function keptOpenInClosedGroup() {
					const view = {
						top: () => 100,
						bottom: () => 700,
						scrollTop: () => 0,
						coveredAbove: () => 0,
						holdAt: vi.fn(),
					};
					const calls = ["first-cmd", "second-cmd"].map(
						(command, index): ContentPart => ({
							id: `call-${index}`,
							type: "tool_call",
							tool: run({
								id: `t${index}`,
								input: { command },
								status: "success",
							}),
						}),
					);
					render(
						<TranscriptViewContext value={view}>
							<PartBlocks
								items={calls.map((part) => ({ part }))}
								renderPart={({ part }) =>
									part.type === "tool_call" && (
										<ToolCallItem run={part.tool} sessionId="session-1" />
									)
								}
							/>
						</TranscriptViewContext>,
					);
					const summary = screen.getByRole("button", {
						name: /Ran first-cmd,second-cmd/,
					});
					await userEvent.click(summary);
					const button = screen.getByRole("button", {
						name: /Bash.*first-cmd/,
					});
					await userEvent.click(button);
					await userEvent.click(summary);
					expect(button).toBeVisible();
					at(button.parentElement?.parentElement as Element, -300, 1200);
					return { view, button, place: summary.parentElement as HTMLElement };
				}

				it("lands on the group's summary when that is above the view", async () => {
					const { view, button, place } = await keptOpenInClosedGroup();
					at(place, -500);

					await userEvent.click(button);

					expect(button).not.toBeVisible();
					expect(view.holdAt).toHaveBeenCalledExactlyOnceWith(place, 0);
				});

				it("leaves a summary that is in sight where it is", async () => {
					const { view, button, place } = await keptOpenInClosedGroup();
					at(place, 300);

					await userEvent.click(button);

					expect(view.holdAt).not.toHaveBeenCalled();
				});
			});

			it("moves nothing when it opens", async () => {
				const { view } = await openInTranscript();
				expect(view.holdAt).not.toHaveBeenCalled();
			});
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

		// Nothing came back from work the process took with it: the text is
		// Pockode's account of the loss, and calling it a return would be false.
		it("does not call a loss with the process a late return", async () => {
			const user = userEvent.setup();
			draw({
				...background,
				status: "interrupted",
				lostWithProcess: true,
				result: "This background task did not finish",
			});
			await user.click(screen.getAllByRole("button", { expanded: false })[0]);
			expect(
				screen.getAllByText("This background task did not finish").length,
			).toBeGreaterThan(0);
			expect(
				screen.queryByText("Returned after the turn was interrupted."),
			).toBeNull();
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
			expect(
				screen.getByRole("button", { name: ".pockode/logs/build-1.log" }),
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
			expect(
				screen.getByRole("button", { name: "/tmp/claude-shell/build-1.log" }),
			).toBeVisible();
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
					fetches: [
						{
							id: "f1",
							state: "returned",
							waits: true,
							result: "tick 417\ntick 418\n",
						},
					],
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
					fetches: [
						{ id: "f1", state: "returned", waits: true, result: "tick 418" },
					],
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
						{ id: "f1", state: "returned", waits: true, result: "tick 1" },
						{ id: "f2", state: "returned", waits: true, result: "tick 207" },
						{ id: "f3", state: "returned", waits: true, result: "tick 418" },
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
						{
							id: "f1",
							state: "returned",
							waits: true,
							result: "Task bsbvhgo40 not found",
							isError: true,
						},
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
				draw({
					...background,
					fetches: [{ id: "f1", state: "returned", waits: true, result: "" }],
				});

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
							state: "returned",
							waits: true,
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
				draw({
					...background,
					fetches: [{ id: "f1", state: "interrupted", waits: true }],
				});

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.queryByText(/Fetched output/)).toBeNull();
			});

			// A fetch in flight is said as the fetch: its own line and its own
			// counter, while the row's glyph and chip stay the task's.
			it("says a fetch in flight on the row and in the body", async () => {
				const user = userEvent.setup();
				draw({
					...background,
					fetches: [
						{
							id: "f1",
							state: "running",
							waits: true,
							seenAt: new Date(Date.now() - 12_000),
						},
					],
				});

				expect(screen.getByText("Waiting for output…")).toBeVisible();
				expect(screen.getByText("· 12s")).toBeVisible();
				expect(screen.getByText("background")).toBeVisible();

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.getByText("Fetched output · waiting…")).toBeVisible();
				expect(
					screen.getByText("Waiting for the task's output."),
				).toBeVisible();
			});

			it("numbers a fetch still waiting among several", async () => {
				const user = userEvent.setup();
				draw({
					...background,
					fetches: [
						{ id: "f1", state: "returned", waits: true, result: "tick 1" },
						{ id: "f2", state: "running", waits: true },
					],
				});

				await user.click(screen.getByRole("button", { expanded: false }));
				expect(screen.getByText("Fetch 2 · waiting…")).toBeVisible();
			});

			// A line the fetch opened is not taken away by the fetch ending.
			it("keeps the row's line when a fetch ends with nothing to show", () => {
				draw({
					...background,
					fetches: [{ id: "f1", state: "interrupted", waits: true }],
				});
				expect(screen.getByText("Output not read")).toBeVisible();
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
							fetches: [
								{ id: "f1", state: "returned", waits: true, result: "tick" },
							],
						})}
						sessionId="session-1"
					/>,
				);
				expect(screen.getByRole("button", { expanded: false })).toBeVisible();
				expect(screen.queryByText(/Fetched output/)).toBeNull();
			});
		});
	});

	// docs/tool-call-ui.md#elapsed-and-duration-meta
	describe("figures Pockode observed", () => {
		const T0 = Date.parse("2026-11-27T09:00:00Z");

		it("shows how long a settled call took between its observed times", () => {
			draw({
				status: "success",
				result: "",
				startedAt: T0,
				endedAt: T0 + 3000,
			});
			expect(screen.getByText("3.0s")).toBeVisible();
		});

		it("prefers the engine's figure to the observed one", () => {
			draw({
				status: "success",
				result: "",
				durationMs: 1200,
				startedAt: T0,
				endedAt: T0 + 3000,
			});
			expect(screen.getByText("1.2s")).toBeVisible();
			expect(screen.queryByText("3.0s")).toBeNull();
		});

		it("shows none under a second", () => {
			draw({
				status: "success",
				result: "ok",
				startedAt: T0,
				endedAt: T0 + 400,
			});
			expect(screen.queryByText(/\ds/)).not.toBeInTheDocument();
		});

		// The interrupt is when Pockode gave up, not when the call ended.
		it("shows none on an interrupted call that never returned", () => {
			draw({ status: "interrupted", startedAt: T0 });
			expect(screen.queryByText(/\ds/)).not.toBeInTheDocument();
		});

		// Counted by its start, so a row replayed four minutes into a run does
		// not sit blank for three seconds and then start again from 3s.
		it("counts a live call from its start, not from when it was drawn", () => {
			draw({ status: "running", seenAt: new Date(Date.now() - 240_000) });
			expect(screen.getByText("4m 0s")).toBeVisible();
		});

		it("draws no counter for a live call it cannot place on this clock", () => {
			draw({ status: "running", startedAt: T0 });
			expect(screen.queryByText(/\ds/)).not.toBeInTheDocument();
		});
	});

	describe("figures an engine reported", () => {
		it("shows a duration the engine measured", () => {
			draw({ status: "success", result: "", durationMs: 252_000 });
			expect(screen.getByText("4m 12s")).toBeVisible();
		});

		// Most Claude calls report none and old records carry no observed
		// times; inventing one from arrival times would be wrong on every replay.
		it("shows none when the engine reported none", () => {
			draw({ status: "success", result: "ok" });
			expect(screen.queryByText(/\ds/)).not.toBeInTheDocument();
		});

		// The glyph says the call failed; the code says how — `exit 137` is a
		// kill, `exit 1` an ordinary failure — and a folded row should say it.
		it("puts a non-zero exit code on the row, before the time, and not in the body", async () => {
			const user = userEvent.setup();
			draw({
				status: "error",
				result: "boom",
				exitCode: 137,
				durationMs: 14_000,
			});
			const row = screen.getByRole("button", { expanded: false });
			expect(within(row).getByText("exit 137")).toBeVisible();
			expect(row.textContent).toMatch(/exit 137\s*14s/);
			await user.click(row);
			expect(screen.queryByText(/Exit code/)).toBeNull();
		});

		it("shows no exit code of zero", () => {
			draw({ status: "success", result: "ok", exitCode: 0 });
			expect(screen.queryByText(/exit/)).toBeNull();
		});
	});

	describe("the lines an edit changed", () => {
		const edit = {
			file_path: "/Users/test/project/src/a.ts",
			old_string: "one\ntwo",
			new_string: "one\nTWO\nthree",
		};
		const row = () => screen.getByRole("button", { expanded: false });

		// The same figure the body's Change header draws right under it: the
		// patch's own, which once disagreed with the turn's tally.
		it("puts the edit's counts on a row that succeeded, before the time", () => {
			draw({ name: "Edit", input: edit, status: "success", durationMs: 1200 });
			expect(row().textContent).toMatch(/lines \+2 −1\s*1\.2s$/);
		});

		it("counts a MultiEdit's edits together", () => {
			draw({
				name: "MultiEdit",
				input: {
					file_path: edit.file_path,
					edits: [
						{ old_string: "a", new_string: "a\nb" },
						{ old_string: "c\nd\n", new_string: "" },
					],
				},
				status: "success",
			});
			expect(row().textContent).toMatch(/\+1 −2$/);
		});

		// What it replaced is not in the transcript, so no `−` is guessed.
		it("counts a Write's content as added and nothing as removed", () => {
			draw({
				name: "Write",
				input: { file_path: edit.file_path, content: "a\nb\nc\n" },
				status: "success",
				result: `The file ${edit.file_path} has been updated successfully.`,
			});
			expect(row().textContent).toMatch(/\+3$/);
		});

		// A failed edit changed nothing, and one interrupted may or may not have.
		it.each([
			"error",
			"interrupted",
			"running",
		] as const)("shows none on a row that is %s", (status) => {
			draw({ name: "Edit", input: edit, status });
			expect(within(row()).queryByText(/\+2/)).toBeNull();
		});

		it("shows nothing for an edit that changes no line", () => {
			draw({
				name: "Edit",
				input: { ...edit, new_string: edit.old_string },
				status: "success",
			});
			expect(within(row()).queryByText(/^lines/)).toBeNull();
			expect(row().textContent).not.toMatch(/[+−]\d/);
		});

		// Red in a stack of rows means a failed call; the coloured counts are
		// the body's.
		it("draws the counts muted, not green and red", () => {
			draw({ name: "Edit", input: edit, status: "success" });
			const added = within(row()).getByText("+2");
			expect(added.closest(".text-th-text-muted")).not.toBeNull();
			expect(
				row().querySelector(".text-th-success, .text-th-error"),
			).toBeNull();
		});
	});

	// Which directory a Codex command runs in is half of what it does; the work
	// directory itself goes without saying.
	it("names the directory a command runs in when it is not the work directory", async () => {
		const user = userEvent.setup();
		draw({
			input: { command: "ls", cwd: "/tmp/elsewhere" },
			status: "success",
		});
		await user.click(screen.getByRole("button", { name: /Bash/ }));
		expect(screen.getByText("/tmp/elsewhere")).toBeInTheDocument();
	});

	it("says nothing of the directory when it is the work directory", async () => {
		const user = userEvent.setup();
		draw({
			input: { command: "ls", cwd: "/Users/test/project/" },
			status: "success",
		});
		await user.click(screen.getByRole("button", { name: /Bash/ }));
		expect(screen.queryByText(/^in /)).not.toBeInTheDocument();
	});

	it("reads a plan as a plan rather than as JSON", async () => {
		const user = userEvent.setup();
		draw({
			name: "ExitPlanMode",
			input: { plan: "# Ship it\n\nThen celebrate." },
			status: "success",
		});
		await user.click(screen.getByRole("button", { name: /ExitPlanMode/ }));
		expect(
			screen.getByRole("heading", { name: "Ship it" }),
		).toBeInTheDocument();
		expect(screen.queryByText(/"plan"/)).not.toBeInTheDocument();
	});
});

describe("ToolCallItem for the remaining tool kinds", () => {
	const open = async () => {
		await userEvent
			.setup()
			.click(screen.getByRole("button", { expanded: false }));
	};

	it("draws a NotebookEdit as its notebook, then the cell, then the result", async () => {
		draw({
			name: "NotebookEdit",
			input: {
				notebook_path: "/Users/test/project/a.ipynb",
				cell_id: "c1",
				new_source: "x = 1\nprint(x)\n",
			},
			status: "success",
			result: "Updated cell c1 with x = 1",
		});
		await open();

		expect(screen.getByRole("group", { name: "File" })).toHaveTextContent(
			"a.ipynb",
		);
		const label = screen.getByText("Cell c1");
		const result = screen.getByText("Updated cell c1 with x = 1");
		// The row's meta and the cell's header: one count, the turn card's.
		expect(screen.getAllByText("+2")).toHaveLength(2);
		expect(screen.getByText(/print\(x\)/)).toBeVisible();
		// The cell above the result: what the call wrote, then what it said.
		expect(
			label.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(screen.getByText("Updated cell c1 with x = 1")).toBeVisible();
	});

	// Drawn from the input, so the cell is there before the call returns — but
	// not yet written, so its count is not the green of a change that landed.
	it("draws a running NotebookEdit's cell, its count plain", async () => {
		draw({
			name: "NotebookEdit",
			input: {
				notebook_path: "/Users/test/project/a.ipynb",
				cell_id: "c1",
				new_source: "x = 1\n",
			},
			status: "running",
		});
		await open();
		expect(screen.getByText("Cell c1")).toBeVisible();
		expect(screen.getByText("x = 1")).toBeVisible();
		for (const count of screen.getAllByText("+1")) {
			expect(count).not.toHaveClass("text-th-success");
		}
		expect(screen.queryByText("not applied")).toBeNull();
	});

	it("says a deleted cell's content is not in the call, and wears the mode", async () => {
		draw({
			name: "NotebookEdit",
			input: {
				notebook_path: "/Users/test/project/a.ipynb",
				cell_id: "c1",
				new_source: "",
				edit_mode: "delete",
			},
			status: "success",
			result: "Deleted cell c1",
		});
		expect(screen.getByText("delete")).toBeVisible();
		await open();
		expect(
			screen.getByText("The deleted cell's content is not in this call."),
		).toBeVisible();
	});

	// An older CLI picked the cell by position; reading that as a cell would
	// claim to know which one.
	it("lists a notebook call of an unknown shape as its arguments", async () => {
		draw({
			name: "NotebookEdit",
			input: {
				notebook_path: "/Users/test/project/a.ipynb",
				cell_number: 2,
				new_source: "x",
			},
			status: "success",
			result: "ok",
		});
		await open();
		expect(screen.getByText("cell_number")).toBeVisible();
		expect(screen.queryByText(/^Cell/)).toBeNull();
	});

	const stop = (targets: string[], goToCall = vi.fn()) => {
		render(
			<ToolJumpContext value={{ reveal: null, goToCall }}>
				<StopTargetsContext value={new Set(targets)}>
					<ToolCallItem
						run={run({
							id: "s1",
							name: "TaskStop",
							input: { task_id: "b1" },
							originToolUseId: "bash1",
							status: "success",
							result: JSON.stringify({
								message: "Successfully stopped task: b1 (sleep 40)",
								task_id: "b1",
								task_type: "local_bash",
								command: "sleep 40",
							}),
						})}
						sessionId="session-1"
					/>
				</StopTargetsContext>
			</ToolJumpContext>,
		);
		return goToCall;
	};

	it("says what a stop stopped, and goes to the call that started it", async () => {
		const goToCall = stop(["bash1"]);
		await open();
		expect(
			screen.getByText("Successfully stopped task: b1 (sleep 40)"),
		).toBeVisible();
		expect(screen.getByText("sleep 40")).toBeVisible();
		await userEvent.setup().click(
			screen.getByRole("button", {
				name: "Go to the call that started this task",
			}),
		);
		expect(goToCall).toHaveBeenCalledWith("bash1");
	});

	it("offers no jump to a call whose row is not loaded", async () => {
		stop([]);
		await open();
		expect(screen.queryByRole("button", { name: /Go to/ })).toBeNull();
	});

	describe("Codex's own calls", () => {
		const openBody = async () => {
			const user = userEvent.setup();
			await user.click(screen.getByRole("button", { expanded: false }));
		};

		it("says a Codex search reported nothing of what it found", async () => {
			draw({
				name: "WebSearch",
				input: { query: "vitest" },
				status: "success",
				result: "",
			});
			await openBody();
			expect(screen.getByText("Results")).toBeVisible();
			expect(
				screen.getByText("Codex does not report what the search found."),
			).toBeVisible();
		});

		it("says a Codex page open reported nothing of the page", async () => {
			draw({
				name: "WebFetch",
				input: { url: "https://go.dev/doc/go1.25" },
				status: "success",
				result: "",
			});
			await openBody();
			expect(
				screen.getByText("Codex does not report what the page said."),
			).toBeVisible();
		});

		it("draws the links a Codex search did report", async () => {
			draw({
				name: "WebSearch",
				input: { query: "go 1.25" },
				status: "success",
				result:
					'Web search results for query: "go 1.25"\n\nLinks: [{"title":"Go 1.25 Release Notes","url":"https://go.dev/doc/go1.25"}]',
			});
			await openBody();
			expect(screen.getByText("Go 1.25 Release Notes")).toBeVisible();
			expect(screen.queryByText(/does not report/)).toBeNull();
		});

		it("shows a generation's prompt once, as its result", async () => {
			draw({
				name: "GenerateImage",
				input: {},
				status: "success",
				result: "",
				contents: [{ type: "text", text: "A blue square on white." }],
			});
			await openBody();
			expect(screen.getByText("Prompt")).toBeVisible();
			expect(screen.getAllByText("A blue square on white.")).toHaveLength(1);
			expect(screen.queryByText(/names the prompt/)).toBeNull();
		});

		it("says a generation that named no prompt did not, with no empty section", async () => {
			draw({
				name: "GenerateImage",
				input: {},
				status: "success",
				result: "",
				contents: [{ type: "file", file: { mime: "image/png" } }],
			});
			await openBody();
			expect(
				screen.getByText("Codex did not name the prompt it used."),
			).toBeVisible();
			expect(screen.queryByText("Prompt")).toBeNull();
		});

		it("says a running generation's prompt is still to come", async () => {
			draw({ name: "GenerateImage", input: {} });
			await openBody();
			expect(
				screen.getByText(
					"Codex names the prompt it used once the image is made.",
				),
			).toBeVisible();
		});

		it("gives a failed generation's reason, not a prompt", async () => {
			draw({
				name: "GenerateImage",
				input: {},
				status: "error",
				result: "Image generation limit reached · resets 14:05",
			});
			expect(
				screen.getByText("Image generation limit reached · resets 14:05"),
			).toBeVisible();
			await openBody();
			expect(screen.queryByText("Prompt")).toBeNull();
		});

		it("says what a sleep asked for", async () => {
			draw({
				name: "Sleep",
				input: { duration_ms: 30000 },
				status: "success",
				result: "",
			});
			await openBody();
			expect(screen.getByText("Asked to wait 30s")).toBeVisible();
		});

		it("draws an agent call by what it did, its prompt, then its agents", async () => {
			draw({
				name: "AgentControl",
				input: {
					action: "sendMessage",
					agents: ["/root/file_reader"],
					prompt: "keep going",
				},
				status: "success",
				result: "/root/file_reader: running",
			});
			expect(screen.getByText("Message")).toBeVisible();
			expect(screen.getByText("file_reader")).toBeVisible();
			await openBody();
			expect(screen.getByText("keep going")).toBeVisible();
			expect(screen.getByText("Agents")).toBeVisible();
			expect(screen.getByText("/root/file_reader: running")).toBeVisible();
		});
	});
});

describe("Pockode's own work calls", () => {
	const ref = { id: "w1", type: "task" as const, title: "Design the row" };
	const drawWork = (overrides: Partial<ToolRun>) => {
		const onOpen = vi.fn();
		render(
			<OpenWorkDetailContext value={onOpen}>
				<ToolCallItem
					run={run({ status: "success", result: "ok", ...overrides })}
					sessionId="session-1"
				/>
			</OpenWorkDetailContext>,
		);
		return onOpen;
	};

	it("opens on the work, and Open leads to its page", async () => {
		const user = userEvent.setup();
		const onOpen = drawWork({
			name: "mcp__pockode__task_start",
			input: { id: "w1" },
			result: "Started work w1",
			workRef: ref,
		});
		expect(screen.getByText("Start task")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { expanded: false }));
		await user.click(
			screen.getByRole("button", { name: "Open task Design the row" }),
		);
		expect(onOpen).toHaveBeenCalledWith("w1");
		expect(screen.getByText("Started work w1")).toBeInTheDocument();
		// Every argument is in the line already.
		expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
	});

	it("shows a creation's body, and opens the work its result named", async () => {
		const user = userEvent.setup();
		const onOpen = drawWork({
			name: "pockode:task_create",
			input: { story_id: "s1", title: "Design the row", body: "Draw **it**" },
			result: 'Created task "Design the row" (ID: w1)',
			workRef: ref,
		});
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Body")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /^Open task/ }));
		expect(onOpen).toHaveBeenCalledWith("w1");
	});

	it("offers no Open on a delete or a failed call", async () => {
		const user = userEvent.setup();
		drawWork({
			name: "mcp__pockode__work_delete",
			input: { id: "w1" },
			workRef: ref,
		});
		drawWork({
			name: "mcp__pockode__step_done",
			input: { id: "w2" },
			status: "error",
			result: "work not found",
		});
		for (const row of screen.getAllByRole("button", { expanded: false })) {
			await user.click(row);
		}
		expect(
			screen.getByText("Design the row", { selector: "span.flex-1" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
	});

	// The client keeps a stamp with no title, for its id; the line falls back
	// to that id rather than drawing nothing.
	it("names a stamped work with no title by its id", async () => {
		const user = userEvent.setup();
		drawWork({
			name: "mcp__pockode__step_done",
			input: { id: "w1" },
			workRef: { ...ref, title: "" },
		});
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(
			screen.getByRole("button", { name: "Open task w1" }),
		).toBeInTheDocument();
	});

	// A record from before work_ref: the input's id, in mono, still opens.
	it("names an unstamped call by its input's id", async () => {
		const user = userEvent.setup();
		const onOpen = drawWork({
			name: "mcp__pockode__work_update",
			input: { id: "w9", title: "New name" },
		});
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Parameters")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Open work w9" }));
		expect(onOpen).toHaveBeenCalledWith("w9");
	});
});
