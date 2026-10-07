import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetHeaderUIConfig,
	setHeaderUIConfig,
} from "../../lib/registries/headerUIRegistry";
import {
	resetSidebarUIConfig,
	setSidebarUIConfig,
} from "../../lib/registries/sidebarUIRegistry";
import { useSessionStore } from "../../lib/sessionStore";
import { type UploadItem, useUploadStore } from "../../lib/uploadStore";
import { useWorkStore } from "../../lib/workStore";
import { useWorktreeStore } from "../../lib/worktreeStore";
import type { WorkListItem } from "../../types/work";
import MainContainer from "./MainContainer";

// Pin wsStore status so ConnectionStatus renders a deterministic element
// (the "Connecting to server" status) we can assert on and against.
vi.mock("../../lib/wsStore", () => ({
	useWSStore: (selector: (state: { status: string }) => unknown) =>
		selector({ status: "disconnected" }),
}));

function renderMainContainer(
	props: {
		title?: string;
		onOpenSidebar?: () => void;
		onOpenSettings?: () => void;
	} = {},
) {
	return render(
		<MainContainer
			onOpenSidebar={props.onOpenSidebar ?? (() => {})}
			onOpenSettings={props.onOpenSettings ?? (() => {})}
			title={props.title}
		>
			<div data-testid="child" />
		</MainContainer>,
	);
}

describe("MainContainer", () => {
	afterEach(() => {
		resetHeaderUIConfig();
	});

	it("renders the default header with title, sidebar button, settings, and ConnectionStatus", () => {
		renderMainContainer({ title: "My Project" });

		expect(
			screen.getByRole("heading", { level: 1, name: "My Project" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Open sidebar" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Settings" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("status", { name: "Connecting to server" }),
		).toBeInTheDocument();
	});

	// A drawer is a dialog the button opens, and it is inert behind it while
	// open, so it never says "expanded"; a column is expanded in place.
	it.each([
		["drawer", "Open sidebar", "dialog", null],
		["column", "Expand sidebar", null, "false"],
	] as const)("names the %s's button for what it brings on screen", (sidebarKind, name, haspopup, expanded) => {
		render(
			<MainContainer onOpenSidebar={() => {}} sidebarKind={sidebarKind}>
				<div />
			</MainContainer>,
		);

		const button = screen.getByRole("button", { name });
		expect(button.getAttribute("aria-haspopup")).toBe(haspopup);
		expect(button.getAttribute("aria-expanded")).toBe(expanded);
	});

	it("hands a custom HeaderContent the sidebar's kind and the button's ref", () => {
		const ref = { current: null as HTMLButtonElement | null };
		setHeaderUIConfig({
			HeaderContent: ({ onOpenSidebar, sidebarKind, sidebarToggleRef }) => (
				<button type="button" ref={sidebarToggleRef} onClick={onOpenSidebar}>
					{sidebarKind}
				</button>
			),
		});

		render(
			<MainContainer
				onOpenSidebar={() => {}}
				sidebarKind="column"
				sidebarToggleRef={ref}
			>
				<div />
			</MainContainer>,
		);

		expect(ref.current).toBe(screen.getByRole("button", { name: "column" }));
	});

	describe("the sidebar button's dot", () => {
		afterEach(() => {
			resetSidebarUIConfig();
			useSessionStore.setState({ hasUnread: false });
			useWorkStore.setState({ works: [] });
			useUploadStore.setState({ items: [] });
		});

		const waitingWork: WorkListItem = {
			id: "w1",
			type: "task",
			title: "Task",
			status: "active",
			activity: "needs_permission",
			updated_at: "2026-03-04T00:00:00Z",
		};

		function failedUpload(): UploadItem {
			return {
				id: "u1",
				file: new File([""], "a.txt"),
				name: "a.txt",
				destPath: "",
				worktree: useWorktreeStore.getState().current,
				overwrite: false,
				status: "failed",
				progress: 0,
				error: "nope",
				canRetry: true,
				conflict: "none",
			};
		}

		// The dot has no name of its own; it is the button's only element
		// besides the icon.
		function dotOn(name: string) {
			return screen.getByRole("button", { name }).querySelector("span");
		}

		function renderButton(sidebarKind: "drawer" | "column") {
			render(
				<MainContainer onOpenSidebar={() => {}} sidebarKind={sidebarKind}>
					<div />
				</MainContainer>,
			);
			return sidebarKind === "drawer" ? "Open sidebar" : "Expand sidebar";
		}

		it.each([
			"drawer",
			"column",
		] as const)("is off on the %s's button while no tab has a badge", (kind) => {
			expect(dotOn(renderButton(kind))).toBeNull();
		});

		it.each([
			"drawer",
			"column",
		] as const)("lights as news on the %s's button for an unread session", (kind) => {
			useSessionStore.setState({ hasUnread: true });
			const dot = dotOn(renderButton(kind));
			expect(dot).toHaveClass("bg-th-accent");
		});

		it("lights as news for an upload the Files tab is holding", () => {
			useUploadStore.setState({ items: [failedUpload()] });
			expect(dotOn(renderButton("column"))).toHaveClass("bg-th-accent");
		});

		// A person being waited on outranks the news beside it.
		it("wears the attention tone when a work is waiting, even beside news", () => {
			useSessionStore.setState({ hasUnread: true });
			useWorkStore.setState({ works: [waitingWork] });
			expect(dotOn(renderButton("column"))).toHaveClass("bg-th-warning");
		});

		it("stays off when an extension's content replaces the tabs", () => {
			setSidebarUIConfig({ SidebarContent: () => null });
			useSessionStore.setState({ hasUnread: true });
			useWorkStore.setState({ works: [waitingWork] });
			expect(dotOn(renderButton("column"))).toBeNull();
		});
	});

	it("falls back to the default 'Pockode' title when no title prop is given", () => {
		renderMainContainer();

		expect(
			screen.getByRole("heading", { level: 1, name: "Pockode" }),
		).toBeInTheDocument();
	});

	// The text, never the heading: in a chat the title sits in the button that
	// opens the session panel, so the host keeps the `h1` either way.
	it("renders TitleComponent inside the h1 and forwards the title prop", () => {
		setHeaderUIConfig({
			TitleComponent: ({ title }) => (
				<span data-testid="custom-title">{`custom:${title}`}</span>
			),
		});

		renderMainContainer({ title: "My Project" });

		expect(screen.getByRole("heading", { level: 1 })).toContainElement(
			screen.getByTestId("custom-title"),
		);
		expect(screen.getByTestId("custom-title")).toHaveTextContent(
			"custom:My Project",
		);
		expect(
			screen.getByRole("button", { name: "Open sidebar" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Settings" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("status", { name: "Connecting to server" }),
		).toBeInTheDocument();
	});

	it("renders HeaderContent in place of the entire default header", () => {
		setHeaderUIConfig({
			HeaderContent: ({ title }) => (
				<header data-testid="custom-header">{`header:${title}`}</header>
			),
		});

		renderMainContainer({ title: "My Project" });

		expect(screen.getByTestId("custom-header")).toHaveTextContent(
			"header:My Project",
		);
		expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Open sidebar" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Settings" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("status", { name: "Connecting to server" }),
		).not.toBeInTheDocument();
	});

	it("prefers HeaderContent over TitleComponent when both are configured", () => {
		setHeaderUIConfig({
			HeaderContent: () => <header data-testid="custom-header" />,
			TitleComponent: () => <span data-testid="custom-title" />,
		});

		renderMainContainer();

		expect(screen.getByTestId("custom-header")).toBeInTheDocument();
		expect(screen.queryByTestId("custom-title")).not.toBeInTheDocument();
	});

	it("draws a caller's heading in place of the default title", () => {
		render(
			<MainContainer title="My Project" heading={<h1>Session title</h1>}>
				<div />
			</MainContainer>,
		);

		expect(
			screen.getByRole("heading", { level: 1, name: "Session title" }),
		).toBeInTheDocument();
		expect(screen.queryByText("My Project")).not.toBeInTheDocument();
	});

	// The session's settings are reachable through the heading alone, so a
	// header that replaces the default one is handed it to place.
	it("hands the heading to a custom HeaderContent", () => {
		setHeaderUIConfig({
			HeaderContent: ({ heading }) => <header>{heading}</header>,
		});

		render(
			<MainContainer heading={<button type="button">Session</button>}>
				<div />
			</MainContainer>,
		);

		expect(screen.getByRole("button", { name: "Session" })).toBeInTheDocument();
	});
});
