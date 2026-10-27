import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitWriteActions, useGitWriteStore } from "../../lib/gitWriteStore";
import DiffView from "./DiffView";

const navigate = vi.fn();
const stage = vi.fn();

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../hooks/useRouteState", () => ({
	useRouteState: () => ({ worktree: "", sessionId: null }),
}));
vi.mock("../../hooks/useGitDiffWatch", () => ({
	useGitDiffWatch: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../../hooks/useGitStatus", () => ({
	useGitStatus: () => ({
		data: { staged: [], unstaged: [{ path: "src/a.ts", status: "M" }] },
	}),
}));
vi.mock("../../hooks/useGitStage", () => ({
	useGitStage: () => ({
		stageMutation: { mutateAsync: stage },
		unstageMutation: { mutateAsync: vi.fn() },
	}),
}));
vi.mock("../../hooks/useGitDiscard", () => ({
	useGitDiscard: () => ({ mutateAsync: vi.fn() }),
}));

function deferred() {
	let reject: (e: unknown) => void = () => {};
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const failures = () => useGitWriteStore.getState().failures;

beforeEach(() => {
	navigate.mockReset();
	stage.mockReset();
	gitWriteActions.reset();
});

describe("DiffView stage answered after the reader left", () => {
	// Back to the list mid-stage: the diff is gone, so the failure goes to the
	// Changes list's banner rather than to nobody.
	it("hands a late failure to the Changes list", async () => {
		const user = userEvent.setup();
		const pending = deferred();
		stage.mockReturnValue(pending.promise);
		const { unmount } = render(<DiffView path="src/a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: /^Stage/ }));
		unmount();
		pending.reject(new Error("fatal: index.lock exists"));

		await waitFor(() =>
			expect(failures()[""]).toMatchObject({ paths: ["src/a.ts"] }),
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	// Following the file to its staged side would take the reader away from
	// wherever they went meanwhile.
	it("does not navigate for a stage that succeeds after the reader left", async () => {
		const user = userEvent.setup();
		const pending = deferred();
		stage.mockReturnValue(pending.promise);
		const { unmount } = render(<DiffView path="src/a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: /^Stage/ }));
		unmount();
		pending.resolve();

		await waitFor(() => expect(stage).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));
		expect(navigate).not.toHaveBeenCalled();
	});

	it("keeps a failure on the diff while the diff is on screen", async () => {
		const user = userEvent.setup();
		stage.mockRejectedValue(new Error("fatal: index.lock exists"));
		render(<DiffView path="src/a.ts" staged={false} />);

		await user.click(screen.getByRole("button", { name: /^Stage/ }));

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(failures()).toEqual({});
	});
});
