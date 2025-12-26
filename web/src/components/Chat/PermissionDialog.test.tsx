import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../../types/message";
import PermissionDialog from "./PermissionDialog";

describe("PermissionDialog", () => {
	const mockRequest: PermissionRequest = {
		requestId: "req-123",
		toolName: "Bash",
		toolInput: { command: "ls -la" },
		toolUseId: "tool-use-456",
	};

	it("displays tool name and input", () => {
		render(
			<PermissionDialog
				request={mockRequest}
				onAllow={vi.fn()}
				onAlwaysAllow={vi.fn()}
				onDeny={vi.fn()}
			/>,
		);

		expect(screen.getByText("Bash")).toBeInTheDocument();
		expect(screen.getByText(/"command": "ls -la"/)).toBeInTheDocument();
	});

	it("calls onAllow when Allow button is clicked", async () => {
		const user = userEvent.setup();
		const onAllow = vi.fn();

		render(
			<PermissionDialog
				request={mockRequest}
				onAllow={onAllow}
				onAlwaysAllow={vi.fn()}
				onDeny={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Allow" }));
		expect(onAllow).toHaveBeenCalledTimes(1);
	});

	it("calls onDeny when Deny button is clicked", async () => {
		const user = userEvent.setup();
		const onDeny = vi.fn();

		render(
			<PermissionDialog
				request={mockRequest}
				onAllow={vi.fn()}
				onAlwaysAllow={vi.fn()}
				onDeny={onDeny}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Deny" }));
		expect(onDeny).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape key", async () => {
		const user = userEvent.setup();
		const onDeny = vi.fn();

		render(
			<PermissionDialog
				request={mockRequest}
				onAllow={vi.fn()}
				onAlwaysAllow={vi.fn()}
				onDeny={onDeny}
			/>,
		);

		await user.keyboard("{Escape}");
		expect(onDeny).toHaveBeenCalledTimes(1);
	});
});
