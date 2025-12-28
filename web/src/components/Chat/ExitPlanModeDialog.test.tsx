import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "../../types/message";
import ExitPlanModeDialog from "./ExitPlanModeDialog";

describe("ExitPlanModeDialog", () => {
	const mockRequest: PermissionRequest = {
		requestId: "req-plan",
		toolName: "ExitPlanMode",
		toolInput: { plan: "# Plan\n\n1. Step one\n2. Step two" },
		toolUseId: "tool-use-plan",
	};

	it("displays plan content as markdown", () => {
		render(
			<ExitPlanModeDialog
				request={mockRequest}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("heading", { name: "Implementation Plan", level: 2 }),
		).toBeInTheDocument();
		expect(screen.getByText("Step one")).toBeInTheDocument();
		expect(screen.getByText("Step two")).toBeInTheDocument();
	});

	it("shows Approve Plan and Reject buttons", () => {
		render(
			<ExitPlanModeDialog
				request={mockRequest}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Approve Plan" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
	});

	it("calls onApprove when Approve Plan is clicked", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();

		render(
			<ExitPlanModeDialog
				request={mockRequest}
				onApprove={onApprove}
				onReject={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Approve Plan" }));
		expect(onApprove).toHaveBeenCalledTimes(1);
	});

	it("calls onReject when Reject is clicked", async () => {
		const user = userEvent.setup();
		const onReject = vi.fn();

		render(
			<ExitPlanModeDialog
				request={mockRequest}
				onApprove={vi.fn()}
				onReject={onReject}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Reject" }));
		expect(onReject).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape key", async () => {
		const user = userEvent.setup();
		const onReject = vi.fn();

		render(
			<ExitPlanModeDialog
				request={mockRequest}
				onApprove={vi.fn()}
				onReject={onReject}
			/>,
		);

		await user.keyboard("{Escape}");
		expect(onReject).toHaveBeenCalledTimes(1);
	});

	it("displays JSON fallback when plan field is missing", () => {
		const requestWithoutPlan: PermissionRequest = {
			...mockRequest,
			toolInput: { other: "data" },
		};

		render(
			<ExitPlanModeDialog
				request={requestWithoutPlan}
				onApprove={vi.fn()}
				onReject={vi.fn()}
			/>,
		);

		expect(screen.getByText(/"other": "data"/)).toBeInTheDocument();
	});
});
