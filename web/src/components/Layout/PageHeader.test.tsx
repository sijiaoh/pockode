import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDetailStore } from "../../lib/sessionDetailStore";
import { makeSessionDetail } from "../../test/sessionFixtures";
import { FileNameTitle, HeaderSubtitle } from "../ui/HeaderTitle";
import PageHeader, {
	FilePageHeader,
	PageHeaderTarget,
	usePageHeaderHost,
} from "./PageHeader";

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ sessionId: "s1" }),
}));

/** A stand-in for `ChatPanel`: the header above, the page below. */
function Host({ page }: { page: React.ReactNode }) {
	const host = usePageHeaderHost();
	return (
		<>
			<header>{host.claimed ? host.outlet : <h1>Project</h1>}</header>
			<main>
				<PageHeaderTarget value={host.target}>{page}</PageHeaderTarget>
			</main>
		</>
	);
}

describe("PageHeader", () => {
	beforeEach(() => {
		useSessionDetailStore.getState().clear();
	});

	it("draws the page's heading in the host's header", () => {
		render(
			<Host
				page={
					<PageHeader
						back={{ to: "chat", onClick: vi.fn() }}
						title={<FileNameTitle name="App.tsx" />}
						subtitle={<HeaderSubtitle detail="src/" status="Unstaged" />}
					/>
				}
			/>,
		);

		const header = within(screen.getByRole("banner"));
		expect(header.getByRole("heading", { level: 1 })).toHaveTextContent(
			"App.tsx, src/·Unstaged",
		);
		expect(
			header.getByRole("button", { name: "Back to chat" }),
		).toBeInTheDocument();
		expect(screen.getByRole("main")).toBeEmptyDOMElement();
	});

	it("leaves the header to the host over a page that draws none", () => {
		render(<Host page={<p>no heading</p>} />);

		expect(
			screen.getByRole("heading", { level: 1, name: "Project" }),
		).toBeInTheDocument();
	});

	// A page rendered on its own, as in its own tests, still says what it is.
	it("draws the heading where it stands outside a host", () => {
		render(
			<PageHeader
				back={{ to: "parent", label: "Back to commit", onClick: vi.fn() }}
				title="Fix the header"
			/>,
		);

		expect(
			screen.getByRole("heading", { level: 1, name: "Fix the header" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Back to commit" }),
		).toBeInTheDocument();
	});

	it("makes the title a button when it opens something", async () => {
		const user = userEvent.setup();
		const onTitleClick = vi.fn();
		render(
			<PageHeader
				back={{ to: "chat", onClick: vi.fn() }}
				title="App.tsx"
				fullText="src/App.tsx — Unstaged"
				onTitleClick={onTitleClick}
				titleActionLabel="Open App.tsx"
			/>,
		);

		const title = screen.getByRole("button", { name: "Open App.tsx" });
		expect(title).toHaveAttribute("title", "src/App.tsx — Unstaged");
		await user.click(title);
		expect(onTitleClick).toHaveBeenCalled();
	});

	// No stand-in title while the data is on its way, and nothing to press
	// before what it would do is known.
	it("says it is loading rather than naming anything", () => {
		render(<PageHeader back={null} title={null} subtitle={null} />);

		const heading = screen.getByRole("heading", { level: 1 });
		expect(heading).toHaveAttribute("aria-busy", "true");
		expect(heading).toHaveTextContent("Loading");
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("lights the way back to a chat with unread messages", () => {
		useSessionDetailStore
			.getState()
			.setDetail("s1", makeSessionDetail({ id: "s1", unread: true }));
		render(
			<PageHeader back={{ to: "chat", onClick: vi.fn() }} title="App.tsx" />,
		);

		// The dot has no text of its own; it is the button's only child element
		// besides the icon.
		expect(
			screen
				.getByRole("button", { name: "Back to chat" })
				.querySelector("span"),
		).not.toBeNull();
	});
});

describe("FilePageHeader", () => {
	it("names the file, then its folder and which version this is", () => {
		render(
			<FilePageHeader
				path="web/src/App.tsx"
				status="Unstaged"
				back={{ to: "chat", onClick: vi.fn() }}
			/>,
		);

		const heading = screen.getByRole("heading", { level: 1 });
		expect(heading).toHaveTextContent("App.tsx, web/src·Unstaged");
		expect(heading.querySelector("[title]")).toHaveAttribute(
			"title",
			"web/src/App.tsx — Unstaged",
		);
	});

	// A second line with nothing on it would push the name off centre.
	it("has a title alone for a file at the root with no status", () => {
		render(
			<FilePageHeader
				path="README.md"
				back={{ to: "chat", onClick: vi.fn() }}
			/>,
		);

		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
			/^README\.md$/,
		);
	});

	it("opens the file it names by default", async () => {
		const user = userEvent.setup();
		const onTitleClick = vi.fn();
		render(
			<FilePageHeader
				path="src/App.tsx"
				back={{ to: "chat", onClick: vi.fn() }}
				onTitleClick={onTitleClick}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Open App.tsx" }));
		expect(onTitleClick).toHaveBeenCalled();
	});
});
