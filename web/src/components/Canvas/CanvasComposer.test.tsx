import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inputActions, useInputStore } from "../../lib/inputStore";
import { CanvasComposer } from "./CanvasComposer";

/**
 * The host's half: it holds `expanded`, and its composer's send collapses it,
 * as ChatPanel's does. The composer stands in for `InputBar`, whose own
 * behaviour is its test's.
 */
function Host({
	turnOpen = false,
	onStop = () => {},
	disabled = false,
}: {
	turnOpen?: boolean;
	onStop?: () => void;
	disabled?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const draft = useInputStore((s) => s.inputs.s1 ?? "");
	return (
		<>
			<CanvasComposer
				sessionId="s1"
				expanded={expanded}
				onExpandedChange={setExpanded}
				turnOpen={turnOpen}
				onStop={onStop}
				disabled={disabled}
				blockedReason="Allow or deny to send"
			>
				<textarea
					aria-label="Draft"
					value={draft}
					onChange={(e) => inputActions.set("s1", e.target.value)}
				/>
				<button
					type="button"
					onClick={() => {
						inputActions.clear("s1");
						setExpanded(false);
					}}
				>
					Send
				</button>
			</CanvasComposer>
			<button type="button">Elsewhere</button>
		</>
	);
}

describe("CanvasComposer", () => {
	beforeEach(() => {
		useInputStore.setState({ inputs: {}, attachments: {}, reveals: {} });
	});

	it("opens for a prefill handed in from outside, so the composer can reveal it", () => {
		render(<Host />);
		expect(screen.queryByLabelText("Draft")).toBeNull();

		act(() => {
			inputActions.set("s1", "look at this");
			inputActions.requestReveal("s1", { landed: "ready" });
		});
		expect(screen.getByLabelText("Draft")).toHaveValue("look at this");
	});

	it("stays a line for a prefill while it cannot be opened", () => {
		useInputStore.setState({ reveals: { s1: { landed: "ready" } } });
		render(<Host disabled />);
		expect(screen.queryByLabelText("Draft")).toBeNull();
	});

	it("opens into the composer with the caret in it, and closes on sending", async () => {
		const user = userEvent.setup();
		render(<Host />);
		expect(screen.queryByLabelText("Draft")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Message…" }));
		expect(screen.getByLabelText("Draft")).toHaveFocus();

		await user.keyboard("hello");
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(screen.queryByLabelText("Draft")).toBeNull();
		// Where the caret was, rather than on the page's body.
		expect(screen.getByRole("button", { name: "Message…" })).toHaveFocus();
	});

	it("closes when left empty, and stays open over a draft", async () => {
		const user = userEvent.setup();
		render(<Host />);

		await user.click(screen.getByRole("button", { name: "Message…" }));
		await user.click(screen.getByRole("button", { name: "Elsewhere" }));
		await waitFor(() => expect(screen.queryByLabelText("Draft")).toBeNull());

		await user.click(screen.getByRole("button", { name: "Message…" }));
		await user.keyboard("half a thought");
		await user.click(screen.getByRole("button", { name: "Elsewhere" }));
		// Past the moment the focus is asked about.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(screen.getByLabelText("Draft")).toBeInTheDocument();
	});

	it("shows the draft on the collapsed line", () => {
		inputActions.set("s1", "first line\nsecond");
		render(<Host />);
		expect(
			screen.getByRole("button", { name: "first line" }),
		).toBeInTheDocument();
	});

	it("offers Stop while a turn is open", async () => {
		const onStop = vi.fn();
		const user = userEvent.setup();
		const { rerender } = render(<Host onStop={onStop} />);
		expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

		rerender(<Host turnOpen onStop={onStop} />);
		// Armed a moment after it arrives, as the composer's Stop is.
		const stop = await screen.findByRole("button", { name: "Stop" });
		// Real time, so a loaded machine gets room past `ARM_MS`.
		await vi.waitFor(
			() =>
				expect(stop.closest("[data-armed]")).toHaveAttribute(
					"data-armed",
					"true",
				),
			{ timeout: 5000 },
		);
		await user.click(stop);
		expect(onStop).toHaveBeenCalledOnce();
	});

	it("arms Stop again when a send puts it under the thumb", async () => {
		const user = userEvent.setup();
		render(<Host turnOpen />);
		await user.click(screen.getByRole("button", { name: "Message…" }));
		await user.keyboard("steer");
		await user.click(screen.getByRole("button", { name: "Send" }));

		const stop = screen.getByRole("button", { name: "Stop", hidden: true });
		expect(stop.closest("[data-armed]")).toHaveAttribute("data-armed", "false");
	});

	it("stays open when the window loses focus to a file picker", async () => {
		const user = userEvent.setup();
		render(<Host />);
		await user.click(screen.getByRole("button", { name: "Message…" }));
		// The window blurs; the field stays the active element.
		fireEvent.blur(screen.getByLabelText("Draft"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(screen.getByLabelText("Draft")).toBeInTheDocument();
	});

	it("says why it cannot be opened while sending is refused", () => {
		render(<Host disabled />);
		expect(
			screen.getByRole("button", { name: "Allow or deny to send" }),
		).toBeDisabled();
	});
});
