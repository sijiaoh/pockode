import { MEDIA_QUERIES } from "@pockode/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countSteps, latestChild } from "../../lib/subagentRun";
import type { ContentPart, ToolRun, ToolRunStatus } from "../../types/message";
import {
	InOpenTurnContext,
	type StepWindowFold,
	StepWindowFoldContext,
} from "./stepWindowContext";
import { SubagentResumesContext } from "./subagentResumesContext";
import { SubagentTranscriptContext } from "./subagentTranscriptContext";
import TaskItem from "./TaskItem";
import { PartBlocks } from "./ToolList";
import { UnfiledChildrenContext } from "./unfiledChildrenContext";

// A stand-in for the transcript's own part renderer, which TaskItem is handed
// rather than imports: enough to tell which child went where. A nested Task is
// drawn by the real component, so recursion is the real thing.
function renderChild(part: ContentPart, asker?: ReactNode, depth = 1) {
	switch (part.type) {
		case "text":
			return <p>{part.content}</p>;
		case "permission_request":
			return (
				<section aria-label={`card ${part.request.toolUseId}`}>
					{asker}
					card for {part.request.toolUseId}
				</section>
			);
		case "tool_call":
			return part.tool.name === "Agent" ? (
				<TaskItem
					run={part.tool}
					depth={depth}
					renderChild={(child, childAsker) =>
						renderChild(child, childAsker, depth + 1)
					}
				/>
			) : (
				<span>row for {part.tool.id}</span>
			);
		default:
			return <span>{part.type}</span>;
	}
}

function TaskItemWithChildren(
	props: Omit<ComponentProps<typeof TaskItem>, "renderChild">,
) {
	return <TaskItem renderChild={renderChild} {...props} />;
}

const task = (
	status: ToolRunStatus,
	overrides: Partial<ToolRun> = {},
): ToolRun => ({
	id: "t1",
	name: "Agent",
	input: { description: "find usages", subagent_type: "Explore" },
	status,
	result: "# Report",
	...overrides,
});

describe("TaskItem", () => {
	it("says what the Task is doing and who is doing it", () => {
		render(<TaskItemWithChildren run={task("running")} />);
		expect(screen.getByText("find usages")).toBeVisible();
		expect(screen.getByText("Explore")).toBeVisible();
		expect(
			screen.getByRole("status", { name: "Subagent running" }),
		).toBeVisible();
	});

	// How long the subagent worked, from its call to its result.
	it("shows how long a settled subagent ran", () => {
		const T0 = Date.parse("2026-11-27T09:00:00Z");
		render(
			<TaskItemWithChildren
				run={task("success", { startedAt: T0, endedAt: T0 + 72_000 })}
			/>,
		);
		expect(screen.getByText("1m 12s")).toBeVisible();
	});

	it("gives each finished state its own icon", () => {
		const { rerender } = render(<TaskItemWithChildren run={task("success")} />);
		expect(screen.getByLabelText("succeeded")).toBeVisible();

		rerender(<TaskItemWithChildren run={task("interrupted")} />);
		expect(screen.getByLabelText("interrupted")).toBeVisible();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("keeps the report out of the way until asked for it", async () => {
		const user = userEvent.setup();
		render(
			<TaskItemWithChildren
				run={task("success", { result: "# Report\n\nThe details." })}
			/>,
		);
		// The row previews its first line, and no more.
		expect(screen.getByText("Report")).toBeVisible();
		expect(screen.queryByText("The details.")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("The details.")).toBeVisible();
	});

	// The brief is only visible here, but it is the longest thing in the row and
	// the least often wanted.
	it("keeps the prompt behind a second click", async () => {
		const user = userEvent.setup();
		render(
			<TaskItemWithChildren
				run={task("success", {
					input: { description: "find usages", prompt: "explore the repo" },
				})}
			/>,
		);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.queryByText("explore the repo")).not.toBeInTheDocument();

		await user.click(screen.getByText("Prompt"));
		expect(screen.getByText("explore the repo")).toBeVisible();
	});

	// A brief is prose with headings and lists as often as not, and a wall of
	// its raw markers is what it used to read as.
	it("renders the prompt as Markdown", async () => {
		const user = userEvent.setup();
		render(
			<TaskItemWithChildren
				run={task("success", {
					input: {
						description: "find usages",
						prompt: "## Goal\n\n- explore the repo",
					},
				})}
			/>,
		);
		await user.click(screen.getByRole("button", { expanded: false }));
		await user.click(screen.getByText("Prompt"));
		expect(screen.getByRole("heading", { name: "Goal" })).toBeVisible();
		expect(screen.getByRole("listitem")).toHaveTextContent("explore the repo");
	});

	// A reload or a page of history would otherwise open every failed subagent
	// in it at once; the row says why instead, read the way a text child is —
	// the hand-back frame unwrapped, the Markdown markers dropped.
	it("keeps a failed Task closed and says why on its row", () => {
		render(
			<TaskItemWithChildren
				run={task("error", {
					result:
						"[Subagent hand-back] The report follows:\n  **Could not** find it.\n  More detail.",
					children: [
						{
							type: "tool_call",
							id: "call-c1",
							tool: { id: "c1", name: "Read", input: {}, status: "success" },
						},
					],
				})}
			/>,
		);
		expect(screen.getByRole("button", { name: /find usages/ })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(screen.getByText("Could not find it.")).toBeVisible();
		expect(screen.queryByText("More detail.")).toBeNull();
	});

	// The shared failure rung would print the raw result's last line — for a
	// framed report, the frame's usage line.
	it("says why on a failed Task that made no calls", () => {
		render(
			<TaskItemWithChildren
				run={task("error", {
					result:
						"[Subagent hand-back] The report follows:\n  Agent type not found.\n<usage>subagent_tokens: 12</usage>",
				})}
			/>,
		);
		expect(screen.getByText("Agent type not found.")).toBeVisible();
		expect(screen.queryByText(/subagent_tokens/)).toBeNull();
	});

	// Nothing to say why with: the figures stand, as on a success.
	it("keeps the figures on a failed Task that returned nothing", () => {
		render(
			<TaskItemWithChildren
				run={task("error", {
					result: "",
					children: [
						{
							type: "tool_call",
							id: "call-c1",
							tool: { id: "c1", name: "Read", input: {}, status: "success" },
						},
					],
					subagent: { toolUses: 1, totalTokens: 45_600 },
				})}
			/>,
		);
		expect(screen.getByText("45.6K tokens")).toBeVisible();
	});

	// A Task that was just spawned can still be opened — the brief it was given
	// is worth reading before the report exists — and says plainly that the
	// report is not there yet.
	it("says so when there is no report yet", async () => {
		const user = userEvent.setup();
		render(
			<TaskItemWithChildren run={task("running", { result: undefined })} />,
		);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText(/No report yet/)).toBeVisible();
	});

	// The row above has settled: saying the subagent "is still working" there
	// would contradict the glyph beside it.
	it("does not claim a settled Task is still working", async () => {
		const user = userEvent.setup();
		render(<TaskItemWithChildren run={task("error", { result: undefined })} />);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.queryByText(/still working/)).toBeNull();
		expect(
			screen.getByText("The subagent failed without reporting anything."),
		).toBeVisible();
	});

	it("keeps a report that landed after the interrupt readable", async () => {
		const user = userEvent.setup();
		render(
			<TaskItemWithChildren
				run={task("interrupted", { result: "# Late report" })}
			/>,
		);
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(screen.getByText("Late report")).toBeVisible();
		// The report reads as if the Task finished normally unless it says so.
		expect(
			screen.getByText("Returned after the turn was interrupted."),
		).toBeVisible();
	});

	// Codex let it run on past the Stop, and it reported.
	it("draws a subagent that finished after the Stop as having finished", async () => {
		const user = userEvent.setup();
		render(
			<TaskItemWithChildren
				run={task("interrupted", {
					result: "sub-done",
					finishedAfterStop: true,
				})}
			/>,
		);
		expect(screen.getByLabelText("succeeded")).toBeVisible();
		expect(screen.getByText("after Stop")).toBeVisible();
		await user.click(screen.getByRole("button", { expanded: false }));
		expect(
			screen.getByText("Finished after the turn was stopped."),
		).toBeVisible();
	});

	// A card hands its place back to the subagent row as to any other, and the
	// row then says what the card said about the answer.
	it("says who denied a subagent call, not the engine's refusal", () => {
		render(
			<TaskItemWithChildren
				run={task("error", {
					result: "The user doesn't want to proceed with this tool use.",
					permission: { answer: "denied" },
				})}
			/>,
		);
		expect(screen.getByLabelText("denied")).toBeVisible();
		expect(screen.getByText("Denied by you")).toBeVisible();
	});

	it("keeps a reviewer's verdict under a subagent row it answered", () => {
		render(
			<TaskItemWithChildren
				run={task("success", {
					permission: { answer: "allowed", by: "permission_reviewer" },
				})}
			/>,
		);
		expect(
			screen.getByText("Allowed by the permission reviewer"),
		).toBeVisible();
	});

	describe("a subagent that went to the background", () => {
		// No `result` while it is still running: the outcome only arrives with
		// the notification, and the helper's default report is not one.
		const background = {
			fromBackground: true,
			result: undefined,
			placeholderResult: "Agent running in background with ID: bsbvhgo40",
		};

		// The body used to draw this text as the subagent's own report, which
		// asserts the agent read something it never did: what arrived is the
		// notification that said how the task ended, and the subagent's report
		// never reached this client at all.
		it("labels the outcome instead of passing it off as the report", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						...background,
						result: "Background agent completed (exit code 0)",
					})}
				/>,
			);

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Outcome · after the turn")).toBeVisible();
			// Twice over: the settled row hands its second line to the outcome,
			// and the body is where it is labelled.
			expect(
				screen.getAllByText("Background agent completed (exit code 0)"),
			).toHaveLength(2);
			// The outcome is its report, under its own label: no sentence about
			// a missing one stands in front of it.
			expect(
				screen.queryByText(/without reporting|ran in the background/),
			).toBeNull();
		});

		// Backgrounded and then cut short before any outcome came: there is no
		// Outcome to point at, and the interruption is what happened.
		it("says it was interrupted when no outcome came", async () => {
			const user = userEvent.setup();
			render(<TaskItemWithChildren run={task("interrupted", background)} />);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			expect(
				screen.getByText(
					"The turn was interrupted before the subagent reported anything.",
				),
			).toBeVisible();
		});

		// The turn may have ended normally: what took the subagent was the
		// process running it.
		it("says the process ended when it was lost with it", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("interrupted", { ...background, lostWithProcess: true })}
				/>,
			);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			expect(
				screen.getByText(
					"The CLI process ended before the subagent reported anything.",
				),
			).toBeVisible();
		});

		// A failure's outcome is the CLI's verdict, not the subagent's words.
		it("points a failed one at its outcome", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("error", {
						...background,
						result: "The background task failed.",
					})}
				/>,
			);
			await user.click(screen.getByRole("button", { expanded: false }));
			expect(
				screen.getByText(
					"The subagent ran in the background; how it ended is under Outcome below.",
				),
			).toBeVisible();
		});

		// It is what the agent actually read when the call returned, and it was
		// drawn nowhere at all before.
		it("shows what it handed the agent while it carried on", async () => {
			const user = userEvent.setup();
			render(<TaskItemWithChildren run={task("background", background)} />);

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Returned to the agent")).toBeVisible();
			expect(screen.getByText(/bsbvhgo40/)).toBeVisible();
		});

		// A background row is by definition not at the tail of the transcript,
		// so a fetch arriving must not move it.
		it("does not open itself when a fetch arrives", () => {
			const { rerender } = render(
				<TaskItemWithChildren run={task("background", background)} />,
			);
			rerender(
				<TaskItemWithChildren
					run={task("background", {
						...background,
						fetches: [
							{
								id: "f1",
								state: "returned",
								waits: true,
								result: "explored 12 files",
							},
						],
					})}
				/>,
			);
			expect(screen.getByRole("button", { expanded: false })).toBeVisible();
			expect(screen.queryByText("Fetched output")).toBeNull();
		});

		// The same account of the same thing as on an ordinary tool row: one
		// shared section, not a second way of saying it per renderer.
		it("reads what a later call fetched of it", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("background", {
						...background,
						fetches: [
							{
								id: "f1",
								state: "returned",
								waits: true,
								result: "explored 12 files",
							},
						],
					})}
				/>,
			);

			expect(screen.getByText("explored 12 files")).toBeVisible();
			await user.click(screen.getByRole("button", { expanded: false }));
			expect(screen.getByText("Fetched output")).toBeVisible();
		});
	});
	describe("a subagent's own work", () => {
		const read = (id: string): ContentPart => ({
			type: "tool_call",
			id: `call-${id}`,
			tool: {
				id,
				name: "Read",
				input: { file_path: "/repo/sender.go" },
				status: "success",
			},
		});
		let textId = 0;
		const text = (content: string): ContentPart => ({
			type: "text",
			id: `text-${++textId}`,
			content,
		});
		const pendingCard = (toolUseId: string): ContentPart => ({
			type: "permission_request",
			id: `card-${toolUseId}`,
			request: {
				requestId: `r-${toolUseId}`,
				toolName: "Bash",
				toolInput: { command: "rm -rf build" },
				toolUseId,
			},
			status: "pending",
		});
		// The row's unfiled children, as the transcript derives them.
		const flat = (...parts: ContentPart[]) =>
			new Map([
				[
					"t1",
					{
						parts,
						count: parts.length,
						steps: countSteps(parts),
						latest: latestChild(parts),
					},
				],
			]);
		const openProcess = async (user: ReturnType<typeof userEvent.setup>) => {
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			await user.click(screen.getByRole("button", { name: /^Process/ }));
		};

		// docs/subagent-transcript-ui.md#the-way-in
		it("offers its work as a transcript beside the Process heading", async () => {
			const user = userEvent.setup();
			const open = vi.fn();
			render(
				<SubagentTranscriptContext value={open}>
					<TaskItemWithChildren
						run={task("running", { result: undefined, children: [read("c1")] })}
					/>
				</SubagentTranscriptContext>,
			);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			const opener = screen.getByRole("button", {
				name: "Open Explore subagent's transcript",
			});
			await user.click(opener);
			expect(open).toHaveBeenCalledWith("t1", opener);
			// Beside the heading, not instead of it: the Process stays closed.
			expect(screen.getByRole("button", { name: /^Process/ })).toHaveAttribute(
				"aria-expanded",
				"false",
			);
		});

		it("offers no transcript for a subagent with no work to show", async () => {
			const user = userEvent.setup();
			render(
				<SubagentTranscriptContext value={vi.fn()}>
					<TaskItemWithChildren run={task("success")} />
				</SubagentTranscriptContext>,
			);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			expect(
				screen.queryByRole("button", { name: /transcript/ }),
			).not.toBeInTheDocument();
		});

		// The Process is a list of parts like a message's, and folds the same way.
		it("folds a run of its calls into one summary, keeping a failure in sight", async () => {
			const user = userEvent.setup();
			const failed: ContentPart = {
				type: "tool_call",
				id: "call-c2",
				tool: {
					id: "c2",
					name: "Bash",
					input: { command: "go test" },
					status: "error",
				},
			};
			render(
				<TaskItemWithChildren
					run={task("success", { children: [read("c1"), failed, read("c3")] })}
				/>,
			);
			await openProcess(user);

			const summary = screen.getByRole("button", { name: /Read sender\.go/ });
			expect(screen.getByText("row for c1")).not.toBeVisible();
			expect(screen.getByText("row for c2")).toBeVisible();
			await user.click(summary);
			expect(screen.getByText("row for c1")).toBeVisible();
			expect(screen.getByText("row for c3")).toBeVisible();
		});

		// How far it has come and what it is doing now, without opening it: the
		// latest child is the subagent's own words when it is between calls.
		it("says how many steps it has taken and what it is doing", () => {
			render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						children: [read("c1"), read("c2"), text("Checking the 503 path.")],
					})}
				/>,
			);
			expect(screen.getByText("2 tool uses")).toBeVisible();
			expect(screen.getByText("Checking the 503 path.")).toBeVisible();
		});

		it("words a latest call the way its own row does", () => {
			render(
				<TaskItemWithChildren
					run={task("running", { result: undefined, children: [read("c1")] })}
				/>,
			);
			expect(screen.getByText("1 tool use")).toBeVisible();
			expect(screen.getByText("Read")).toBeVisible();
			expect(screen.getByText("sender.go")).toBeVisible();
		});

		// Settled, the conclusion is the news: the report's first line replaces
		// whatever it was last doing, and the count stays.
		it("previews the report after the count once it has finished", () => {
			render(
				<TaskItemWithChildren
					run={task("success", {
						result: "## Findings\n\nTwo callers.",
						children: [read("c1"), read("c2"), text("Checking.")],
						subagent: { toolUses: 2, totalTokens: 45_600 },
					})}
				/>,
			);
			expect(screen.getByText("2 tool uses")).toBeVisible();
			expect(screen.getByText("Findings")).toBeVisible();
			expect(screen.getByText("45.6K tokens")).toBeVisible();
			expect(screen.queryByText("Checking.")).toBeNull();
		});

		it("previews the report of a run that measured nothing", () => {
			render(<TaskItemWithChildren run={task("success")} />);
			expect(screen.getByText("Report")).toBeVisible();
		});

		it("keeps the count and the tokens when it reported nothing", () => {
			render(
				<TaskItemWithChildren
					run={task("success", {
						result: "",
						children: [read("c1"), read("c2")],
						subagent: { toolUses: 2, totalTokens: 45_600 },
					})}
				/>,
			);
			expect(screen.getByText("2 tool uses")).toBeVisible();
			expect(screen.getByText("45.6K tokens")).toBeVisible();
			expect(screen.queryByText("·")).toBeNull();
		});

		it("previews the report of a subagent that called nothing", () => {
			render(
				<TaskItemWithChildren
					run={task("success", {
						subagent: { toolUses: 0, totalTokens: 4200 },
					})}
				/>,
			);
			expect(screen.getByText("Report")).toBeVisible();
			expect(screen.getByText("4.2K tokens")).toBeVisible();
			expect(screen.queryByText("·")).toBeNull();
		});

		it("keeps the count on a failed row", () => {
			render(
				<TaskItemWithChildren
					run={task("error", {
						result: "Agent crashed",
						children: [read("c1"), text("Trying again.")],
					})}
				/>,
			);
			expect(screen.getByText("1 tool use")).toBeVisible();
			expect(screen.getByText("Agent crashed")).toBeVisible();
		});

		// A failed call's result is the CLI's error, not the subagent's last
		// words, so those words stay in the process.
		it("does not take a failure's error for the subagent's last words", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("error", {
						result: "Agent crashed",
						children: [read("c1"), text("Trying again.")],
					})}
				/>,
			);
			await openProcess(user);
			expect(
				within(screen.getByRole("group")).getByText("Trying again."),
			).toBeVisible();
		});

		// The CLI backgrounds most subagents of its own accord; a completed one
		// reads as a foreground success, its outcome being its report.
		it("previews a completed background row's outcome as its report", () => {
			render(
				<TaskItemWithChildren
					run={task("success", {
						fromBackground: true,
						result: "Background agent completed\nmore",
						children: [read("c1")],
						subagent: { toolUses: 1, totalTokens: 45_600 },
					})}
				/>,
			);
			expect(screen.getByText("1 tool use")).toBeVisible();
			expect(screen.getByText("Background agent completed")).toBeVisible();
			expect(screen.getByText("45.6K tokens")).toBeVisible();
		});

		// Its body does not open, so the verdict is the row's.
		it("ends a failed background row on its outcome", () => {
			render(
				<TaskItemWithChildren
					run={task("error", {
						fromBackground: true,
						result: "Agent stopped\nmore",
						children: [read("c1")],
						subagent: { toolUses: 1, totalTokens: 45_600 },
					})}
				/>,
			);
			expect(screen.getByText("1 tool use")).toBeVisible();
			expect(screen.getByText("Agent stopped")).toBeVisible();
			expect(screen.queryByText(/tokens$/)).toBeNull();
		});

		it("freezes on where it was when it was cut short", () => {
			render(
				<TaskItemWithChildren
					run={task("interrupted", {
						result: undefined,
						children: [read("c1"), text("Looking at backoff.")],
					})}
				/>,
			);
			expect(screen.getByText("1 tool use")).toBeVisible();
			expect(screen.getByText("Looking at backoff.")).toBeVisible();
		});

		// Every transcript recorded before children were filed: no count at
		// all, rather than a false "0 tool uses".
		it("draws a row with no steps as it always did", () => {
			render(<TaskItemWithChildren run={task("success")} />);
			expect(screen.queryByText(/tool uses?$/)).toBeNull();
		});

		it("keeps its process closed under the report, and the report out of it", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						result: "Final report",
						children: [text("Looking."), read("c1"), text("Final report")],
					})}
				/>,
			);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			const process = screen.getByRole("button", {
				name: "Process · 1 tool use",
			});
			expect(process).toHaveAttribute("aria-expanded", "false");
			expect(screen.queryByText("row for c1")).toBeNull();

			await user.click(process);
			const group = screen.getByRole("group", {
				name: "Explore subagent's process",
			});
			expect(within(group).getByText("Looking.")).toBeVisible();
			expect(within(group).getByText("row for c1")).toBeVisible();
			// Drawn once, as the report above, not again at the end of the process.
			expect(within(group).queryByText("Final report")).toBeNull();
		});

		// Claude's notification carries the subagent's last words, so the
		// outcome is the report and the process does not repeat it.
		it("draws a backgrounded subagent's last words once, as its outcome", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						fromBackground: true,
						result: "Here is what I found.",
						children: [read("c1"), text("Here is what I found.")],
					})}
				/>,
			);
			await openProcess(user);
			// The row's preview of it, and the outcome in the body.
			expect(screen.getAllByText("Here is what I found.")).toHaveLength(2);
			expect(
				within(screen.getByRole("group")).queryByText("Here is what I found."),
			).toBeNull();
		});

		// Two messages in a row are one part, and the report is only the last of
		// them: that paragraph goes, the one before it stays.
		it("drops a report that ends a joined part, and keeps what came before", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						fromBackground: true,
						result: "It is retry1.",
						children: [read("c1"), text("Checked it.\n\nIt is retry1.")],
					})}
				/>,
			);
			await openProcess(user);
			const group = screen.getByRole("group");
			expect(within(group).getByText("Checked it.")).toBeVisible();
			expect(within(group).queryByText(/It is retry1/)).toBeNull();
		});

		// The comparison is whitespace aside here too, and a report may run to
		// several paragraphs of the part.
		it("drops a multi-paragraph report that ends a joined part, whitespace aside", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						fromBackground: true,
						result: "It is retry1.\n\nNothing else.",
						children: [
							read("c1"),
							text("Checked it.\r\n\r\nIt is retry1. \n\n\nNothing else."),
						],
					})}
				/>,
			);
			await openProcess(user);
			const group = screen.getByRole("group");
			expect(within(group).getByText("Checked it.")).toBeVisible();
			expect(within(group).queryByText(/retry1|Nothing else/)).toBeNull();
		});

		// A resumed subagent's reply is streamed under the call that spawned it,
		// and it is not the report that call returned.
		it("keeps trailing words that are not the report", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						result: "Final report",
						children: [read("c1"), text("Resumed reply.")],
					})}
				/>,
			);
			await openProcess(user);
			expect(
				within(screen.getByRole("group")).getByText("Resumed reply."),
			).toBeVisible();
		});

		it("reads the latest child's first line without its Markdown", () => {
			render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						children: [
							read("c1"),
							text("**Findings:** `retry1` in [file1](src/file1.go)"),
						],
					})}
				/>,
			);
			expect(screen.getByText("Findings: retry1 in file1")).toBeVisible();
		});

		// What a subagent that ran inside its call returns is framed for the
		// model (claude 2.1.286); the reader gets the report inside the frame.
		it("draws the report out of Claude's hand-back frame", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						result:
							"[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  The function is `retry2`.\n\n  Second paragraph.\nagentId: a55 (use SendMessage to continue this agent)\n<usage>subagent_tokens: 14824</usage>",
					})}
				/>,
			);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			expect(screen.getByText("Second paragraph.")).toBeVisible();
			expect(
				screen.queryByText(/Subagent hand-back|agentId|subagent_tokens/),
			).toBeNull();
		});

		// claude 2.1.330 puts harness notes above the frame.
		it("draws the report out of a hand-back with notes above the frame", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						result:
							"  <tools-used-before-summary>Bash, Read</tools-used-before-summary>\n  \n[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  The function is `retry2`.\n\n  Second paragraph.",
					})}
				/>,
			);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			expect(screen.getByText("Second paragraph.")).toBeVisible();
			expect(
				screen.queryByText(/Subagent hand-back|tools-used-before-summary/),
			).toBeNull();
		});

		// A card inside a closed process would leave the session waiting on
		// someone who cannot see why — also when a subagent's subagent asks.
		it("draws a pending permission card under the row, never inside the process", async () => {
			const user = userEvent.setup();
			const inner: ToolRun = {
				id: "t2",
				name: "Agent",
				input: { description: "inner", subagent_type: "Plan" },
				status: "running",
				children: [pendingCard("c9")],
			};
			render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						children: [
							pendingCard("c1"),
							{ type: "tool_call", id: "call-t2", tool: inner },
						],
					})}
				/>,
			);
			expect(screen.getByText("card for c1")).toBeVisible();
			expect(screen.getByText("card for c9")).toBeVisible();

			await openProcess(user);
			const group = screen.getByRole("group", {
				name: "Explore subagent's process",
			});
			expect(within(group).queryByText("card for c1")).toBeNull();
			// The steps count both: a card stands in for its call.
			expect(screen.getAllByText("2 tool uses")[0]).toBeVisible();
		});

		// Every card in the slot is under the outer row, so one from deeper down
		// has to say who asked; the outer subagent's own does not.
		it("names the innermost asker on a card from a nested subagent", () => {
			const innermost: ToolRun = {
				id: "t3",
				name: "Agent",
				input: {
					description: "review the diff",
					subagent_type: "code-reviewer",
				},
				status: "running",
				children: [pendingCard("c7")],
			};
			const inner: ToolRun = {
				id: "t2",
				name: "Agent",
				input: { description: "inner", subagent_type: "Plan" },
				status: "running",
				children: [
					pendingCard("c9"),
					{ type: "tool_call", id: "call-t3", tool: innermost },
				],
			};
			render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						children: [
							pendingCard("c1"),
							{ type: "tool_call", id: "call-t2", tool: inner },
						],
					})}
				/>,
			);
			const card = (id: string) =>
				screen.getByRole("region", { name: `card ${id}` });
			expect(card("c1")).not.toHaveTextContent(/Asked by/);
			expect(card("c9")).toHaveTextContent("Asked by Planinnercard for c9");
			// Only the asker, not the path to it.
			expect(card("c7")).toHaveTextContent(
				"Asked by code-reviewerreview the diffcard for c7",
			);
			expect(within(card("c7")).getByText("code-reviewer")).toBeVisible();
		});

		// A subagent's subagent is one step of the outer one, worded as its own
		// row is — what it is doing in turn is its own row's to say.
		it("reads a nested subagent as its row, not as its latest child", () => {
			const inner: ToolRun = {
				id: "t2",
				name: "Agent",
				input: { description: "inner", subagent_type: "Plan" },
				status: "running",
				children: [text("Deep in thought.")],
			};
			render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						children: [
							read("c1"),
							{ type: "tool_call", id: "call-t2", tool: inner },
						],
					})}
				/>,
			);
			expect(screen.getByText("2 tool uses")).toBeVisible();
			expect(screen.getByText("inner")).toBeVisible();
			expect(screen.queryByText("Deep in thought.")).toBeNull();
		});

		// Read out while it moves, the line would be announced on every step;
		// settled, it is part of what the row says.
		it("names the steps to assistive tech only once settled", () => {
			const children = [read("c1"), read("c2")];
			const { rerender } = render(
				<TaskItemWithChildren
					run={task("running", { result: undefined, children })}
				/>,
			);
			expect(
				screen.getByRole("button", { name: /find usages/ }),
			).not.toHaveAccessibleName(/2 tool uses/);

			rerender(<TaskItemWithChildren run={task("success", { children })} />);
			expect(
				screen.getByRole("button", { name: /find usages/ }),
			).toHaveAccessibleName(/2 tool uses/);
		});

		// Children that loaded flat before their call did stay where they
		// are; the row still counts them and the process says where they went.
		it("counts children that loaded before their call", async () => {
			const user = userEvent.setup();
			render(
				<UnfiledChildrenContext
					value={flat(read("u1"), read("u2"), text("Between."))}
				>
					<TaskItemWithChildren
						run={task("success", { children: [read("c1")] })}
					/>
				</UnfiledChildrenContext>,
			);
			expect(screen.getByText("3 tool uses")).toBeVisible();
			await openProcess(user);
			expect(
				screen.getByText(
					"3 more from this subagent are further down, where they first loaded.",
				),
			).toBeVisible();
		});

		// The flat ones are the newest, so they say what it is doing now.
		it("reads what it is doing from children that sit flat", () => {
			render(
				<UnfiledChildrenContext value={flat(text("Newest words."))}>
					<TaskItemWithChildren
						run={task("running", {
							result: undefined,
							children: [read("c1"), text("Old words.")],
						})}
					/>
				</UnfiledChildrenContext>,
			);
			expect(screen.getByText("Newest words.")).toBeVisible();
			expect(screen.queryByText("Old words.")).toBeNull();
		});
	});

	describe("which agent, and what it measured", () => {
		const read = (id: string): ContentPart => ({
			type: "tool_call",
			id: `call-${id}`,
			tool: {
				id,
				name: "Read",
				input: { file_path: "/repo/sender.go" },
				status: "success",
			},
		});

		it("titles the row by its agent, read out as a subagent", () => {
			render(<TaskItemWithChildren run={task("success")} />);
			expect(
				screen.getByRole("button", { name: /find usages/ }),
			).toHaveAccessibleName(/Subagent\s*Explore\s*find usages/);
		});

		it("does not say Subagent twice for a call that named no agent", () => {
			render(
				<TaskItemWithChildren
					run={task("success", { input: { description: "find usages" } })}
				/>,
			);
			expect(
				screen.getByRole("button", { name: /find usages/ }),
			).not.toHaveAccessibleName(/Subagent\s*Subagent/);
			expect(screen.getByText("Subagent")).toBeVisible();
		});

		it("draws the figures once it has settled, and the duration on line 1", () => {
			const T0 = Date.parse("2026-11-27T09:00:00Z");
			render(
				<TaskItemWithChildren
					run={task("success", {
						children: [read("c1"), read("c2")],
						subagent: { toolUses: 2, totalTokens: 45_600 },
						durationMs: 122_000,
						startedAt: T0,
						endedAt: T0 + 1000,
					})}
				/>,
			);
			expect(screen.getByText("2 tool uses")).toBeVisible();
			expect(screen.getByText("45.6K tokens")).toBeVisible();
			expect(screen.getByText("2m 2s")).toBeVisible();
		});

		// One counter per run: where there are children, they are the count live
		// and settled alike, whatever the CLI reported — the number the Process
		// heading shows.
		it("counts its children over the CLI's count, live and settled alike", () => {
			const children = [read("c1"), read("c2"), read("c3")];
			const { rerender } = render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						children,
						subagentProgress: { toolUses: 1 },
					})}
				/>,
			);
			expect(screen.getByText("3 tool uses")).toBeVisible();

			rerender(
				<TaskItemWithChildren
					run={task("success", { children, subagent: { toolUses: 2 } })}
				/>,
			);
			expect(screen.getByText("3 tool uses")).toBeVisible();
		});

		// A subagent whose work never reached the stream.
		it("counts the CLI's figure on a run with no children", () => {
			const { rerender } = render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						subagentProgress: { toolUses: 4, lastToolName: "Grep" },
					})}
				/>,
			);
			expect(screen.getByText("4 tool uses")).toBeVisible();
			expect(screen.getByText("Grep")).toBeVisible();

			rerender(
				<TaskItemWithChildren
					run={task("success", { subagent: { toolUses: 5, totalTokens: 842 } })}
				/>,
			);
			expect(screen.getByText("5 tool uses")).toBeVisible();
			expect(screen.getByText("842 tokens")).toBeVisible();
		});

		it("draws tokens alone for a subagent that called nothing and said nothing", () => {
			render(
				<TaskItemWithChildren
					run={task("success", {
						result: "",
						subagent: { toolUses: 0, totalTokens: 4200 },
					})}
				/>,
			);
			expect(screen.getByText("4.2K tokens")).toBeVisible();
			expect(screen.queryByText(/tool uses?$/)).toBeNull();
		});

		it("draws no live tokens", () => {
			render(
				<TaskItemWithChildren
					run={task("running", {
						result: undefined,
						children: [read("c1")],
						subagentProgress: { toolUses: 1, totalTokens: 9000 },
					})}
				/>,
			);
			expect(screen.queryByText(/tokens$/)).toBeNull();
		});

		// Where it was is the news, even when a late result brought figures.
		it("draws no tokens on a row that was cut short", () => {
			render(
				<TaskItemWithChildren
					run={task("interrupted", {
						children: [read("c1")],
						subagent: { toolUses: 1, totalTokens: 9000 },
					})}
				/>,
			);
			expect(screen.getByText("1 tool use")).toBeVisible();
			expect(screen.queryByText(/tokens$/)).toBeNull();
		});

		it("ends its body on the facts the row leaves out", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						input: {
							description: "find usages",
							subagent_type: "pr-review-toolkit:code-reviewer",
						},
						subagent: { agentId: "a555947eded58a158" },
					})}
				/>,
			);
			expect(screen.getByText("code-reviewer")).toBeVisible();
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			expect(
				screen.getByText(/^pr-review-toolkit:code-reviewer · agent/),
			).toBeVisible();
			expect(screen.getByText("a555947eded58a158")).toBeVisible();
		});

		// A phone drops the tokens off the row first; the body keeps them.
		it("keeps its tokens in the body's facts", async () => {
			const user = userEvent.setup();
			render(
				<TaskItemWithChildren
					run={task("success", {
						subagent: { agentId: "a555", totalTokens: 45_600 },
					})}
				/>,
			);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			expect(screen.getByText(/· 45\.6K tokens$/)).toBeVisible();
		});

		it("leaves out a type the title already says", async () => {
			const user = userEvent.setup();
			render(<TaskItemWithChildren run={task("success")} />);
			await user.click(screen.getByRole("button", { name: /find usages/ }));
			// The title's own, and no second one in the body.
			expect(screen.getAllByText(/Explore/)).toHaveLength(1);
		});
	});
});

// Resumed by a call of its own (Claude's SendMessage), a subagent's row runs
// while that call does, and keeps what it reported for its body.
describe("TaskItem resumed", () => {
	const resume: ToolRun = {
		id: "s1",
		name: "SendMessage",
		input: { to: "a1" },
		status: "background",
	};

	it("reads as running while the call that resumed it runs", async () => {
		const user = userEvent.setup();
		render(
			<SubagentResumesContext value={new Map([["t1", resume]])}>
				<TaskItemWithChildren
					run={task("success", { result: "First report" })}
				/>
			</SubagentResumesContext>,
		);
		expect(
			screen.getByRole("status", { name: "Subagent running" }),
		).toBeVisible();
		expect(screen.queryByLabelText("succeeded")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /find usages/ }));
		expect(await screen.findByText("First report")).toBeVisible();
	});
});

// docs/tool-call-ui.md#the-step-window
describe("TaskItem step window", () => {
	const step = (
		id: string,
		status: ToolRunStatus = "success",
		overrides: Partial<ToolRun> = {},
	): ContentPart => ({
		type: "tool_call",
		id: `call-${id}`,
		tool: {
			id,
			name: "Read",
			input: { file_path: `/repo/${id}.go` },
			status,
			...overrides,
		},
	});
	const words = (content: string): ContentPart => ({
		type: "text",
		id: `text-${content}`,
		content,
	});
	const stepWindow = (row: HTMLElement) =>
		row
			.closest("[data-tool-use-id]")
			?.querySelector<HTMLElement>("[data-step-window]") ?? null;
	// One line per step, read by the file it read.
	const windowFiles = (row: HTMLElement) =>
		Array.from(
			stepWindow(row)?.children ?? [],
			(line) => line.textContent?.match(/(\w+\.go)/)?.[1] ?? null,
		);
	// jsdom matches no width query, so a test is on a phone unless it says
	// otherwise.
	const matchMedia = window.matchMedia;
	const wide = () =>
		vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
			...matchMedia(query),
			matches: query === MEDIA_QUERIES.atLeastRegular,
		}));
	afterEach(() => {
		vi.restoreAllMocks();
	});
	const rowOf = (description: string) =>
		screen.getByRole("button", { name: new RegExp(description) });

	it("shows a lone live subagent's newest steps, oldest first: two on a phone", () => {
		render(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					children: [step("a"), step("b"), step("c"), step("d", "running")],
				})}
			/>,
		);
		expect(windowFiles(rowOf("find usages"))).toEqual(["c.go", "d.go"]);
		// The total stays on line 2, which names no call while the window does.
		expect(screen.getByText("4 tool uses")).toBeVisible();
		expect(screen.queryByText("·")).toBeNull();
	});

	it("gives a lone row three lines past a phone's width", () => {
		wide();
		render(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					children: [step("a"), step("b"), step("c"), step("d", "running")],
				})}
			/>,
		);
		expect(windowFiles(rowOf("find usages"))).toEqual(["b.go", "c.go", "d.go"]);
	});

	// A box reserved for a step that has not come would read as a layout gap.
	it("draws only the lines it has steps for, growing to its size", () => {
		wide();
		render(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					children: [step("a", "running")],
				})}
			/>,
		);
		expect(windowFiles(rowOf("find usages"))).toEqual(["a.go"]);
	});

	it("keeps the subagent's words on line 2 only when they are newer than its last step", () => {
		const { rerender } = render(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					children: [step("a"), words("Checking the 503 path.")],
				})}
			/>,
		);
		expect(screen.getByText("Checking the 503 path.")).toBeVisible();

		rerender(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					children: [step("a"), words("Checking the 503 path."), step("b")],
				})}
			/>,
		);
		expect(screen.queryByText("Checking the 503 path.")).toBeNull();
	});

	it("draws no window before the first step", () => {
		render(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					subagentProgress: { toolUses: 1, lastToolName: "Grep" },
				})}
			/>,
		);
		expect(screen.getByText("Grep")).toBeVisible();
		expect(stepWindow(rowOf("find usages"))).toBeNull();
	});

	// The row's red is the subagent's own outcome.
	it("draws a failed step muted, never red", () => {
		render(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					children: [step("a", "error")],
				})}
			/>,
		);
		const drawn = stepWindow(rowOf("find usages"));
		expect(drawn).not.toBeNull();
		expect(drawn?.querySelector(".text-th-error")).toBeNull();
	});

	it("times only a running step", () => {
		const seenAt = new Date(Date.now() - 12_000);
		render(
			<TaskItemWithChildren
				run={task("running", {
					result: undefined,
					children: [
						step("a", "success", { seenAt, durationMs: 5000 }),
						step("b", "running", { seenAt }),
					],
				})}
			/>,
		);
		expect(stepWindow(rowOf("find usages"))).toHaveTextContent(/b\.go12s$/);
		expect(stepWindow(rowOf("find usages"))).not.toHaveTextContent(/a\.go\d/);
	});

	// The Process shows the same steps whole.
	it("goes with the second line on an open row, and away while the Process is open", async () => {
		const user = userEvent.setup();
		render(
			<TaskItemWithChildren
				run={task("running", { result: undefined, children: [step("a")] })}
			/>,
		);
		// In the row's button while it is closed, under its bar once open.
		expect(
			rowOf("find usages").querySelector("[data-step-window]"),
		).not.toBeNull();
		await user.click(rowOf("find usages"));
		expect(windowFiles(rowOf("find usages"))).toEqual(["a.go"]);
		expect(rowOf("find usages").querySelector("[data-step-window]")).toBeNull();
		await user.click(screen.getByRole("button", { name: /^Process/ }));
		expect(stepWindow(rowOf("find usages"))).toBeNull();
	});

	it("folds a row that settles outside an open turn", () => {
		render(
			<TaskItemWithChildren run={task("success", { children: [step("a")] })} />,
		);
		expect(stepWindow(rowOf("find usages"))).toBeNull();
	});

	// docs/tool-call-ui.md#settling-and-folding. Whether a row is in view is
	// the browser test's; here nothing is measured (no scroller), so only the
	// latch and the turn decide.
	describe("in an open turn", () => {
		const latch = (folded: string[] = [], liveThisTurn: string[] = []) => ({
			folded: new Set(folded),
			liveThisTurn: new Set(liveThisTurn),
			fold: vi.fn(),
			markLive: vi.fn(),
			scroller: () => null,
		});
		const InTurn = ({
			fold,
			open = true,
			children,
		}: {
			fold: StepWindowFold;
			open?: boolean;
			children: ReactNode;
		}) => (
			<StepWindowFoldContext value={fold}>
				<InOpenTurnContext value={open}>{children}</InOpenTurnContext>
			</StepWindowFoldContext>
		);

		it("keeps a settled row's window, frozen, while nothing has folded it", () => {
			render(
				<InTurn fold={latch()}>
					<TaskItemWithChildren
						run={task("success", { children: [step("a")] })}
					/>
				</InTurn>,
			);
			expect(windowFiles(rowOf("find usages"))).toEqual(["a.go"]);
		});

		it("folds it once it is latched, or once its reply is not the turn's", () => {
			const run = task("success", { children: [step("a")] });
			const { rerender } = render(
				<InTurn fold={latch(["t1"])}>
					<TaskItemWithChildren run={run} />
				</InTurn>,
			);
			expect(stepWindow(rowOf("find usages"))).toBeNull();
			rerender(
				<InTurn fold={latch()} open={false}>
					<TaskItemWithChildren run={run} />
				</InTurn>,
			);
			expect(stepWindow(rowOf("find usages"))).toBeNull();
		});

		it("latches the fold when its Process is opened", async () => {
			const user = userEvent.setup();
			const fold = latch();
			render(
				<InTurn fold={fold}>
					<TaskItemWithChildren
						run={task("success", { children: [step("a")] })}
					/>
				</InTurn>,
			);
			await user.click(rowOf("find usages"));
			expect(fold.fold).not.toHaveBeenCalled();
			await user.click(screen.getByRole("button", { name: /^Process/ }));
			expect(fold.fold).toHaveBeenCalledWith("t1");
		});

		// Outside the open turn the window is folded already, and a latch taken
		// there would outlive the turn it belongs to.
		it("latches nothing for a row outside the open turn", async () => {
			const user = userEvent.setup();
			const fold = latch();
			render(
				<InTurn fold={fold} open={false}>
					<TaskItemWithChildren
						run={task("success", { children: [step("a")] })}
					/>
				</InTurn>,
			);
			await user.click(rowOf("find usages"));
			await user.click(screen.getByRole("button", { name: /^Process/ }));
			expect(fold.fold).not.toHaveBeenCalled();
		});

		// A resume regrows its window, so the old fold must not keep it from
		// folding again later.
		it("forgets a latched fold when the run goes live again", () => {
			const fold = latch(["t1"]);
			render(
				<InTurn fold={fold}>
					<TaskItemWithChildren
						run={task("running", { result: undefined, children: [step("a")] })}
					/>
				</InTurn>,
			);
			expect(windowFiles(rowOf("find usages"))).toEqual(["a.go"]);
			expect(fold.markLive).toHaveBeenCalledWith("t1");
		});

		// A subagent resumed this turn from a row in an earlier reply settles
		// in front of the reader as much as a new one does.
		it("keeps the window of a run seen live this turn, whatever reply its row is in", () => {
			render(
				<InTurn fold={latch([], ["t1"])} open={false}>
					<TaskItemWithChildren
						run={task("success", { children: [step("a")] })}
					/>
				</InTurn>,
			);
			expect(windowFiles(rowOf("find usages"))).toEqual(["a.go"]);
		});

		// While its window shows where it was cut, line 2 does not say it
		// again; once it folds, line 2 keeps it.
		it("names where an interrupted row was cut only once its window folds", () => {
			const run = task("interrupted", {
				children: [step("a"), step("b", "interrupted")],
			});
			const line = () =>
				within(rowOf("find usages")).getByText("2 tool uses").parentElement;
			const { rerender } = render(
				<InTurn fold={latch()}>
					<TaskItemWithChildren run={run} />
				</InTurn>,
			);
			expect(line()).not.toHaveTextContent("b.go");
			rerender(
				<InTurn fold={latch(["t1"])}>
					<TaskItemWithChildren run={run} />
				</InTurn>,
			);
			expect(stepWindow(rowOf("find usages"))).toBeNull();
			expect(line()).toHaveTextContent("b.go");
		});
	});

	describe("in a list of siblings", () => {
		const sibling = (
			id: string,
			description: string,
			status: ToolRunStatus,
			children: ContentPart[],
		): ContentPart => ({
			type: "tool_call",
			id: `call-${id}`,
			tool: {
				id,
				name: "Agent",
				input: { description, subagent_type: "Explore" },
				status,
				children,
			},
		});
		const List = ({ parts }: { parts: ContentPart[] }) => (
			<PartBlocks
				items={parts.map((part) => ({ part }))}
				renderPart={({ part }) => renderChild(part, undefined, 0)}
			/>
		);
		const steps = [step("a"), step("b", "error"), step("c")];
		const jobs = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				sibling(`t${i + 1}`, `job ${i + 1}`, "running", steps),
			);

		it("gives two siblings one line each on a phone, two past it", () => {
			const { unmount } = render(<List parts={jobs(2)} />);
			expect(windowFiles(rowOf("job 1"))).toEqual(["c.go"]);
			unmount();
			wide();
			render(<List parts={jobs(2)} />);
			expect(windowFiles(rowOf("job 1"))).toEqual(["b.go", "c.go"]);
		});

		// A plain two-line row, which never grows or folds.
		it("gives three or more siblings no window on a phone, one line past it", () => {
			const { unmount } = render(<List parts={jobs(3)} />);
			expect(stepWindow(rowOf("job 1"))).toBeNull();
			expect(within(rowOf("job 1")).getByText("c.go")).toBeVisible();
			unmount();
			wide();
			render(<List parts={jobs(3)} />);
			expect(windowFiles(rowOf("job 1"))).toEqual(["c.go"]);
		});

		// A sibling spawned after a row settled shrinks the live windows, not
		// the frozen one the reader may be looking at.
		it("keeps a frozen window at the size it settled at", () => {
			const fold: StepWindowFold = {
				folded: new Set(),
				liveThisTurn: new Set(),
				fold: () => {},
				markLive: () => {},
				scroller: () => null,
			};
			const first = (status: ToolRunStatus) =>
				sibling("t1", "first", status, steps);
			const Turn = ({ parts }: { parts: ContentPart[] }) => (
				<StepWindowFoldContext value={fold}>
					<InOpenTurnContext value>
						<List parts={parts} />
					</InOpenTurnContext>
				</StepWindowFoldContext>
			);
			const { rerender } = render(<Turn parts={[first("running")]} />);
			rerender(<Turn parts={[first("success")]} />);
			expect(windowFiles(rowOf("first"))).toEqual(["b.go", "c.go"]);
			rerender(
				<Turn
					parts={[first("success"), sibling("t2", "second", "running", steps)]}
				/>,
			);
			expect(windowFiles(rowOf("first"))).toEqual(["b.go", "c.go"]);
			expect(windowFiles(rowOf("second"))).toEqual(["c.go"]);
		});

		it("regrows only the resumed row's window", () => {
			const resume: ToolRun = {
				id: "s1",
				name: "SendMessage",
				input: { to: "a1" },
				status: "running",
				startedAt: 30,
			};
			render(
				<SubagentResumesContext value={new Map([["t2", resume]])}>
					<List
						parts={[
							sibling("t1", "first", "success", steps),
							sibling("t2", "second", "success", steps),
						]}
					/>
				</SubagentResumesContext>,
			);
			expect(stepWindow(rowOf("first"))).toBeNull();
			expect(windowFiles(rowOf("second"))).toEqual(["c.go"]);
		});
	});
});
