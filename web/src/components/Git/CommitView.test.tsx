import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitShowResult } from "../../types/git";
import CommitView from "./CommitView";

let commitQuery: {
	data?: GitShowResult;
	isLoading: boolean;
	error: Error | null;
};

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));

vi.mock("../../hooks/useGitCommit", () => ({
	useGitCommit: () => commitQuery,
}));

beforeEach(() => {
	commitQuery = { data: undefined, isLoading: true, error: null };
});

function heading() {
	return screen.getByRole("heading", { level: 1 });
}

describe("CommitView", () => {
	// The hash comes with the route; the subject has to be fetched, and the
	// hash does not stand in for it meanwhile.
	it("shows the hash at once and the subject as loading", () => {
		render(<CommitView hash="abc1234def" onBack={vi.fn()} />);

		expect(heading()).toHaveAttribute("aria-busy", "true");
		expect(heading()).toHaveTextContent(/^Loading, abc1234$/);
	});

	it("names the commit by its subject, with the short hash under it", () => {
		commitQuery = {
			data: {
				hash: "abc1234def",
				subject: "Fix the header",
				author: "a",
				date: "d",
				files: [],
			},
			isLoading: false,
			error: null,
		};
		render(<CommitView hash="abc1234def" onBack={vi.fn()} />);

		expect(heading()).toHaveTextContent(/^Fix the header, abc1234$/);
		expect(heading().querySelector("[title]")).toHaveAttribute(
			"title",
			"Fix the header — abc1234def",
		);
	});

	// No subject is coming, but the hash is still true.
	it("falls back to the hash when the commit cannot be read", () => {
		commitQuery = {
			data: undefined,
			isLoading: false,
			error: new Error("bad object"),
		};
		render(<CommitView hash="abc1234def" onBack={vi.fn()} />);

		expect(heading()).not.toHaveAttribute("aria-busy");
		expect(heading()).toHaveTextContent(/^abc1234$/);
	});
});
