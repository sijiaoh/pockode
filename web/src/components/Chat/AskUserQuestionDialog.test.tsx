import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AskUserQuestionRequest } from "../../types/message";
import AskUserQuestionDialog from "./AskUserQuestionDialog";

describe("AskUserQuestionDialog", () => {
	const mockRequest: AskUserQuestionRequest = {
		requestId: "req-123",
		questions: [
			{
				question: "Which library should we use for date formatting?",
				header: "Library",
				options: [
					{ label: "date-fns", description: "Lightweight, modular" },
					{ label: "moment", description: "Full-featured, larger bundle" },
				],
				multiSelect: false,
			},
		],
	};

	it("displays question and options", () => {
		render(
			<AskUserQuestionDialog
				request={mockRequest}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		expect(screen.getByText("Library")).toBeInTheDocument();
		expect(
			screen.getByText("Which library should we use for date formatting?"),
		).toBeInTheDocument();
		expect(screen.getByText("date-fns")).toBeInTheDocument();
		expect(screen.getByText("moment")).toBeInTheDocument();
		expect(screen.getByText("Other")).toBeInTheDocument();
	});

	it("calls onSubmit with selected answer when Submit is clicked", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();

		render(
			<AskUserQuestionDialog
				request={mockRequest}
				onSubmit={onSubmit}
				onCancel={vi.fn()}
			/>,
		);

		// Select an option
		await user.click(screen.getByText("date-fns"));
		await user.click(screen.getByRole("button", { name: "Submit" }));

		expect(onSubmit).toHaveBeenCalledWith({
			"Which library should we use for date formatting?": "date-fns",
		});
	});

	it("calls onCancel when Cancel button is clicked", async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();

		render(
			<AskUserQuestionDialog
				request={mockRequest}
				onSubmit={vi.fn()}
				onCancel={onCancel}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape key", async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();

		render(
			<AskUserQuestionDialog
				request={mockRequest}
				onSubmit={vi.fn()}
				onCancel={onCancel}
			/>,
		);

		await user.keyboard("{Escape}");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("disables Submit button when no option is selected", () => {
		render(
			<AskUserQuestionDialog
				request={mockRequest}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		const submitButton = screen.getByRole("button", { name: "Submit" });
		expect(submitButton).toBeDisabled();
	});

	it("handles Other option with custom text", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();

		render(
			<AskUserQuestionDialog
				request={mockRequest}
				onSubmit={onSubmit}
				onCancel={vi.fn()}
			/>,
		);

		// Select Other and enter custom text
		await user.click(screen.getByText("Other"));
		const input = screen.getByPlaceholderText("Enter your answer...");
		await user.type(input, "luxon");
		await user.click(screen.getByRole("button", { name: "Submit" }));

		expect(onSubmit).toHaveBeenCalledWith({
			"Which library should we use for date formatting?": "Other: luxon",
		});
	});

	it("disables Submit when Other is selected but text is empty", async () => {
		const user = userEvent.setup();

		render(
			<AskUserQuestionDialog
				request={mockRequest}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
			/>,
		);

		await user.click(screen.getByText("Other"));
		const submitButton = screen.getByRole("button", { name: "Submit" });
		expect(submitButton).toBeDisabled();
	});

	describe("multiSelect mode", () => {
		const multiSelectRequest: AskUserQuestionRequest = {
			requestId: "req-multi",
			questions: [
				{
					question: "Which features do you want?",
					header: "Features",
					options: [
						{ label: "Dark mode", description: "Enable dark theme" },
						{ label: "Notifications", description: "Push notifications" },
						{ label: "Analytics", description: "Usage tracking" },
					],
					multiSelect: true,
				},
			],
		};

		it("allows selecting multiple options", async () => {
			const user = userEvent.setup();
			const onSubmit = vi.fn();

			render(
				<AskUserQuestionDialog
					request={multiSelectRequest}
					onSubmit={onSubmit}
					onCancel={vi.fn()}
				/>,
			);

			await user.click(screen.getByText("Dark mode"));
			await user.click(screen.getByText("Notifications"));
			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(onSubmit).toHaveBeenCalledWith({
				"Which features do you want?": "Dark mode, Notifications",
			});
		});

		it("allows deselecting options", async () => {
			const user = userEvent.setup();
			const onSubmit = vi.fn();

			render(
				<AskUserQuestionDialog
					request={multiSelectRequest}
					onSubmit={onSubmit}
					onCancel={vi.fn()}
				/>,
			);

			await user.click(screen.getByText("Dark mode"));
			await user.click(screen.getByText("Notifications"));
			await user.click(screen.getByText("Dark mode")); // Deselect
			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(onSubmit).toHaveBeenCalledWith({
				"Which features do you want?": "Notifications",
			});
		});

		it("allows Other with regular options in multiSelect", async () => {
			const user = userEvent.setup();
			const onSubmit = vi.fn();

			render(
				<AskUserQuestionDialog
					request={multiSelectRequest}
					onSubmit={onSubmit}
					onCancel={vi.fn()}
				/>,
			);

			await user.click(screen.getByText("Dark mode"));
			await user.click(screen.getByText("Other"));
			const input = screen.getByPlaceholderText("Enter your answer...");
			await user.type(input, "Custom feature");
			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(onSubmit).toHaveBeenCalledWith({
				"Which features do you want?": "Dark mode, Other: Custom feature",
			});
		});
	});

	describe("multiple questions", () => {
		const multiQuestionRequest: AskUserQuestionRequest = {
			requestId: "req-multi-q",
			questions: [
				{
					question: "Choose a framework",
					header: "Framework",
					options: [
						{ label: "React", description: "Component-based" },
						{ label: "Vue", description: "Progressive" },
					],
					multiSelect: false,
				},
				{
					question: "Choose a language",
					header: "Language",
					options: [
						{ label: "TypeScript", description: "Typed JavaScript" },
						{ label: "JavaScript", description: "Dynamic" },
					],
					multiSelect: false,
				},
			],
		};

		it("requires all questions to be answered", async () => {
			const user = userEvent.setup();

			render(
				<AskUserQuestionDialog
					request={multiQuestionRequest}
					onSubmit={vi.fn()}
					onCancel={vi.fn()}
				/>,
			);

			// Only answer first question
			await user.click(screen.getByText("React"));
			expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

			// Answer second question
			await user.click(screen.getByText("TypeScript"));
			expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
		});

		it("submits all answers", async () => {
			const user = userEvent.setup();
			const onSubmit = vi.fn();

			render(
				<AskUserQuestionDialog
					request={multiQuestionRequest}
					onSubmit={onSubmit}
					onCancel={vi.fn()}
				/>,
			);

			await user.click(screen.getByText("React"));
			await user.click(screen.getByText("TypeScript"));
			await user.click(screen.getByRole("button", { name: "Submit" }));

			expect(onSubmit).toHaveBeenCalledWith({
				"Choose a framework": "React",
				"Choose a language": "TypeScript",
			});
		});
	});
});
