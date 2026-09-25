import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import AgentRoleDetailOverlay from "./AgentRoleDetailOverlay";

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({
			actions: {
				updateAgentRole: vi.fn(),
				deleteAgentRole: vi.fn(),
			},
		}),
}));

// Stubbed out: it has its own tests and its own stores to seed, and nothing
// here asks anything of it.
vi.mock("./AgentRoleEngineSelector", () => ({ default: () => null }));

beforeEach(() => {
	useAgentRoleStore.setState({
		roles: [
			{
				id: "r1",
				name: "Engineer",
				role_prompt: "",
				steps: ["推进任务"],
				created_at: "2026-09-24T00:00:00Z",
				updated_at: "2026-09-24T00:00:00Z",
			},
		],
		isLoading: false,
		error: null,
	});
});

describe("AgentRoleDetailOverlay", () => {
	// A class assertion, because jsdom lays nothing out: the overflow this guards
	// against has no other foothold in a unit test. Why the class is required is
	// on `MarkdownContent`'s `className` prop.
	it("keeps a step's markdown from widening the steps list", () => {
		render(<AgentRoleDetailOverlay roleId="r1" onBack={vi.fn()} />);

		const row = screen.getByText("推进任务").closest("li");
		// The precondition the class depends on: `min-width: auto` only bites on a
		// flex item, so a row that stopped being a flex container would leave the
		// assertion below passing while meaning nothing.
		expect(row?.classList).toContain("flex");

		const markdown = screen.getByText("推进任务").closest("div.prose");
		expect(markdown?.parentElement).toBe(row);
		expect(markdown?.classList).toContain("min-w-0");
	});
});
