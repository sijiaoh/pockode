import { render, screen, within } from "@testing-library/react";
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

/** Delete role, then the dialog's own Delete. */
async function attemptDelete(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "Delete role" }));
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

it("is headed Agent Role, with the way back to the list", async () => {
	const user = userEvent.setup();
	const onBack = vi.fn();
	renderOverlay(onBack);

	expect(
		screen.getByRole("heading", { level: 1, name: "Agent Role" }),
	).toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Back to agent roles" }));
	expect(onBack).toHaveBeenCalled();
});

// The list starts out loading and goes back to loading on every reconnect.
it("waits for the list rather than saying the role is not there", () => {
	useAgentRoleStore.setState({ roles: [], isLoading: true });
	const { rerender } = renderOverlay();

	expect(screen.getByRole("status")).toHaveAccessibleName(
		"Agent role: loading",
	);
	expect(screen.queryByText("Agent role not found")).not.toBeInTheDocument();

	useAgentRoleStore.setState({ isLoading: false });
	rerender(<AgentRoleDetailOverlay roleId="r1" onBack={vi.fn()} />);
	expect(screen.getByText("Agent role not found")).toBeInTheDocument();
});

describe("the summary under the name", () => {
	it("says the role is the default story role and how much uses it", () => {
		useSettingsStore.setState({ settings: { default_agent_role_id: "r1" } });
		useAgentRoleStore.setState({ workRefCounts: { r1: 12 } });
		renderOverlay();

		expect(screen.getByText("Default story role")).toBeInTheDocument();
		expect(screen.getByText("Used by 12 work items")).toBeInTheDocument();
	});

	// Before the snapshot nothing is known about the default, and a task-only
	// role a stale file names is no default at all.
	it("claims no default it cannot stand behind", () => {
		useSettingsStore.setState({ settings: null });
		const { unmount } = renderOverlay();
		expect(screen.queryByText("Default story role")).not.toBeInTheDocument();
		unmount();

		useSettingsStore.setState({ settings: { default_agent_role_id: "r1" } });
		useAgentRoleStore.setState({ roles: [{ ...role, work_type: "task" }] });
		renderOverlay();
		expect(screen.queryByText("Default story role")).not.toBeInTheDocument();
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

	it("says ahead of time what stands in the way", () => {
		useAgentRoleStore.setState({ workRefCounts: { r1: 1 } });
		renderOverlay();

		expect(
			screen.getByText(
				"1 work item uses this role. Change its role before deleting it.",
			),
		).toBeInTheDocument();
	});

	// The server accepts the delete and clears the default along with it.
	it("warns that deleting the default story role clears the default", async () => {
		const user = userEvent.setup();
		useSettingsStore.setState({ settings: { default_agent_role_id: "r1" } });
		renderOverlay();

		await user.click(screen.getByRole("button", { name: "Delete role" }));

		expect(
			screen.getByText(
				`Delete "Reviewer"? This cannot be undone. It's the default story role; deleting it clears that default.`,
			),
		).toBeInTheDocument();
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

	// The step's textarea is borderless and ringless so it can sit inline with
	// its number and handles; its card is what shows where focus is.
	it("shows focus on the card of the step being edited", async () => {
		const user = userEvent.setup();
		renderOverlay();
		await user.click(screen.getByRole("button", { name: "Edit steps" }));

		const card = screen.getByDisplayValue("推进任务").closest("li > div");
		expect(card?.classList).toContain("focus-within:border-th-border-focus");
	});
});

describe("the Runs field", () => {
	const group = () => screen.getByRole("group", { name: "Runs" });
	const segment = (name: string) =>
		within(group()).getByRole("button", { name });

	// "Both" is the cleared restriction, which the server reads from `""`;
	// leaving the field out would leave the old restriction in place.
	it.each([
		["Stories", "story"],
		["Tasks", "task"],
		["Both", ""],
	])("sends %s as work_type %j", async (label, workType) => {
		const user = userEvent.setup();
		useAgentRoleStore.setState({
			roles: [{ ...role, work_type: workType === "" ? "task" : undefined }],
		});
		renderOverlay();

		await user.click(segment(label));

		expect(updateAgentRole).toHaveBeenCalledWith({
			id: "r1",
			work_type: workType,
		});
	});

	// The lit segment is the server's record, not the tap: a refused write must
	// not leave the screen claiming a restriction the role does not have.
	it("lights the stored value and keeps it when the write is refused", async () => {
		const user = userEvent.setup();
		updateAgentRole.mockRejectedValue(new Error("nope"));
		renderOverlay();

		expect(segment("Both")).toHaveAttribute("aria-pressed", "true");
		await user.click(segment("Tasks"));

		expect(segment("Both")).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("alert").textContent).toBe("nope");

		updateAgentRole.mockResolvedValue(undefined);
		await user.click(segment("Stories"));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("offers Stories, Tasks and Both, in the order the list groups by", () => {
		renderOverlay();

		expect(
			within(group())
				.getAllByRole("button")
				.map((b) => b.textContent),
		).toEqual(["Stories", "Tasks", "Both"]);
	});

	it("says where a role that runs stories turns up", () => {
		useAgentRoleStore.setState({ roles: [{ ...role, work_type: "story" }] });
		renderOverlay();

		expect(
			screen.getByText("Runs stories. Can be the default story role."),
		).toBeInTheDocument();
	});

	// The server accepts it and clears the default: a second setting changing
	// as a side effect is worth one question first.
	it("asks before making the default story role task-only", async () => {
		const user = userEvent.setup();
		useSettingsStore.setState({ settings: { default_agent_role_id: "r1" } });
		renderOverlay();

		await user.click(segment("Tasks"));
		expect(updateAgentRole).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				"Reviewer is the default story role. Making it task-only clears that default.",
			),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(updateAgentRole).not.toHaveBeenCalled();

		await user.click(segment("Tasks"));
		await user.click(screen.getByRole("button", { name: "Make task-only" }));
		expect(updateAgentRole).toHaveBeenCalledWith({
			id: "r1",
			work_type: "task",
		});
	});

	// The server checks only when an assignment changes, so a restriction never
	// takes the role off work that has it — said only where there is such work.
	it("says work already on a restricted role keeps it, when there is any", () => {
		useAgentRoleStore.setState({
			roles: [{ ...role, work_type: "task" }],
			workRefCounts: { r1: 2 },
		});
		renderOverlay();

		expect(
			screen.getByText(
				"Picked by story agents for the tasks they create. Work items already using it keep it.",
			),
		).toBeInTheDocument();
	});

	it("does not mention existing work when the role is unrestricted", () => {
		useAgentRoleStore.setState({ workRefCounts: { r1: 2 } });
		renderOverlay();

		expect(screen.getByText("Can run stories and tasks.")).toBeInTheDocument();
	});
});
