import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TurnTail } from "../../lib/thinking";
import type {
	AssistantMessage,
	ContentPart,
	Message,
	SessionTurn,
	TurnBlocker,
	UserMessage,
} from "../../types/message";
import ActivityStrip from "./ActivityStrip";

const AT = new Date("2026-01-02T14:00:00Z");

function turn(
	phase: SessionTurn["phase"],
	blockers?: TurnBlocker[],
): SessionTurn {
	return { phase, open: phase !== "idle", since: AT.toISOString(), blockers };
}

const PERMISSION: TurnBlocker = {
	kind: "permission",
	request_id: "r1",
	raised_at: AT.toISOString(),
};
const BACKGROUND: TurnBlocker = {
	kind: "background",
	raised_at: AT.toISOString(),
};

function asked(content: string): UserMessage {
	return { id: "u1", role: "user", content, status: "complete", createdAt: AT };
}

function reply(
	parts: ContentPart[],
	status: AssistantMessage["status"] = "streaming",
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		id: "a1",
		role: "assistant",
		parts,
		status,
		createdAt: AT,
		...extra,
	};
}

const bash = (status: "running" | "success" = "running"): ContentPart => ({
	id: "p-bash",
	type: "tool_call",
	tool: {
		id: "t1",
		name: "Bash",
		input: { command: "npm test" },
		status,
	},
});

function tail(over: Partial<TurnTail> = {}): TurnTail {
	return {
		phase: "idle",
		thinking: null,
		onToggleThinking: () => {},
		...over,
	};
}

function strip(
	over: Partial<ComponentProps<typeof ActivityStrip>> & {
		messages?: Message[];
	} = {},
) {
	const props: ComponentProps<typeof ActivityStrip> = {
		sessionId: "s1",
		turn: turn("idle"),
		loaded: true,
		messages: [],
		tail: tail(),
		openedThoughtIds: new Set(),
		isCodex: false,
		onOpenInChat: vi.fn(),
		...over,
	};
	return { props, ...render(<ActivityStrip {...props} />) };
}

const details = () => screen.getByRole("button", { name: /^Turn details:/ });

describe("ActivityStrip", () => {
	it("is an empty box until the session and transcript have arrived", () => {
		strip({ loaded: false, messages: [asked("hi"), reply([bash()])] });
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByText("Not started")).toBeNull();
		expect(screen.queryByText(/Bash/)).toBeNull();
	});

	it("says Not started before any turn, with nothing to open", () => {
		strip();
		expect(screen.getByText("Not started")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("says the running reply's latest tool call", () => {
		strip({
			turn: turn("running"),
			messages: [
				asked("run the tests"),
				reply([{ id: "x", type: "text", content: "Let me check." }, bash()]),
			],
		});
		expect(details()).toHaveAccessibleName("Turn details: Bash npm test");
	});

	it("says the latest text's last line, Markdown stripped, skipping notices", () => {
		strip({
			turn: turn("running"),
			messages: [
				reply([
					bash("success"),
					{
						id: "x",
						type: "text",
						content: "First line\n\n**Done** — the checklist is up.\n",
					},
					{ id: "w", type: "warning", message: "Slow", code: "slow" },
				]),
			],
		});
		expect(details()).toHaveAccessibleName(
			"Turn details: Done — the checklist is up.",
		);
	});

	it("says what the agent is thinking now, while running", () => {
		strip({
			turn: turn("running"),
			tail: tail({
				phase: "running",
				thinking: {
					content: "Looking at it\nChecking the retry path",
					fullReasoning: "",
					joinedLate: false,
					expanded: false,
				},
			}),
			messages: [reply([bash("success")])],
		});
		expect(details()).toHaveAccessibleName(
			"Turn details: Thinking… · Checking the retry path",
		);
	});

	it("says a settled permission card's answer in words", () => {
		strip({
			turn: turn("blocked", [PERMISSION]),
			messages: [
				reply([
					{
						id: "p",
						type: "permission_request",
						request: {
							requestId: "r0",
							toolName: "Bash",
							toolInput: { command: "rm -rf build" },
							toolUseId: "t0",
						},
						status: "denied",
					},
				]),
			],
		});
		expect(details()).toHaveAccessibleName(
			"Turn details: Bash rm -rf build · Denied",
		);
	});

	it("says a pending permission card's call, with no answer", () => {
		strip({
			turn: turn("blocked", [PERMISSION]),
			messages: [
				reply([
					{
						id: "p",
						type: "permission_request",
						request: {
							requestId: "r1",
							toolName: "Bash",
							toolInput: { command: "make deploy" },
							toolUseId: "t1",
						},
						status: "pending",
					},
				]),
			],
		});
		expect(details()).toHaveAccessibleName("Turn details: Bash make deploy");
	});

	it("speaks for the reply above a message sent mid-turn", () => {
		strip({
			turn: turn("running"),
			messages: [reply([bash()]), asked("also check the docs")],
		});
		expect(details()).toHaveAccessibleName("Turn details: Bash npm test");
	});

	// A send from another device: the turn is reported before the reply's
	// first record, and the last reply's ending is not this turn's.
	it("does not lend a running turn the last reply's ending", () => {
		strip({
			turn: turn("running"),
			messages: [
				reply([{ id: "x", type: "text", content: "Halfway" }], "interrupted"),
			],
		});
		expect(details()).toHaveAccessibleName("Turn details: Working");
		expect(details()).toBeDisabled();
	});

	it("shows the turn clock only while running", () => {
		const running = tail({ phase: "running", openedAt: Date.now() - 10_000 });
		const { props, rerender } = strip({
			turn: turn("running"),
			tail: running,
			messages: [reply([bash()])],
		});
		expect(screen.getByText("10s")).toBeInTheDocument();

		rerender(
			<ActivityStrip
				{...props}
				turn={turn("blocked", [PERMISSION])}
				tail={{ ...running, phase: "blocked" }}
			/>,
		);
		expect(screen.queryByText("10s")).toBeNull();
	});

	it("says a background wait in the attention strip's words", () => {
		strip({
			turn: turn("blocked", [BACKGROUND]),
			messages: [reply([bash()])],
		});
		expect(details()).toHaveAccessibleName(
			"Turn details: Waiting on a background task",
		);
	});

	it("says Working at once for the optimistic placeholder", () => {
		strip({
			messages: [asked("go"), reply([], "sending")],
		});
		expect(details()).toHaveAccessibleName("Turn details: Working");
	});

	it("says how a reply ended before its latest item", () => {
		strip({
			messages: [
				reply([{ id: "x", type: "text", content: "Halfway" }], "interrupted"),
			],
		});
		expect(details()).toHaveAccessibleName("Turn details: Stopped · Halfway");
	});

	it("says an error in the error's own words", () => {
		strip({
			messages: [reply([bash("success")], "error", { error: "Rate limited" })],
		});
		expect(details()).toHaveAccessibleName("Turn details: Rate limited");
		expect(screen.getByText("Rate limited")).toHaveClass("text-th-error");
	});

	it("announces the phase when it changes, not where it started", () => {
		const { props, rerender } = strip({
			turn: turn("running"),
			messages: [reply([bash()])],
		});
		expect(screen.getByRole("status")).toHaveTextContent("");

		rerender(
			<ActivityStrip
				{...props}
				turn={turn("idle")}
				messages={[reply([bash("success")], "complete")]}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("Agent finished");
	});

	it("announces nothing when it first learns where the turn is", () => {
		const { props, rerender } = strip({
			loaded: false,
			turn: turn("running"),
			messages: [reply([bash()])],
		});
		rerender(<ActivityStrip {...props} loaded />);
		expect(screen.getByRole("status")).toHaveTextContent("");
	});

	it("opens the reply in a sheet, and Open in chat goes to its start", async () => {
		const user = userEvent.setup();
		const { props } = strip({
			messages: [
				asked("run the tests"),
				reply([{ id: "x", type: "text", content: "All green." }], "complete"),
			],
		});

		await user.click(details());
		const sheet = screen.getByRole("dialog", { name: "Last turn" });
		expect(within(sheet).getByText("run the tests")).toBeInTheDocument();
		expect(within(sheet).getByText("All green.")).toBeInTheDocument();
		// Chat view holds the per-message actions.
		expect(
			within(sheet).queryByRole("button", { name: "Copy message" }),
		).toBeNull();

		await user.click(
			within(sheet).getByRole("button", { name: "Open in chat" }),
		);
		expect(props.onOpenInChat).toHaveBeenCalledWith("a1");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	// A turn started on another device is reported before its first record.
	it("keeps an open sheet on its reply until the next one opens", async () => {
		const user = userEvent.setup();
		const last = reply(
			[{ id: "x", type: "text", content: "All green." }],
			"complete",
		);
		const { props, rerender } = strip({ messages: [asked("go"), last] });
		await user.click(details());

		rerender(<ActivityStrip {...props} turn={turn("running")} />);
		expect(
			within(screen.getByRole("dialog")).getByText("All green."),
		).toBeInTheDocument();

		const next = {
			...reply([{ id: "y", type: "text", content: "On it." }]),
			id: "a2",
		};
		rerender(
			<ActivityStrip
				{...props}
				turn={turn("running")}
				messages={[asked("go"), last, asked("again"), next]}
			/>,
		);
		expect(
			within(screen.getByRole("dialog")).getByText("On it."),
		).toBeInTheDocument();
	});

	it("does not reopen a sheet that went with what it showed", async () => {
		const user = userEvent.setup();
		const { props, rerender } = strip({
			messages: [reply([bash("success")], "complete")],
		});
		await user.click(details());
		rerender(<ActivityStrip {...props} loaded={false} />);
		expect(screen.queryByRole("dialog")).toBeNull();
		rerender(<ActivityStrip {...props} />);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("titles the sheet Current turn while a turn is open", async () => {
		const user = userEvent.setup();
		strip({ turn: turn("running"), messages: [reply([bash()])] });
		await user.click(details());
		expect(
			screen.getByRole("dialog", { name: "Current turn" }),
		).toBeInTheDocument();
	});
});
