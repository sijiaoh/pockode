import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRoleStore } from "../lib/agentRoleStore";
import type { AgentRoleListChangedNotification } from "../types/agentRole";
import { useAgentRoleSubscription } from "./useAgentRoleSubscription";

const agentRoleListSubscribe = vi.fn();
const agentRoleListUnsubscribe = vi.fn();

vi.mock("../lib/wsStore", () => ({
	useWSStore: vi.fn((selector) =>
		selector({
			status: "connected",
			actions: { agentRoleListSubscribe, agentRoleListUnsubscribe },
		}),
	),
}));

vi.mock("../lib/worktreeStore", () => ({
	worktreeActions: {
		onWorktreeSwitchStart: vi.fn(() => () => {}),
		onWorktreeSwitchEnd: vi.fn(() => () => {}),
	},
}));

const role = {
	id: "r1",
	name: "Engineer",
	role_prompt: "",
	created_at: "",
	updated_at: "",
};

function notify(params: AgentRoleListChangedNotification) {
	const callback = agentRoleListSubscribe.mock.calls[0][0];
	act(() => callback(params));
}

beforeEach(() => {
	vi.clearAllMocks();
	agentRoleListUnsubscribe.mockResolvedValue(undefined);
	useAgentRoleStore.getState().reset();
	agentRoleListSubscribe.mockResolvedValue({
		id: "sub-1",
		initial: { items: [role], work_ref_counts: { r1: 2 } },
	});
});

describe("useAgentRoleSubscription", () => {
	it("takes the reference counts from the snapshot", async () => {
		renderHook(() => useAgentRoleSubscription(true));

		await waitFor(() =>
			expect(useAgentRoleStore.getState().roles).toEqual([role]),
		);
		expect(useAgentRoleStore.getState().workRefCounts).toEqual({ r1: 2 });
	});

	// The counts come from the work store, so they move on their own — with no
	// role notification beside them to carry them.
	it("replaces the counts wholesale when work changes them", async () => {
		renderHook(() => useAgentRoleSubscription(true));
		await waitFor(() => expect(agentRoleListSubscribe).toHaveBeenCalled());

		notify({
			id: "sub-1",
			operation: "ref_counts",
			work_ref_counts: { r2: 1 },
		});

		// Wholesale, not merged: a role that has dropped to zero is absent from
		// the map rather than sent as zero, so a merge would keep it forever.
		expect(useAgentRoleStore.getState().workRefCounts).toEqual({ r2: 1 });
		expect(useAgentRoleStore.getState().roles).toEqual([role]);
	});

	// A sync is the role half recovering from a dropped event, and the counts
	// are not its to throw away: clearing them here would leave a row on screen
	// whose count has gone missing, which is the one state the list has no way
	// to draw.
	it("leaves the counts alone when the roles are synced", async () => {
		renderHook(() => useAgentRoleSubscription(true));
		await waitFor(() =>
			expect(useAgentRoleStore.getState().workRefCounts).toEqual({ r1: 2 }),
		);

		const renamed = { ...role, name: "Engineer II" };
		notify({ id: "sub-1", operation: "sync", roles: [renamed] });

		expect(useAgentRoleStore.getState().roles).toEqual([renamed]);
		expect(useAgentRoleStore.getState().workRefCounts).toEqual({ r1: 2 });
	});
});
