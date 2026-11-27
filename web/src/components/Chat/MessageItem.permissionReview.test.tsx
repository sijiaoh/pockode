import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
	Message,
	PermissionAnswerer,
	PermissionReview,
	PermissionStatus,
} from "../../types/message";
import MessageItem from "./MessageItem";
import { PermissionReviewContext } from "./permissionReviewContext";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (
		selector: (state: { workDir: string; actions: object }) => unknown,
	) => selector({ workDir: "/w", actions: {} }),
	isRPCTimeout: () => false,
}));

// Who answers a permission card, or is answering it
// (docs/unattended-mode-ui.md §3).

function cardMessage(
	status: PermissionStatus,
	by?: PermissionAnswerer,
	review?: PermissionReview,
): Message {
	return {
		id: "m",
		role: "assistant",
		parts: [
			{
				type: "permission_request",
				id: "card-1",
				request: {
					requestId: "req-1",
					toolName: "Bash",
					toolInput: { command: "rm -rf out" },
					toolUseId: "tool-1",
				},
				status,
				by,
				review,
			},
		],
		status: "streaming",
		createdAt: new Date(),
	};
}

function draw(
	message: Message,
	{
		reviewing = [] as string[],
		sessionId = "main-1",
		onOpenSession = vi.fn() as ((id: string) => void) | undefined,
		onPermissionRespond = vi.fn(),
	} = {},
) {
	const { container } = render(
		<PermissionReviewContext.Provider
			value={{ reviewing: new Set(reviewing), sessionId, onOpenSession }}
		>
			<MessageItem
				sessionId={sessionId}
				message={message}
				onPermissionRespond={onPermissionRespond}
			/>
		</PermissionReviewContext.Provider>,
	);
	const card = container.querySelector<HTMLElement>(
		"[data-permission-request-id]",
	);
	if (!card) throw new Error("no permission card");
	return card;
}

describe("a permission card under review", () => {
	it("says the reviewer is checking it, folded and without the warning card", () => {
		const card = draw(cardMessage("pending"), { reviewing: ["req-1"] });

		expect(card).toHaveTextContent(
			"Permission reviewer is checking this. You can answer first.",
		);
		expect(card.className).not.toContain("th-warning");
		expect(screen.getByRole("status", { name: "under review" })).toBeVisible();
		// The row does not open itself: nobody is being asked.
		expect(
			screen.getByRole("button", { name: /Bash/, expanded: false }),
		).toBeInTheDocument();
	});

	it("folds itself when the review is known only after it was drawn", () => {
		// The turn comes with the session's detail, which can land after the
		// transcript: the card is first drawn as an ordinary request.
		const message = cardMessage("pending");
		const { rerender } = render(
			<PermissionReviewContext.Provider
				value={{ reviewing: new Set<string>(), sessionId: "main-1" }}
			>
				<MessageItem
					sessionId="main-1"
					message={message}
					onPermissionRespond={vi.fn()}
				/>
			</PermissionReviewContext.Provider>,
		);
		expect(
			screen.getByRole("button", { name: /Bash/, expanded: true }),
		).toBeInTheDocument();

		rerender(
			<PermissionReviewContext.Provider
				value={{ reviewing: new Set(["req-1"]), sessionId: "main-1" }}
			>
				<MessageItem
					sessionId="main-1"
					message={message}
					onPermissionRespond={vi.fn()}
				/>
			</PermissionReviewContext.Provider>,
		);
		expect(
			screen.getByRole("button", { name: /Bash/, expanded: false }),
		).toBeInTheDocument();
	});

	it("still takes the user's answer, with no answer pressed on them", async () => {
		const user = userEvent.setup();
		const onPermissionRespond = vi.fn();
		draw(cardMessage("pending"), {
			reviewing: ["req-1"],
			onPermissionRespond,
		});

		const allow = screen.getByRole("button", { name: "Allow" });
		expect(allow.className).not.toContain("bg-th-accent");
		await user.click(allow);
		expect(onPermissionRespond).toHaveBeenCalledWith(
			expect.objectContaining({ requestId: "req-1" }),
			"allow",
		);
	});

	it("is the ordinary warning card when its request is not the one reviewed", () => {
		const card = draw(cardMessage("pending"), { reviewing: ["req-other"] });

		expect(card).not.toHaveTextContent("Permission reviewer is checking");
		expect(card.className).toContain("th-warning");
		expect(screen.getByRole("button", { name: "Allow" }).className).toContain(
			"bg-th-accent",
		);
	});
});

it("does not offer an answer a read-only screen cannot give", () => {
	const { container } = render(
		<PermissionReviewContext.Provider
			value={{ reviewing: new Set(["req-1"]), sessionId: "main-1" }}
		>
			<MessageItem sessionId="main-1" message={cardMessage("pending")} />
		</PermissionReviewContext.Provider>,
	);
	expect(container).toHaveTextContent("Permission reviewer is checking this.");
	expect(container).not.toHaveTextContent("You can answer first");
});

describe("a permission card someone answered in the user's place", () => {
	it("names the reviewer's allow, with a way to the review", async () => {
		const user = userEvent.setup();
		const onOpenSession = vi.fn();
		const card = draw(
			cardMessage("allowed", "permission_reviewer", { sessionId: "rev-1" }),
			{ onOpenSession },
		);

		expect(card).toHaveTextContent("Allowed by the permission reviewer");
		await user.click(screen.getByRole("button", { name: "View review" }));
		expect(onOpenSession).toHaveBeenCalledWith("rev-1");
	});

	it("names the reviewer's deny by its category, and says why as plain text", () => {
		const card = draw(
			cardMessage("denied", "permission_reviewer", {
				sessionId: "rev-1",
				category: "system_reach_unverifiable",
				reason: "**$OUT** may be empty. See [here](https://x.test)",
			}),
		);

		expect(card).toHaveTextContent(
			"Denied by the permission reviewer — Can't verify what it reaches",
		);
		// Model output: never markdown, never a link.
		expect(card).toHaveTextContent(
			"**$OUT** may be empty. See [here](https://x.test)",
		);
		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});

	it("shows a category this build does not know as sent", () => {
		const card = draw(
			cardMessage("denied", "permission_reviewer", { category: "new_kind" }),
		);
		expect(card).toHaveTextContent(
			"Denied by the permission reviewer — new_kind",
		);
	});

	it("says Pockode denied it itself, muted, and why", () => {
		const card = draw(
			cardMessage("denied", "pockode", {
				sessionId: "rev-1",
				automatic: "timeout",
				reason: "the permission reviewer gave no verdict within 5 minutes.",
			}),
		);

		expect(card).toHaveTextContent("Denied by Pockode — No verdict in time");
		expect(card).toHaveTextContent(
			"the permission reviewer gave no verdict within 5 minutes.",
		);
		expect(screen.getByLabelText("denied").getAttribute("class")).toContain(
			"text-th-text-muted",
		);
		expect(
			screen.getByRole("button", { name: "View review" }),
		).toBeInTheDocument();
	});

	it("falls back for an automatic deny this build does not know", () => {
		const card = draw(cardMessage("denied", "pockode", { automatic: "new" }));
		expect(card).toHaveTextContent("Denied by Pockode — Denied automatically");
	});

	it("offers no way to a reviewer that never existed", () => {
		draw(
			cardMessage("denied", "pockode", {
				automatic: "reviewer_failed",
				reason: "could not start",
			}),
		);
		expect(
			screen.queryByRole("button", { name: "View review" }),
		).not.toBeInTheDocument();
	});

	// A reviewer's own request is denied in its own transcript, naming itself.
	it("offers no way to the session already on screen", () => {
		draw(
			cardMessage("denied", "pockode", {
				sessionId: "rev-1",
				automatic: "reviewer_request",
			}),
			{ sessionId: "rev-1" },
		);
		expect(
			screen.queryByRole("button", { name: "View review" }),
		).not.toBeInTheDocument();
	});

	// No verdict line: it says so as the row the card becomes will.
	it("says only that the person denied it", () => {
		const card = draw(cardMessage("denied"));
		expect(card).toHaveTextContent("Denied by you");
		expect(card).not.toHaveTextContent(/Denied by (the|Pockode)/);
	});

	// Pressed and not yet recorded, the card is the row about to run; once
	// recorded, a card still standing has its call's row elsewhere.
	it("runs an allowed card until its answer is recorded", () => {
		const pressed = draw(cardMessage("allowed"));
		expect(within(pressed).getByRole("status")).toHaveAccessibleName(
			"Bash running",
		);
		pressed.remove();

		const message = cardMessage("allowed");
		if (message.role !== "assistant") throw new Error("not a reply");
		const recorded = draw({
			...message,
			parts: message.parts.map((part) => ({ ...part, answerRecorded: true })),
		});
		expect(within(recorded).queryByRole("status")).toBeNull();
		expect(within(recorded).getByLabelText("allowed")).toBeInTheDocument();
	});

	it("says nothing more for a person's allow", () => {
		const card = draw(cardMessage("allowed"));
		expect(card).not.toHaveTextContent(/Allowed by/);
	});
});
