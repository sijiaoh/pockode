import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resetHeaderUIConfig,
	setHeaderUIConfig,
} from "../../lib/registries/headerUIRegistry";
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

	it("renders the default header with title, menu, settings, and ConnectionStatus", () => {
		renderMainContainer({ title: "My Project" });

		expect(
			screen.getByRole("heading", { level: 1, name: "My Project" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Open menu" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Settings" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("status", { name: "Connecting to server" }),
		).toBeInTheDocument();
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
			screen.getByRole("button", { name: "Open menu" }),
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
			screen.queryByRole("button", { name: "Open menu" }),
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
