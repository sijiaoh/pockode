import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../lib/agentOptionsStore";
import type { AgentRole } from "../../types/agentRole";
import AgentRoleEngineSelector from "./AgentRoleEngineSelector";

const updateAgentRole = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({ actions: { updateAgentRole } }),
}));

const createRole = (overrides: Partial<AgentRole> = {}): AgentRole => ({
	id: "role-1",
	name: "Engineer",
	role_prompt: "",
	created_at: "2026-09-12T00:00:00Z",
	updated_at: "2026-09-12T00:00:00Z",
	...overrides,
});

beforeEach(() => {
	updateAgentRole.mockReset().mockResolvedValue(undefined);
	useAgentOptionsStore.setState({
		models: {
			claude: [{ id: "opus", label: "Opus" }],
			codex: [{ id: "gpt-5", label: "GPT-5" }],
		},
		efforts: { claude: [{ id: "high", label: "High" }] },
		error: null,
	});
});

describe("AgentRoleEngineSelector", () => {
	it("reports an unset agent as following settings, with no model claimed", () => {
		render(<AgentRoleEngineSelector role={createRole()} />);

		expect(screen.getByRole("button")).toHaveTextContent("Follow settings");
		expect(screen.getByRole("button")).not.toHaveTextContent("Auto");
	});

	it("names the agent, the model and the effort once they are set", () => {
		render(
			<AgentRoleEngineSelector
				role={createRole({
					agent_type: "claude",
					model: "opus",
					effort: "high",
				})}
			/>,
		);

		expect(screen.getByRole("button")).toHaveTextContent(
			"Claude · Opus · High",
		);
	});

	it("shows an agent this build does not know by its own id", () => {
		render(
			// @ts-expect-error a server newer than this build can name an agent it has no entry for
			<AgentRoleEngineSelector role={createRole({ agent_type: "gemini" })} />,
		);

		expect(screen.getByRole("button")).toHaveTextContent("gemini · Auto");
		expect(screen.getByRole("button")).not.toHaveTextContent("Claude");
	});

	it("sends only the agent type, leaving the server to clear the rest", async () => {
		const user = userEvent.setup();
		render(
			<AgentRoleEngineSelector
				role={createRole({ agent_type: "claude", model: "opus" })}
			/>,
		);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));
		await user.click(screen.getByRole("radio", { name: /Codex/ }));

		expect(updateAgentRole).toHaveBeenCalledWith({
			id: "role-1",
			agent_type: "codex",
		});
	});

	it("reports a rejected choice inside the panel and keeps it open", async () => {
		const user = userEvent.setup();
		updateAgentRole.mockRejectedValue(new Error("model not available"));
		render(
			<AgentRoleEngineSelector role={createRole({ agent_type: "claude" })} />,
		);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));
		await user.click(screen.getByRole("radio", { name: /Opus/ }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"model not available",
		);
		expect(screen.getByRole("radio", { name: /Opus/ })).toBeInTheDocument();
	});

	it("still offers Auto for an agent the server no longer lists", async () => {
		const user = userEvent.setup();
		render(
			// @ts-expect-error the role outlived the agent it names
			<AgentRoleEngineSelector role={createRole({ agent_type: "gemini" })} />,
		);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));

		expect(screen.queryByText("Loading models…")).not.toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /Auto/ })).toBeInTheDocument();
	});

	it("drops a failure's message when the panel is closed", async () => {
		const user = userEvent.setup();
		updateAgentRole.mockRejectedValue(new Error("model not available"));
		render(
			<AgentRoleEngineSelector role={createRole({ agent_type: "claude" })} />,
		);

		const trigger = screen.getByRole("button", { name: /^Engine:/ });
		await user.click(trigger);
		await user.click(screen.getByRole("radio", { name: /Opus/ }));
		expect(await screen.findByRole("alert")).toBeInTheDocument();

		await user.click(trigger);
		await user.click(trigger);

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("leaves model and effort unpickable until an agent is chosen", async () => {
		const user = userEvent.setup();
		render(<AgentRoleEngineSelector role={createRole()} />);

		await user.click(screen.getByRole("button", { name: /^Engine:/ }));

		expect(
			screen.getByText("Pick an agent to choose its model and effort."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("radio", { name: /Opus/ }),
		).not.toBeInTheDocument();
	});
});
