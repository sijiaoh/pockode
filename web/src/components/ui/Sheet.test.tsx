import { ConfirmDialog, CoveredSurface, Sheet } from "@pockode/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `Sheet` itself lives in `packages/shared`, which has no vitest config of its
// own and no other component with a test; adding a third test entry point is a
// decision this move did not need to make. So the tests stay here, where the
// eight call sites they are really about are, and import the component the way
// those call sites do.
//
// Only "names the box by its title and the close button by its job" queries by
// accessible name. `getByRole(..., { name })` computes a name for every element
// of that role, each through jsdom's from-scratch `getComputedStyle`
// (docs/testing.md#a-test-that-really-is-slow), and the name is a contract of
// its own, so one test holds it and the rest reach elements by text or label.

/** The full-viewport flex container that parks the content box. */
function overlay(): HTMLElement {
	return screen.getByRole("dialog");
}

/** The flex column the header, body and footer live in. */
function contentBox(): HTMLElement {
	const box = screen.getByText("Title").parentElement?.parentElement;
	if (!box) throw new Error("content box not found");
	return box;
}

function body(): HTMLElement {
	const el = screen.getByText("Row").parentElement;
	if (!el) throw new Error("body not found");
	return el;
}

// One row: jsdom does no layout, so no row count makes the body overflow here,
// and nothing in `Sheet` reads how many children it has. The scroll is held as
// the class contract below, and the row is only a handle on the body.
function renderSheet() {
	render(
		<Sheet
			title="Title"
			onClose={() => {}}
			footer={<button type="button">Footer action</button>}
		>
			<p>Row</p>
		</Sheet>,
	);
}

// jsdom does no layout, so the cap is asserted as the class contract that
// produces it: an uncapped column is exactly as tall as its content, which
// leaves the body's overflow nothing to scroll and pushes the footer past both
// edges of a centered modal.
const CAPPED = /max-h-\[\d+dvh\]/;

describe("Sheet", () => {
	// The close button is an icon, so its aria-label is all a screen reader has
	// to call it; the box is labelled by the title so that focus landing on it
	// (see "focus") reads what the sheet is for.
	it("names the box by its title and the close button by its job", () => {
		renderSheet();

		expect(screen.getByRole("dialog", { name: "Title" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});

	it("caps its height against the viewport as a mobile drawer", () => {
		renderSheet();

		expect(contentBox().className).toMatch(CAPPED);
	});

	// A tablet held upright is below the expanded tier and keeps the drawer, so
	// the sheet stays under the thumb instead of floating out of reach in the
	// middle of the screen.
	it("sits at the bottom of the viewport as a drawer", () => {
		renderSheet();

		expect(overlay()).toHaveClass("items-end");
		expect(overlay()).not.toHaveClass("items-center");
	});

	describe("as a desktop modal", () => {
		// useIsExpanded reads (min-width: 1024px), which the setup's matchMedia
		// stub answers false for, so the default in tests is the mobile layout.
		// One hook decides both the class strings and the drag handle; there is
		// deliberately no width prefix restating it, so flipping this stub is
		// enough to move the whole component between its two forms.
		const original = window.matchMedia;
		const set = (value: typeof window.matchMedia) =>
			Object.defineProperty(window, "matchMedia", { writable: true, value });

		beforeEach(() => {
			set(((query: string) => ({
				matches: query.includes("min-width"),
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => true,
			})) as unknown as typeof window.matchMedia);
		});
		afterEach(() => set(original));

		it("caps its height against the viewport", () => {
			renderSheet();

			expect(contentBox().className).toMatch(CAPPED);
		});

		it("sits in the middle of the viewport", () => {
			renderSheet();

			expect(overlay()).toHaveClass("items-center");
			expect(overlay()).not.toHaveClass("items-end");
		});

		it("scrolls the body while the footer stays put", () => {
			renderSheet();

			expect(body()).toHaveClass("overflow-y-auto");
			// Without min-h-0 the body refuses to shrink below its content inside
			// the flex column, so the cap would be overflowed, not scrolled.
			expect(body()).toHaveClass("min-h-0");
			expect(body()).not.toContainElement(screen.getByText("Footer action"));
		});
	});

	describe("focus", () => {
		function renderMenu() {
			render(
				<Sheet title="Menu" onClose={() => {}}>
					<button type="button">Row A</button>
					<button type="button">Row B</button>
				</Sheet>,
			);
		}

		it("lands on the sheet itself, not on the close button", () => {
			renderMenu();

			// The box carries the label, so a screen reader reads the title before
			// anything else; stopping on "Close" would name the one row the user
			// least wants to press by accident.
			expect(overlay()).toHaveFocus();
			expect(screen.getByLabelText("Close")).not.toHaveFocus();
		});

		it("cycles Tab inside the sheet", async () => {
			const user = userEvent.setup();
			renderMenu();

			await user.tab();
			expect(screen.getByLabelText("Close")).toHaveFocus();
			await user.tab();
			await user.tab();
			expect(screen.getByText("Row B")).toHaveFocus();

			await user.tab();
			expect(screen.getByLabelText("Close")).toHaveFocus();
			await user.tab({ shift: true });
			expect(screen.getByText("Row B")).toHaveFocus();
		});

		it("hands focus back to whatever opened it", async () => {
			const user = userEvent.setup();

			function Toggle() {
				const [open, setOpen] = useState(false);
				return (
					<>
						<button type="button" onClick={() => setOpen(true)}>
							Actions
						</button>
						{open && (
							<Sheet title="Menu" onClose={() => setOpen(false)}>
								<button type="button">Row A</button>
							</Sheet>
						)}
					</>
				);
			}
			render(<Toggle />);

			await user.click(screen.getByText("Actions"));
			await user.click(screen.getByLabelText("Close"));

			expect(screen.getByText("Actions")).toHaveFocus();
		});

		// Form sheets focus their own field from an effect in the calling
		// component, which runs after the child Sheet's. Taking the box on open
		// must not undo that.
		it("yields to a caller that focuses its own field", () => {
			function FormSheet() {
				const inputRef = useRef<HTMLInputElement>(null);
				useEffect(() => {
					inputRef.current?.focus();
				}, []);
				return (
					<Sheet title="New branch" onClose={() => {}}>
						<input ref={inputRef} aria-label="Name" />
					</Sheet>
				);
			}
			render(<FormSheet />);

			expect(screen.getByLabelText("Name")).toHaveFocus();
		});

		// SyncSheet holds its force-push confirmation this way: portalled out of
		// the sheet's DOM, still a React child, and it goes up while the sheet is
		// non-dismissible — which is also when the sheet can be left with no
		// focusable of its own. The trap must not answer for the dialog's keys.
		it("leaves keys alone in a dialog portalled out of it", async () => {
			const user = userEvent.setup();
			const host = document.body.appendChild(document.createElement("div"));

			render(
				<Sheet title="Sync" onClose={() => {}} dismissible={false}>
					{createPortal(
						<>
							<button type="button">Cancel</button>
							<button type="button">Force push</button>
						</>,
						host,
					)}
				</Sheet>,
			);

			screen.getByText("Cancel").focus();
			await user.tab();

			expect(screen.getByText("Force push")).toHaveFocus();

			// Not left behind for the rest of the file: `cleanup` unmounts the
			// portal's contents but knows nothing about the node hosting them.
			host.remove();
		});

		// A menu swapped for a confirm sheet hands focus back to a trigger that is
		// still on the page, in the same commit that raises the confirm. The
		// handback has to land before the arriving sheet takes focus, not after,
		// or the confirm opens with focus on the page it covers.
		//
		// Why the trigger stays mounted: had it left with the menu, the handback
		// would be a no-op whenever it ran, since the DOM refuses focus to a
		// detached node.
		it("keeps focus in the arriving sheet when one sheet replaces another", async () => {
			const user = userEvent.setup();

			function Replacing() {
				const [step, setStep] = useState<"closed" | "menu" | "confirm">(
					"closed",
				);
				return (
					<>
						<button type="button" onClick={() => setStep("menu")}>
							Actions
						</button>
						{step === "menu" && (
							<Sheet title="Menu" onClose={() => {}}>
								<button type="button" onClick={() => setStep("confirm")}>
									Fork from here
								</button>
							</Sheet>
						)}
						{step === "confirm" && (
							<Sheet title="Confirm" onClose={() => {}}>
								<button type="button">Do it</button>
							</Sheet>
						)}
					</>
				);
			}
			render(<Replacing />);

			await user.click(screen.getByText("Actions"));
			await user.click(screen.getByText("Fork from here"));

			expect(screen.getByText("Confirm")).toBeVisible();
			expect(overlay()).toHaveFocus();
		});
	});

	// Every overlay in `@pockode/shared` shares one counted lock, and the page
	// stays locked for exactly as long as any of them is up. A per-overlay
	// save-and-restore fails both cases below: the overlay that mounts second
	// records "hidden" as the value to return to, and the page is left on it
	// whenever that overlay restores after the first. Closing in mount order
	// unlocks the page under the one still open and then leaves it
	// unscrollable; closing together leaves it unscrollable because cleanups
	// run parent-first, so the inner overlay writes last. Nothing on screen
	// says so — the sheet is gone and the scroll is simply dead.
	//
	// One sheet replacing another is not a third case: the leaving sheet's
	// cleanup runs before the arriving one's effect, so the lock is never held
	// twice and either implementation passes.
	describe("body scroll lock", () => {
		beforeEach(() => {
			document.body.style.overflow = "";
		});

		it("restores the page when a dialog raised inside it closes with it", async () => {
			const user = userEvent.setup();

			function FormSheet() {
				const [open, setOpen] = useState(true);
				const [confirming, setConfirming] = useState(false);
				if (!open) return null;
				return (
					<Sheet title="Add node" onClose={() => setOpen(false)}>
						<button type="button" onClick={() => setConfirming(true)}>
							Add
						</button>
						{confirming && (
							<ConfirmDialog
								title="Create directory?"
								message="It does not exist yet."
								onConfirm={() => {}}
								onCancel={() => setConfirming(false)}
							/>
						)}
					</Sheet>
				);
			}
			render(<FormSheet />);

			await user.click(screen.getByText("Add"));
			expect(document.body.style.overflow).toBe("hidden");

			// Escape reaches both: they listen on `document`, where stopping
			// propagation does not stop a sibling listener on the same node.
			await user.keyboard("{Escape}");

			expect(document.body.style.overflow).toBe("");
		});

		it("keeps the page locked until the last of two overlays closes", async () => {
			const user = userEvent.setup();

			function TwoSheets() {
				const [open, setOpen] = useState({ first: false, second: false });
				return (
					<>
						<button
							type="button"
							onClick={() => setOpen((o) => ({ ...o, first: true }))}
						>
							Open first
						</button>
						{open.first && (
							<Sheet
								title="First"
								onClose={() => setOpen((o) => ({ ...o, first: false }))}
							>
								<button
									type="button"
									onClick={() => setOpen((o) => ({ ...o, second: true }))}
								>
									Open second
								</button>
								<button
									type="button"
									onClick={() => setOpen((o) => ({ ...o, first: false }))}
								>
									Close first
								</button>
							</Sheet>
						)}
						{open.second && (
							<Sheet
								title="Second"
								onClose={() => setOpen((o) => ({ ...o, second: false }))}
							>
								<button
									type="button"
									onClick={() => setOpen((o) => ({ ...o, second: false }))}
								>
									Close second
								</button>
							</Sheet>
						)}
					</>
				);
			}
			render(<TwoSheets />);

			await user.click(screen.getByText("Open first"));
			await user.click(screen.getByText("Open second"));
			expect(document.body.style.overflow).toBe("hidden");

			// Mount order, not reverse: the first sheet goes while the second,
			// which recorded "hidden" as its own value to return to, stays up.
			await user.click(screen.getByText("Close first"));
			expect(screen.queryByText("First")).toBeNull();
			expect(document.body.style.overflow).toBe("hidden");

			await user.click(screen.getByText("Close second"));
			expect(document.body.style.overflow).toBe("");
		});
	});
	// A sheet is portalled to `document.body`, so nothing its host does to put
	// itself away — `visibility: hidden`, `inert`, either of which travels down
	// the DOM — reaches it. `CoveredSurface` is the same fact sent down the
	// React tree, which the portal did not leave.
	describe("a covered surface", () => {
		function Covering({ covered }: { covered: boolean }) {
			const [open, setOpen] = useState(true);
			return (
				<CoveredSurface covered={covered}>
					{open && (
						<Sheet title="Agent message" onClose={() => setOpen(false)}>
							<button type="button">Fork from here</button>
						</Sheet>
					)}
				</CoveredSurface>
			);
		}

		it("closes a sheet raised from a surface that gets covered", () => {
			const { rerender } = render(<Covering covered={false} />);
			expect(screen.queryByRole("dialog")).toBeInTheDocument();

			rerender(<Covering covered />);
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

			// Closed, not hidden: the host's open flag is down, so uncovering
			// hands back the surface rather than the sheet that was on it.
			rerender(<Covering covered={false} />);
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});

		// `dismissible` refuses an accidental dismissal while an operation is in
		// flight. Being covered is not one, and refusing here would leave a sheet
		// over the covering surface with its backdrop, its Escape and its close
		// button all turned off — no way out at all.
		it("covers one that is refusing to be dismissed", () => {
			function Busy({ covered }: { covered: boolean }) {
				const [open, setOpen] = useState(true);
				return (
					<CoveredSurface covered={covered}>
						{open && (
							<Sheet
								title="Fork session"
								dismissible={false}
								onClose={() => setOpen(false)}
							>
								<button type="button">Fork</button>
							</Sheet>
						)}
					</CoveredSurface>
				);
			}
			const { rerender } = render(<Busy covered={false} />);
			expect(screen.queryByRole("dialog")).toBeInTheDocument();

			rerender(<Busy covered />);
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		});
	});
});
