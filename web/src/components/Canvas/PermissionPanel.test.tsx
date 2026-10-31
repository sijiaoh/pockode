import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedPermission } from "../../lib/permissionRequestStore";
import type { PermissionStatus } from "../../types/message";
import { ARM_MS } from "../Chat/SendStopSlot";
import { PermissionPanel } from "./PermissionPanel";

const permission = (
	id: string,
	status: PermissionStatus = "pending",
): ResolvedPermission => ({
	requestId: id,
	request: {
		requestId: id,
		toolName: "Bash",
		toolInput: { command: `run ${id}` },
		toolUseId: `tool-${id}`,
	},
	status,
});

function panel(
	permissions: ResolvedPermission[],
	props: Partial<Parameters<typeof PermissionPanel>[0]> = {},
) {
	return (
		<PermissionPanel
			active
			permissions={permissions}
			isCodex={false}
			onRespond={vi.fn()}
			onCollapse={vi.fn()}
			takeFocus={() => false}
			onUnmount={vi.fn()}
			refused={false}
			attempt={0}
			{...props}
		/>
	);
}

/** The card holding a command's text, by the command. */
const card = (command: string) => {
	const row = screen.getAllByText(command)[0];
	const found = row.closest<HTMLElement>("[data-permission-request-id]");
	if (!found) throw new Error(`no card for ${command}`);
	return found;
};

const isArmed = (button: HTMLElement) =>
	button.closest("[data-armed]")?.getAttribute("data-armed") === "true";

describe("PermissionPanel", () => {
	it("counts the requests still unanswered in its title", () => {
		const { rerender } = render(panel([permission("a"), permission("b")]));
		expect(
			screen.getByRole("dialog", { name: "2 permission requests" }),
		).toBeInTheDocument();
		rerender(panel([permission("a", "allowed"), permission("b")]));
		expect(
			screen.getByRole("dialog", { name: "Permission request" }),
		).toBeInTheDocument();
	});

	it("re-arms the cards still pending when one settles", async () => {
		const { rerender } = render(panel([permission("a"), permission("b")]));
		const allowB = () =>
			within(card("run b")).getByRole("button", { name: "Allow" });
		await waitFor(() => expect(isArmed(allowB())).toBe(true));

		rerender(panel([permission("a", "allowed"), permission("b")]));
		expect(isArmed(allowB())).toBe(false);
		await waitFor(() => expect(isArmed(allowB())).toBe(true));
	});

	it("ends the others' answers once one is denied on Claude, not on Codex", () => {
		const listed = [permission("a", "denied"), permission("b")];
		const { rerender } = render(panel(listed));
		expect(within(card("run b")).getByText("Ending the turn…")).toBeVisible();
		expect(
			within(card("run b")).queryByRole("button", { name: "Allow" }),
		).toBeNull();

		rerender(panel(listed, { isCodex: true }));
		expect(
			within(card("run b")).getByRole("button", { name: "Allow" }),
		).toBeInTheDocument();
	});

	it("collapses by Hide and by Escape", async () => {
		const user = userEvent.setup();
		const onCollapse = vi.fn();
		render(panel([permission("a")], { onCollapse }));
		await user.click(screen.getByRole("button", { name: /Hide/ }));
		await user.keyboard("{Escape}");
		expect(onCollapse).toHaveBeenCalledTimes(2);
	});

	it("collapses by the backdrop only once armed, across re-renders", async () => {
		// The clock the arming reads, held still so a slow machine cannot
		// carry the first press past it.
		let now = 1000;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
		try {
			const user = userEvent.setup();
			const onCollapse = vi.fn();
			const { rerender } = render(panel([permission("a")], { onCollapse }));
			const backdrop = screen.getByTestId("permission-panel-backdrop");
			await user.click(backdrop);
			expect(onCollapse).not.toHaveBeenCalled();

			now += ARM_MS;
			// A host re-rendering with a fresh close must not restart the wait.
			const later = vi.fn();
			rerender(panel([permission("a")], { onCollapse: later }));
			await user.click(backdrop);
			expect(later).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
		}
	});

	it("says a refused send in the title's place, keeping the dialog's name", () => {
		render(panel([permission("a")], { refused: true, attempt: 1 }));
		expect(
			screen.getByRole("dialog", { name: "Permission request" }),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Answer the permission request first.",
		);
	});
});
