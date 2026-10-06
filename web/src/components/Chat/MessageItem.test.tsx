import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AssistantMessage,
	Message,
	PermissionRequest,
} from "../../types/message";
import MessageItem from "./MessageItem";
import { IDLE_TAIL, TurnTailContext } from "./turnTailContext";

const RUNNING = { ...IDLE_TAIL, phase: "running" as const };

const mockWorkDir = vi.hoisted(() => ({ value: "/Users/test/project" }));

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { workDir: string }) => string) =>
		selector({ workDir: mockWorkDir.value }),
}));

describe("MessageItem", () => {
	it("renders user message content", () => {
		const message: Message = {
			id: "1",
			role: "user",
			content: "Hello AI",
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Hello AI")).toBeInTheDocument();
	});

	// The files are part of what the user sent; a message can be nothing else,
	// and must not then read as an empty bubble.
	it("shows the files a user message carried", () => {
		const message: Message = {
			id: "f1",
			role: "user",
			content: "",
			status: "complete",
			createdAt: new Date(),
			attachments: [
				{
					name: "report.pdf",
					mime: "application/pdf",
					size: 2048,
					attachment_id: "abc.pdf",
				},
			],
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("report.pdf")).toBeInTheDocument();
	});

	describe("a Pockode command", () => {
		const commandMessage: Message = {
			id: "c1",
			role: "user",
			content: "Lead the work just discussed.\n\nAdditional instructions",
			status: "complete",
			createdAt: new Date(),
			command: { name: "pockode-lead", args: "backend first" },
		};

		// The template reads the same every time; what a reader scans for is
		// which command was sent and what was added to it.
		it("shows the command and its arguments, not the prompt, until opened", async () => {
			const user = userEvent.setup();
			render(<MessageItem sessionId="session-1" message={commandMessage} />);

			const row = screen.getByRole("button", { expanded: false });
			expect(row).toHaveTextContent("/pockode-lead");
			expect(row).toHaveTextContent("backend first");
			expect(screen.queryByText(/Lead the work just discussed/)).toBeNull();

			await user.click(row);

			expect(screen.getByText("Sent to the agent")).toBeVisible();
			expect(screen.getByText(/Lead the work just discussed/)).toBeVisible();
		});
	});

	// The bubble is drawn from `answering`, never from the `content` string the
	// agent reads — so every half of an answer the record keeps has to be read
	// here, or a user watches their own words vanish on send.
	describe("a message that answered posted questions", () => {
		const answering = (
			entry: Record<string, unknown>,
		): Extract<Message, { role: "user" }> => ({
			id: "am-1",
			role: "user",
			content: "Answering:\n\nQ: Which database?\nA: whatever",
			status: "complete",
			createdAt: new Date(),
			answering: [
				{
					request_id: "r1",
					header: "Database",
					question: "Which database?",
					answered_at: "2026-01-02T14:05:00Z",
					...entry,
				},
			],
		});

		// Still source, but a question's paragraphs and code fences run into one
		// line are unreadable.
		it("keeps the line breaks of the question it echoes", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={answering({
						question: "Which database?\n\n```sql\nSELECT 1;\n```",
						answers: ["Postgres"],
					})}
				/>,
			);
			const question = screen.getByText(/Which database\?/);
			expect(question).toHaveClass("whitespace-pre-wrap");
			expect(question.textContent).toContain("\n\n```sql\n");
		});

		it("draws the question beside the labels that were picked", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={answering({ answers: ["Postgres"] })}
				/>,
			);
			expect(screen.getByText("Database")).toBeInTheDocument();
			expect(screen.getByText("Which database?")).toBeInTheDocument();
			expect(screen.getByText("Postgres")).toBeInTheDocument();
		});

		// The whole answer to a question that offered no options lives in `text`,
		// so a bubble reading only `answers` shows an empty line — which is every
		// free-text answer there is.
		it("draws what the user wrote themselves", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={answering({ answers: [], text: "use SQLite" })}
				/>,
			);
			expect(screen.getByText("use SQLite")).toBeInTheDocument();
		});

		it("draws a label and the user's own words together", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={answering({ answers: ["Node"], text: "pin it to 22" })}
				/>,
			);
			expect(screen.getByText("Node · pin it to 22")).toBeInTheDocument();
		});

		// The bubble is what the user said; a remark left off it would show
		// them less than the agent was sent.
		it("draws the note beside an answer", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={answering({ answers: ["Postgres"], note: "pin it to 16" })}
				/>,
			);
			expect(screen.getByText("Postgres — pin it to 16")).toBeInTheDocument();
		});

		it("says a decline is one, with the note when there was one", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={answering({ declined: true, note: "asked ops" })}
				/>,
			);
			expect(screen.getByText("Not answering — asked ops")).toBeInTheDocument();
		});
	});

	// An answer another agent gave through `question_answer`. The reader never
	// saw the question, so the one thing this must not do is read as something
	// they said.
	describe("an answer given by another agent", () => {
		const byAgent = (
			resolvedBy: Record<string, unknown>,
		): Extract<Message, { role: "user" }> => ({
			id: "aa-1",
			role: "user",
			content: "Answering — not the user…",
			status: "complete",
			createdAt: new Date(),
			source: "agent",
			answering: [
				{
					request_id: "r1",
					header: "Database",
					question: "Which database?",
					answers: ["Postgres"],
					answered_at: "2026-01-02T14:05:00Z",
					resolved_by: { kind: "agent", ...resolvedBy },
				},
			],
		});

		it("names the work that answered, and says it was not the reader", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={byAgent({ work_id: "w1", title: "Ship the API" })}
				/>,
			);
			expect(
				screen.getByText(
					'Answered by the agent working on "Ship the API" — not by you.',
				),
			).toBeInTheDocument();
			// Still the answer itself: the reader has to be able to read what was
			// said, which is why this is not folded into a work-event line.
			expect(screen.getByText("Which database?")).toBeInTheDocument();
			expect(screen.getByText("Postgres")).toBeInTheDocument();
		});

		// A plain chat session has no work to name, and the sentence still has to
		// make its point.
		it("still says it was another agent when there is no work to name", () => {
			render(<MessageItem sessionId="session-1" message={byAgent({})} />);
			expect(
				screen.getByText("Answered by another agent — not by you."),
			).toBeInTheDocument();
		});

		// Not an expected state — the origin is set by the same call that fills
		// `answering` — but the one thing this shape exists to prevent is an
		// answer being read as the user's, and falling back to the bubble is
		// exactly that.
		it("keeps saying so even with no answers to draw", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={{
						id: "aa-2",
						role: "user",
						content: "Answering — not the user…",
						status: "complete",
						createdAt: new Date(),
						source: "agent",
					}}
				/>,
			);
			expect(
				screen.getByText("Answered by another agent — not by you."),
			).toBeInTheDocument();
			expect(screen.getByText("Answering — not the user…")).toBeInTheDocument();
		});
	});

	describe("work event", () => {
		const systemMessage = (
			overrides: Partial<Extract<Message, { role: "user" }>> = {},
		): Message => ({
			id: "sm-1",
			role: "user",
			content: "## Current Step\nStep 1 of 3\n\nDo the thing",
			status: "complete",
			createdAt: new Date(),
			source: "system",
			subtype: "kickoff",
			meta: { title: "My work" },
			...overrides,
		});

		it("renders a collapsed line with the action and its title", () => {
			render(<MessageItem sessionId="session-1" message={systemMessage()} />);
			expect(screen.getByText("Pockode · Started")).toBeInTheDocument();
			expect(screen.getByText("My work")).toBeInTheDocument();
			// Prompt body hidden while collapsed
			expect(screen.queryByText(/Do the thing/)).not.toBeInTheDocument();
			expect(screen.getByRole("button")).toHaveAttribute(
				"aria-expanded",
				"false",
			);
		});

		it("expands to reveal the full prompt on click", async () => {
			const user = userEvent.setup();
			render(<MessageItem sessionId="session-1" message={systemMessage()} />);
			await user.click(screen.getByRole("button"));
			expect(screen.getByText(/Do the thing/)).toBeInTheDocument();
			expect(screen.getByRole("button")).toHaveAttribute(
				"aria-expanded",
				"true",
			);
		});

		it("makes the step itself the action for step_advance", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({
						subtype: "step_advance",
						meta: { title: "My work", step: { current: 2, total: 3 } },
					})}
				/>,
			);
			expect(screen.getByText("Pockode · Step 2/3")).toBeInTheDocument();
		});

		it("offers Details into the work it happened to", async () => {
			const user = userEvent.setup();
			const onOpenWorkDetail = vi.fn();
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({
						meta: { title: "My work", work_id: "work-1" },
					})}
					onOpenWorkDetail={onOpenWorkDetail}
				/>,
			);

			await user.click(screen.getByRole("button", { expanded: false }));
			await user.click(screen.getByRole("button", { name: "Details" }));
			expect(onOpenWorkDetail).toHaveBeenCalledWith("work-1");
		});

		// The watcher is often a plain chat with no work of its own; the story is
		// what the message is about either way.
		it("offers Details into the story a watched story's news is about", async () => {
			const user = userEvent.setup();
			const onOpenWorkDetail = vi.fn();
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({
						subtype: "watched_story_closed",
						meta: { story: { id: "story-1", title: "Watched story" } },
					})}
					onOpenWorkDetail={onOpenWorkDetail}
				/>,
			);

			await user.click(screen.getByRole("button", { expanded: false }));
			await user.click(screen.getByRole("button", { name: "Details" }));
			expect(onOpenWorkDetail).toHaveBeenCalledWith("story-1");
		});

		// History recorded before work_id was sent: it still renders, it just has
		// nowhere to link to.
		it("omits Details when the message names no work", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage()}
					onOpenWorkDetail={vi.fn()}
				/>,
			);

			await user.click(screen.getByRole("button", { expanded: false }));
			expect(
				screen.queryByRole("button", { name: "Details" }),
			).not.toBeInTheDocument();
		});

		it("falls back to a generic label for unknown subtypes", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({
						subtype: "future_subtype",
						meta: undefined,
					})}
				/>,
			);
			expect(screen.getByText("Pockode · System Message")).toBeInTheDocument();
		});

		it("does not render a system message as a plain user bubble", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={systemMessage({ content: "raw prompt" })}
				/>,
			);
			// The collapsed line keeps the prompt hidden; a user bubble would show it.
			expect(screen.queryByText("raw prompt")).not.toBeInTheDocument();
		});
	});

	it("renders assistant message with text parts", () => {
		const message: Message = {
			id: "2",
			role: "assistant",
			parts: [{ type: "text", content: "Hello human" }],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Hello human")).toBeInTheDocument();
	});

	it("says the turn is running on a placeholder the server has not answered", async () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [],
			status: "sending",
			createdAt: new Date(),
		};

		// The send is about to open a turn, and nothing else says so yet.
		render(<MessageItem sessionId="session-1" message={message} />);
		expect(await screen.findByText("Agent is running")).toBeInTheDocument();
		expect(screen.getByText("Working")).toBeInTheDocument();
	});

	it("draws the tail line on the streaming message the turn is writing into", async () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [],
			status: "streaming",
			createdAt: new Date(),
		};

		render(
			<TurnTailContext value={RUNNING}>
				<MessageItem sessionId="session-1" message={message} isOpenTurn />
			</TurnTailContext>,
		);
		expect(await screen.findByText("Agent is running")).toBeInTheDocument();
	});

	// A message sent mid-reply is appended below the reply it went into, so the
	// reply still being written is no longer last. Reading position would take its
	// spinner away at the moment the user has just asked it something.
	it("keeps the tail line on the open turn under a message sent into it", async () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [{ type: "text", content: "half an answer" }],
			status: "streaming",
			createdAt: new Date(),
		};

		render(
			<TurnTailContext value={RUNNING}>
				<MessageItem sessionId="session-1" message={message} isOpenTurn />
			</TurnTailContext>,
		);
		expect(await screen.findByText("Agent is running")).toBeInTheDocument();
	});

	it("shows no indicator for a streaming message the turn has moved on from", () => {
		const message: Message = {
			id: "3",
			role: "assistant",
			parts: [{ type: "text", content: "Previous response" }],
			status: "streaming",
			createdAt: new Date(),
		};

		// A bubble left streaming that no open turn is writing into says nothing
		// rather than claiming to still be running; the content stands on its own.
		render(
			<TurnTailContext value={RUNNING}>
				<MessageItem
					sessionId="session-1"
					message={message}
					isOpenTurn={false}
				/>
			</TurnTailContext>,
		);
		expect(screen.queryByText("Agent is running")).not.toBeInTheDocument();
		expect(screen.queryByText("Process ended")).not.toBeInTheDocument();
	});

	it("shows error message for error status", () => {
		const message: Message = {
			id: "4",
			role: "assistant",
			parts: [],
			status: "error",
			error: "Connection failed",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Connection failed")).toBeInTheDocument();
	});

	it("shows interrupted indicator for interrupted status", () => {
		const message: Message = {
			id: "4b",
			role: "assistant",
			parts: [{ type: "text", content: "Partial response" }],
			status: "interrupted",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Interrupted")).toBeInTheDocument();
	});

	it("renders tool calls in parts", () => {
		const message: Message = {
			id: "5",
			role: "assistant",
			parts: [
				{ type: "text", content: "I'll read the file" },
				{
					type: "tool_call",
					tool: {
						id: "tool-1",
						name: "Read",
						input: { file: "test.go" },
						status: "success",
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Read")).toBeInTheDocument();
	});

	it("renders tool call with result when expanded", async () => {
		const user = userEvent.setup();
		const message: Message = {
			id: "6",
			role: "assistant",
			parts: [
				{
					type: "tool_call",
					tool: {
						id: "tool-2",
						name: "Bash",
						input: { command: "ls" },
						status: "success",
						result: "file1.txt\nfile2.txt",
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Bash")).toBeInTheDocument();

		// Result is hidden by default (collapsed)
		expect(screen.queryByText(/file1\.txt/)).not.toBeInTheDocument();

		// Click to expand
		await user.click(screen.getByRole("button"));
		expect(screen.getByText(/file1\.txt/)).toBeInTheDocument();
		expect(screen.getByText(/file2\.txt/)).toBeInTheDocument();
	});

	it("shows a file a tool returned without asking to expand anything", async () => {
		const user = userEvent.setup();
		const message: Message = {
			id: "6b",
			role: "assistant",
			parts: [
				{
					type: "tool_call",
					tool: {
						id: "tool-2b",
						name: "Read",
						input: { file_path: "/Users/test/project/doc.pdf" },
						status: "success",
						// claude's block names no file — it hands over the bytes
						// alone — so the name under the entry is the one the call
						// itself read, which is what makes this entry say as much
						// as codex's does for the same file.
						contents: [
							{
								type: "file",
								file: {
									mime: "application/pdf",
									size: 385,
									omitted: "binary",
								},
							},
						],
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);

		// Visible without expanding: the file is the answer, and an answer folded
		// behind a chevron has not been shown. Found by its tooltip, which is the
		// entry's own — the header line above it shows the same short name.
		const entry = screen.getByTitle("/Users/test/project/doc.pdf");
		expect(entry).toHaveTextContent("doc.pdf");
		expect(screen.getByText("Can't be previewed")).toBeInTheDocument();

		// Nothing left to expand, so the header does not pretend there is.
		await user.click(screen.getByText("Read"));
		expect(screen.getByText("Can't be previewed")).toBeInTheDocument();
	});

	it("renders the tools a search returned as names", async () => {
		const user = userEvent.setup();
		const message: Message = {
			id: "6c",
			role: "assistant",
			parts: [
				{
					type: "tool_call",
					tool: {
						id: "tool-2c",
						name: "ToolSearch",
						input: { query: "notebook" },
						status: "success",
						contents: [
							{ type: "tool_reference", toolName: "NotebookEdit" },
							{ type: "tool_reference", toolName: "Read" },
						],
					},
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.queryByText("NotebookEdit")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button"));
		expect(screen.getByText("NotebookEdit")).toBeInTheDocument();
		expect(screen.getByText("Read")).toBeInTheDocument();
	});

	it("renders pending permission_request with action buttons", () => {
		const message: Message = {
			id: "7",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "rm -rf /" },
						toolUseId: "tool-1",
					},
					status: "pending",
				},
			],
			status: "streaming",
			createdAt: new Date(),
		};

		render(
			<MessageItem
				sessionId="session-1"
				message={message}
				onPermissionRespond={vi.fn()}
			/>,
		);
		expect(screen.getByText("Bash")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
	});

	// Claude's card takes its call's row in place. The list the two rows share
	// must survive that, or the row the user opened beside it closes.
	it("keeps a row open when the row before it becomes a permission card", async () => {
		const user = userEvent.setup();
		const call = (id: string, command: string) => ({
			type: "tool_call" as const,
			tool: {
				id,
				name: "Bash",
				input: { command },
				status: "running" as const,
			},
		});
		const message = (parts: AssistantMessage["parts"]): Message => ({
			id: "parallel",
			role: "assistant",
			parts,
			status: "streaming",
			createdAt: new Date(),
		});

		const { rerender } = render(
			<MessageItem
				sessionId="session-1"
				message={message([call("tool-1", "make a"), call("tool-2", "make b")])}
			/>,
		);
		// Two running calls fold into a group; open it to reach the row.
		await user.click(
			screen.getByRole("button", { name: "Tool calls running" }),
		);
		await user.click(screen.getByRole("button", { name: /make b/ }));

		rerender(
			<MessageItem
				sessionId="session-1"
				message={message([
					{
						type: "permission_request",
						request: {
							requestId: "req-1",
							toolName: "Bash",
							toolInput: { command: "make a" },
							toolUseId: "tool-1",
						},
						status: "pending",
					},
					call("tool-2", "make b"),
				])}
			/>,
		);

		expect(screen.getByRole("button", { name: /make b/ })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("calls onPermissionRespond when Allow is clicked", async () => {
		const user = userEvent.setup();
		const onRespond = vi.fn();
		const message: Message = {
			id: "8",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "ls" },
						toolUseId: "tool-1",
					},
					status: "pending",
				},
			],
			status: "streaming",
			createdAt: new Date(),
		};

		render(
			<MessageItem
				sessionId="session-1"
				message={message}
				onPermissionRespond={onRespond}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Allow" }));
		expect(onRespond).toHaveBeenCalledWith(
			{
				requestId: "req-1",
				toolName: "Bash",
				toolInput: { command: "ls" },
				toolUseId: "tool-1",
			},
			"allow",
		);
	});

	// An expired permission is a denial whichever way the waiting ended; what the
	// banner adds is why nobody was asked again (docs/lifecycle-ui.md §5.2).
	it("says why an expired permission was never answered", async () => {
		const user = userEvent.setup();
		const message: Message = {
			id: "8b",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "ls" },
						toolUseId: "tool-1",
					},
					status: "expired",
					reason: "work_closed",
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		await user.click(screen.getByRole("button", { name: /Bash/ }));

		expect(screen.getByText(/the work was closed/)).toBeInTheDocument();
		expect(screen.getByText(/did not run/)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Allow" }),
		).not.toBeInTheDocument();
	});

	it("renders allowed permission_request without buttons", () => {
		const message: Message = {
			id: "9",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName: "Bash",
						toolInput: { command: "ls" },
						toolUseId: "tool-1",
					},
					status: "allowed",
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("Bash")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Allow" }),
		).not.toBeInTheDocument();
	});

	describe("a pending permission card", () => {
		const pending = (
			toolName: string,
			toolInput: unknown,
			extra: Partial<PermissionRequest> = {},
		): Message => ({
			id: "perm",
			role: "assistant",
			parts: [
				{
					type: "permission_request",
					request: {
						requestId: "req-1",
						toolName,
						toolInput,
						toolUseId: "tool-1",
						...extra,
					},
					status: "pending",
				},
			],
			status: "streaming",
			createdAt: new Date(),
		});

		const drawCard = (message: Message, isCodex = false) => {
			const { container } = render(
				<MessageItem
					sessionId="session-1"
					message={message}
					onPermissionRespond={vi.fn()}
					isCodex={isCodex}
				/>,
			);
			const card = container.querySelector<HTMLElement>(
				"[data-permission-request-id]",
			);
			if (!card) throw new Error("no permission card");
			return card;
		};

		// What is approved is read the way the row will show it ran, not as the
		// JSON it arrived in; the JSON is still there, folded.
		it("reads a command as a command, keeping the raw input folded", async () => {
			const user = userEvent.setup();
			const card = drawCard(
				pending("Bash", {
					command: "rm -rf build",
					description: "Clean the build",
					cwd: "/tmp/elsewhere",
				}),
			);

			expect(card).toHaveTextContent("Clean the build");
			expect(card).toHaveTextContent("rm -rf build");
			expect(card).toHaveTextContent("in /tmp/elsewhere");
			expect(card).not.toHaveTextContent('"command"');

			const raw = screen.getByRole("button", { name: "Raw input" });
			expect(raw).toHaveAttribute("aria-expanded", "false");
			await user.click(raw);
			expect(raw).toHaveAttribute("aria-expanded", "true");
			expect(card).toHaveTextContent('"command": "rm -rf build"');
		});

		it("does not repeat an input that is already drawn whole", () => {
			drawCard(pending("mcp__srv__do", { target: "x" }));

			expect(
				screen.getByText("target", { selector: "dt" }).nextElementSibling,
			).toHaveTextContent(/^x$/);
			expect(
				screen.queryByRole("button", { name: "Raw input" }),
			).not.toBeInTheDocument();
		});

		it("shows a file write as the change it will make", () => {
			const card = drawCard(
				pending("Write", {
					file_path: "/Users/test/project/notes.txt",
					content: "hello from the agent",
				}),
			);

			expect(screen.getByText("Proposed change")).toBeInTheDocument();
			expect(card).toHaveTextContent("hello from the agent");
		});

		it("counts the lines an edit will add and remove", () => {
			drawCard(
				pending("Edit", {
					file_path: "/Users/test/project/a.ts",
					old_string: "one\n",
					new_string: "1\n2\n",
				}),
			);

			expect(
				screen.getByText("Proposed change").parentElement,
			).toHaveTextContent("+2 −1");
			expect(
				screen.getByRole("button", { name: "Wrap long lines" }),
			).toBeInTheDocument();
		});

		it("offers the way over to the file a request would touch", async () => {
			const user = userEvent.setup();
			const onOpenFile = vi.fn();
			render(
				<MessageItem
					sessionId="session-1"
					message={pending("Write", {
						file_path: "/Users/test/project/notes.txt",
						content: "x",
					})}
					onPermissionRespond={vi.fn()}
					onOpenFile={onOpenFile}
				/>,
			);

			await user.click(screen.getByRole("button", { name: "Open" }));
			expect(onOpenFile).toHaveBeenCalledWith("notes.txt");
		});

		// A plan that is the whole input says everything already; one with
		// anything beside it is asking for that too.
		it("folds the raw input under a plan only when the plan is not all of it", () => {
			const { unmount } = render(
				<MessageItem
					sessionId="session-1"
					message={pending("ExitPlanMode", { plan: "Do it" })}
					onPermissionRespond={vi.fn()}
				/>,
			);
			expect(
				screen.queryByRole("button", { name: "Raw input" }),
			).not.toBeInTheDocument();
			unmount();

			drawCard(
				pending("ExitPlanMode", {
					plan: "Do it",
					allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
				}),
			);
			expect(
				screen.getByRole("button", { name: "Raw input" }),
			).toBeInTheDocument();
		});

		// Its consequence is the one thing about Always Allow that outlives the
		// request, so the button carries it, not only the line above it.
		it("describes Always Allow by what it writes", () => {
			drawCard(pending("Bash", { command: "ls" }), true);

			expect(
				screen.getByRole("button", { name: "Always Allow" }),
			).toHaveAccessibleDescription(
				"Always Allow stops Codex asking about requests like this until the session ends.",
			);
		});

		// The server writes back every suggestion, so the card names every one,
		// above the button that writes them.
		it("says everything Always Allow will write", () => {
			const card = drawCard(
				pending(
					"Bash",
					{ command: "npm run build" },
					{
						permissionSuggestions: [
							{
								type: "addRules",
								rules: [{ toolName: "Bash", ruleContent: "npm run build:*" }],
								behavior: "allow",
								destination: "projectSettings",
							},
							{
								type: "setMode",
								mode: "bypassPermissions",
								destination: "session",
							},
						],
					},
				),
			);

			expect(card).toHaveTextContent(
				"Always Allow adds to this project: Bash(npm run build:*)",
			);
			expect(card).toHaveTextContent(
				"Always Allow switches this session to Bypass permissions mode.",
			);
			expect(
				screen.getByRole("button", { name: "Always Allow" }),
			).toBeInTheDocument();
		});

		it("says what Always Allow means on Codex, which has no rules", () => {
			const card = drawCard(pending("Bash", { command: "ls" }), true);

			expect(card).toHaveTextContent(
				"Always Allow stops Codex asking about requests like this until the session ends.",
			);
		});

		it("offers no Always Allow when Claude suggested nothing", () => {
			const card = drawCard(pending("Bash", { command: "ls" }));

			expect(card).not.toHaveTextContent("Always Allow");
		});

		// Deny, then Always Allow, then Allow: the primary action keeps the
		// right-hand end.
		it("orders the decision with Allow last", () => {
			drawCard(pending("Bash", { command: "ls" }), true);

			const names = screen
				.getAllByRole("button", { name: /^(Deny|Always Allow|Allow)$/ })
				.map((button) => button.textContent);
			expect(names).toEqual(["Deny", "Always Allow", "Allow"]);
		});
	});

	it("renders system message with subtype and status from JSON content", () => {
		const message: Message = {
			id: "10",
			role: "assistant",
			parts: [
				{
					type: "system",
					content:
						'{"type":"system","subtype":"compacting","status":"started"}',
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("compacting: started")).toBeInTheDocument();
	});

	it("renders system message with subtype only when no status", () => {
		const message: Message = {
			id: "11",
			role: "assistant",
			parts: [
				{
					type: "system",
					content: '{"type":"system","subtype":"init"}',
				},
			],
			status: "complete",
			createdAt: new Date(),
		};

		render(<MessageItem sessionId="session-1" message={message} />);
		expect(screen.getByText("init")).toBeInTheDocument();
	});

	// The user's `…`: a slot beside the bubble. Queried by class because what
	// these assert is geometry, and jsdom applies no Tailwind — the same reason
	// tests/touchTarget.ts reads the source rather than the layout. `div`
	// because the glyph inside the slot is 36px too (`iconButtonClass`), and a
	// bare `.size-9` would count the slot twice wherever one is drawn.
	describe("the user's message menu slot", () => {
		const slots = (container: HTMLElement) =>
			Array.from(container.querySelectorAll("div.size-9"));

		const userMessage = (): Message => ({
			id: "slot-3",
			role: "user",
			content: "Try again",
			status: "complete",
			createdAt: new Date(),
			anchorSeq: 2,
		});

		// The bubble the user is reading does not move when it settles.
		it("reserves the same slot while sending and once settled", () => {
			const sending = render(
				<MessageItem
					sessionId="session-1"
					message={{ ...userMessage(), status: "sending" }}
					onForkMessage={vi.fn()}
				/>,
			);
			const before = slots(sending.container);
			expect(before).toHaveLength(1);
			expect(
				screen.queryByRole("button", { name: "Actions for your message" }),
			).not.toBeInTheDocument();

			const after = render(
				<MessageItem
					sessionId="session-1"
					message={userMessage()}
					onForkMessage={vi.fn()}
				/>,
			);
			const settledSlots = slots(after.container);
			expect(settledSlots).toHaveLength(1);
			expect(settledSlots[0].className).toBe(before[0].className);
		});

		// Never a turn, and with no bubble edge left to line up with, an empty
		// slot would only narrow the line.
		it("reserves no slot on a work event line", () => {
			const { container } = render(
				<MessageItem
					sessionId="session-1"
					message={{
						id: "slot-2",
						role: "user",
						content: "Started",
						status: "complete",
						createdAt: new Date(),
						source: "system",
						subtype: "kickoff",
						meta: { title: "My work" },
					}}
					onForkMessage={vi.fn()}
				/>,
			);
			expect(slots(container)).toHaveLength(0);
		});

		// Session-level: nothing can be done to any message here, so the room is
		// not paid for either.
		it("reserves nothing when the session cannot fork", () => {
			const { container } = render(
				<MessageItem sessionId="session-1" message={userMessage()} />,
			);
			expect(slots(container)).toHaveLength(0);
		});

		it("names the speaker in the menu title", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={userMessage()}
					onForkMessage={vi.fn()}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: "Actions for your message" }),
			);
			expect(screen.getByRole("dialog")).toHaveAccessibleName("Your message");
		});

		// The opening prompt whose record never persisted is both codes at once,
		// and the permanent one wins: pointing at the missing seq would name a
		// state whose clearing changes nothing, since nothing behind the first
		// message is coming back either way.
		it("names the opening message over a missing seq when both apply", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={{ ...userMessage(), anchorSeq: undefined }}
					isFirst
					onForkMessage={vi.fn()}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: "Actions for your message" }),
			);
			const fork = screen.getByRole("button", { name: /Fork from here/ });
			expect(fork).toHaveTextContent("Nothing before this message to keep.");
			expect(fork).not.toHaveTextContent("no saved position");
		});
	});

	describe("the agent's turn-end actions", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		const settled = (): AssistantMessage => ({
			id: "slot-1",
			role: "assistant",
			parts: [
				{ type: "text", content: "First **part**" },
				{
					type: "tool_call",
					tool: {
						id: "t0",
						name: "Bash",
						input: { command: "ls" },
						status: "success",
						result: "a.txt",
					},
				},
				{ type: "text", content: "Second part" },
			],
			status: "complete",
			createdAt: new Date(),
			anchorSeq: 4,
		});

		const pendingRequest = () => ({
			type: "permission_request" as const,
			request: {
				requestId: "r1",
				toolName: "Bash",
				toolInput: {},
				toolUseId: "t1",
			},
			status: "pending" as const,
		});

		const actions = () =>
			screen.queryByRole("group", { name: "Message actions" });

		/** Only a blocked Fork opens the menu: it holds nothing else the row lacks. */
		const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
			await user.click(screen.getByRole("button", { name: "Fork from here" }));
			const menu = screen.getByRole("dialog", { name: "Agent message" });
			return within(menu).getByRole("button", { name: /Fork from here/ });
		};

		// The tail line holds the row's place while the agent writes, so settling
		// swaps one for the other rather than adding a row under the text.
		it("holds the row's place with the tail line while streaming", () => {
			render(
				<TurnTailContext value={RUNNING}>
					<MessageItem
						sessionId="session-1"
						message={{ ...settled(), status: "streaming" }}
						isOpenTurn
						onForkMessage={vi.fn()}
					/>
				</TurnTailContext>,
			);
			expect(actions()).toBeNull();
			expect(screen.getByText("Working")).toBeVisible();
		});

		// No `…`: the menu would only repeat the two buttons beside it.
		it("offers copy and fork once settled", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={settled()}
					onForkMessage={vi.fn()}
				/>,
			);
			const row = within(actions() as HTMLElement);
			expect(
				row.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
			).toEqual(["Copy message", "Fork from here"]);
		});

		it("copies the message's own text as Markdown, without its tool calls", async () => {
			const user = userEvent.setup();
			const writeText = vi.fn().mockResolvedValue(undefined);
			vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
			render(<MessageItem sessionId="session-1" message={settled()} />);

			await user.click(screen.getByRole("button", { name: "Copy message" }));

			expect(writeText).toHaveBeenCalledWith("First **part**\n\nSecond part");
			expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
		});

		// Plain http on a LAN has no clipboard at all, and that must be visible.
		it("says so when copying fails", async () => {
			const user = userEvent.setup();
			vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
			render(<MessageItem sessionId="session-1" message={settled()} />);

			await user.click(screen.getByRole("button", { name: "Copy message" }));

			expect(screen.getByRole("button", { name: "Copy failed" })).toBeVisible();
		});

		// Copy is an action a message with no text could never have.
		it("offers no copy on a message that is only tool calls", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={{ ...settled(), parts: [settled().parts[1]] }}
					onForkMessage={vi.fn()}
				/>,
			);
			expect(
				screen.queryByRole("button", { name: "Copy message" }),
			).not.toBeInTheDocument();
		});

		it("draws only copy when the session cannot fork", () => {
			render(<MessageItem sessionId="session-1" message={settled()} />);
			const row = within(actions() as HTMLElement);
			expect(row.getAllByRole("button")).toHaveLength(1);
			expect(row.getByRole("button", { name: "Copy message" })).toBeVisible();
		});

		it("draws no row at all when there is nothing to offer", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={{ ...settled(), parts: [settled().parts[1]] }}
				/>,
			);
			expect(actions()).toBeNull();
		});

		it("forks from the Fork button directly", async () => {
			const user = userEvent.setup();
			const onForkMessage = vi.fn();
			render(
				<MessageItem
					sessionId="session-1"
					message={settled()}
					onForkMessage={onForkMessage}
				/>,
			);

			await user.click(screen.getByRole("button", { name: "Fork from here" }));

			expect(onForkMessage).toHaveBeenCalledWith("slot-1");
			expect(screen.queryByRole("dialog")).toBeNull();
		});

		// An icon cannot say why, so a blocked Fork opens the menu that can.
		it("opens the menu with the reason when fork is blocked", async () => {
			const user = userEvent.setup();
			const onForkMessage = vi.fn();
			render(
				<MessageItem
					sessionId="session-1"
					message={{ ...settled(), parts: [pendingRequest()] }}
					onForkMessage={onForkMessage}
				/>,
			);

			const button = screen.getByRole("button", { name: "Fork from here" });
			expect(button).toHaveAttribute("aria-disabled", "true");
			await user.click(button);

			const menu = screen.getByRole("dialog", { name: "Agent message" });
			const fork = within(menu).getByRole("button", { name: /Fork from here/ });
			expect(fork).toHaveAttribute("aria-disabled", "true");
			expect(fork).toHaveTextContent(
				"Respond to the request in this message first.",
			);
			expect(onForkMessage).not.toHaveBeenCalled();
			// Disabled but reachable: the reason is worth nothing if focus and the
			// screen reader skip the row carrying it.
			fork.focus();
			expect(fork).toHaveFocus();
		});

		// Both reasons at once. Answering the request would not conjure a seq, so
		// the row must not send the user off to come back to the same grey row.
		it("names the missing seq over a request when both apply", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={{
						...settled(),
						anchorSeq: undefined,
						parts: [pendingRequest()],
					}}
					onForkMessage={vi.fn()}
				/>,
			);

			const fork = await openMenu(user);
			expect(fork).toHaveTextContent(
				"This message has no saved position to fork from.",
			);
			expect(fork).not.toHaveTextContent("Respond to the request");
		});
	});

	// The real part renderer drawn recursively, which is what TaskItem's own
	// tests stand in for: a subagent's text as a note on a rail, its calls as
	// ordinary rows, its own subagent as a nested Task.
	describe("a subagent's process", () => {
		it("draws the subagent's work with the transcript's own renderers", async () => {
			const user = userEvent.setup();
			const message: AssistantMessage = {
				id: "m1",
				role: "assistant",
				status: "complete",
				createdAt: new Date(),
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "t1",
							name: "Agent",
							input: { description: "find retries", subagent_type: "Explore" },
							status: "success",
							result: "The report.",
							children: [
								{ type: "text", content: "Looking at the sender." },
								{
									type: "tool_call",
									tool: {
										id: "c1",
										name: "Grep",
										input: { pattern: "Retry-After" },
										status: "success",
									},
								},
								{
									type: "tool_call",
									tool: {
										id: "t2",
										name: "Agent",
										input: {
											description: "read backoff",
											subagent_type: "Plan",
										},
										status: "success",
									},
								},
							],
						},
					},
				],
			};
			render(<MessageItem sessionId="session-1" message={message} />);
			expect(screen.getByText("2 steps")).toBeVisible();

			await user.click(screen.getByRole("button", { name: /find retries/ }));
			await user.click(
				screen.getByRole("button", { name: "Process · 2 steps" }),
			);
			const group = screen.getByRole("group", {
				name: "Explore subagent's process",
			});
			const note = within(group).getByText("Looking at the sender.");
			expect(note.closest(".prose-note")).not.toBeNull();
			expect(within(group).getByText(/Retry-After/)).toBeVisible();
			expect(
				within(group).getByRole("button", { name: /read backoff/ }),
			).toBeVisible();
		});
	});

	// The summary rules themselves are covered in lib/toolSummary.test.ts; this
	// only checks that the call's input and the work dir reach the derivation.
	describe("file path display", () => {
		beforeEach(() => {
			mockWorkDir.value = "/Users/test/project";
		});

		it("shows a file call's path relative to the work directory", () => {
			const message: Message = {
				id: "fp-1",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						tool: {
							id: "tool-fp-1",
							name: "Read",
							input: {
								file_path: "/Users/test/project/src/components/Button.tsx",
							},
							status: "success",
						},
					},
				],
				status: "complete",
				createdAt: new Date(),
			};

			render(<MessageItem sessionId="session-1" message={message} />);
			// Two spans: the directories may be cut, the file name may not.
			expect(screen.getByText("src/components/")).toBeInTheDocument();
			expect(screen.getByText("Button.tsx")).toBeInTheDocument();
		});
	});

	describe("a run of calls folded into a group", () => {
		const bash = (
			id: string,
			status: "running" | "success" | "error" = "success",
		) => ({
			type: "tool_call" as const,
			tool: { id, name: "Bash", input: { command: `make ${id}` }, status },
		});
		const message = (
			parts: AssistantMessage["parts"],
			status: Message["status"] = "complete",
		): Message => ({
			id: "grouped",
			role: "assistant",
			parts,
			status,
			createdAt: new Date(),
		});
		const row = (id: string) =>
			screen.getByText(`make ${id}`).closest("button") as HTMLElement;

		it("shows the summary and the failures, and the rest once opened", async () => {
			const user = userEvent.setup();
			render(
				<MessageItem
					sessionId="session-1"
					message={message([bash("a"), bash("b", "error"), bash("c")])}
				/>,
			);

			expect(row("a")).not.toBeVisible();
			expect(row("b")).toBeVisible();
			expect(row("c")).not.toBeVisible();
			await user.click(screen.getByRole("button", { name: /Ran 2 commands/ }));
			expect(row("a")).toBeVisible();
			expect(row("c")).toBeVisible();
		});

		// The scroll anchor measures where an element sits, and one that is not
		// displayed measures as the top of the page.
		it("does not offer a folded row as a scroll anchor", () => {
			render(
				<MessageItem
					sessionId="session-1"
					message={message([bash("a"), bash("b")])}
				/>,
			);
			for (const id of ["a", "b"]) {
				expect(row(id).closest("[hidden]")).not.toHaveAttribute(
					"data-scroll-anchor",
				);
			}
		});

		// What the user is reading must not be folded out of sight under them.
		it("keeps a row the user opened in sight when its group forms, until they close it", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<MessageItem
					sessionId="session-1"
					message={message([bash("a", "running")], "streaming")}
				/>,
			);
			await user.click(row("a"));

			rerender(
				<MessageItem
					sessionId="session-1"
					message={message(
						[bash("a", "running"), bash("b", "running")],
						"streaming",
					)}
				/>,
			);
			expect(row("a")).toBeVisible();
			expect(row("a")).toHaveAttribute("aria-expanded", "true");
			expect(
				screen.getByText("make b", { selector: "[hidden] *" }),
			).not.toBeVisible();

			await user.click(row("a"));
			expect(row("a")).not.toBeVisible();
		});
	});
});
