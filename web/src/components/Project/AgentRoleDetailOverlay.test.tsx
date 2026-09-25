import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentOptionsStore } from "../../lib/agentOptionsStore";
import { useAgentRoleStore } from "../../lib/agentRoleStore";
import { useSettingsStore } from "../../lib/settingsStore";
import type { AgentRole } from "../../types/agentRole";
import AgentRoleDetailOverlay from "./AgentRoleDetailOverlay";

const deleteAgentRole = vi.fn();
const updateAgentRole = vi.fn();

vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (s: unknown) => unknown) =>
		selector({ actions: { deleteAgentRole, updateAgentRole } }),
}));

const role: AgentRole = {
	id: "r1",
	name: "Reviewer",
	role_prompt: "",
	steps: ["推进任务"],
	created_at: "2026-09-14T00:00:00Z",
	updated_at: "2026-09-14T00:00:00Z",
};

/**
 * The server's own sentence for a role work items still use, copied from
 * `rpc_agent_role.go` — which is where the wording is decided, and where
 * `TestAgentRoleDelete_RefusalIsPrintedVerbatim` holds it.
 */
const REFUSAL =
	"Can't delete: 3 work items still use this role. Change their role, or delete them, first.";

const renderOverlay = (onBack = vi.fn()) =>
	render(<AgentRoleDetailOverlay roleId="r1" onBack={onBack} />);

/** Delete Role, then the dialog's own Delete. */
async function attemptDelete(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "Delete Role" }));
	await user.click(screen.getByRole("button", { name: "Delete" }));
}

beforeEach(() => {
	vi.clearAllMocks();
	updateAgentRole.mockResolvedValue(undefined);
	useAgentRoleStore.setState({
		roles: [role],
		workRefCounts: {},
		isLoading: false,
		error: null,
	});
	useSettingsStore.setState({ settings: {}, error: null, refresh: null });
	useAgentOptionsStore.setState({
		models: { claude: [], codex: [] },
		efforts: { claude: [], codex: [] },
		error: null,
	});
});

describe("deleting an agent role", () => {
	// The server's refusal is a whole user-facing sentence and this is the one
	// place it is printed. A prefix of this screen's own would read as
	// "Failed to delete: Can't delete: ..." — so what is asserted is the whole
	// string and nothing around it.
	it("prints the server's refusal as it stands, with no prefix of its own", async () => {
		const user = userEvent.setup();
		deleteAgentRole.mockRejectedValue(new Error(REFUSAL));
		const onBack = vi.fn();
		renderOverlay(onBack);

		await attemptDelete(user);

		expect(screen.getByRole("alert").textContent).toBe(REFUSAL);
		// A refused delete leaves the user on the page they were told to act from.
		expect(onBack).not.toHaveBeenCalled();
	});

	// The count on the list row is pushed and can be a moment stale, so the
	// client never refuses ahead of the server: the request goes out and the
	// server is the one that says no.
	it("asks the server even when the role is in use", async () => {
		const user = userEvent.setup();
		deleteAgentRole.mockRejectedValue(new Error(REFUSAL));
		useAgentRoleStore.setState({ workRefCounts: { r1: 3 } });
		renderOverlay();

		await attemptDelete(user);

		expect(deleteAgentRole).toHaveBeenCalledWith("r1");
	});

	// The reason a previous attempt was refused is not the reason this one will
	// be — the count it named is exactly what the user went off to change.
	it("drops a stale refusal when the delete is tried again", async () => {
		const user = userEvent.setup();
		deleteAgentRole.mockRejectedValue(new Error(REFUSAL));
		const onBack = vi.fn();
		renderOverlay(onBack);

		await attemptDelete(user);
		expect(screen.getByRole("alert")).toBeInTheDocument();

		deleteAgentRole.mockResolvedValue(undefined);
		await attemptDelete(user);

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(onBack).toHaveBeenCalled();
	});
});

describe("the steps list", () => {
	// A class assertion, because jsdom lays nothing out: the overflow this guards
	// against has no other foothold in a unit test. The class is the prose root's
	// own, not passed in here — why it is needed is on `MarkdownContent`'s
	// `className` prop.
	it("keeps a step's markdown from widening the steps list", () => {
		renderOverlay();

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
