import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInputStore } from "../lib/inputStore";
import { WT_ROUTES } from "../lib/routes";
import { useSessionDetailStore } from "../lib/sessionDetailStore";
import { useWorktreeStore } from "../lib/worktreeStore";
import {
	makeSessionDetail,
	makeSessionListItem,
} from "../test/sessionFixtures";
import type { OverlayState } from "../types/overlay";
import { usePrefillComposer } from "./usePrefillComposer";

const route = vi.hoisted(() => ({
	sessionId: null as string | null,
	worktree: "wt",
	overlay: null as OverlayState,
	navigate: vi.fn(),
	router: { state: { location: { href: "/wt/git?session=s1" } } },
}));
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => route.navigate,
	useRouter: () => route.router,
}));
vi.mock("./useRouteState", () => ({
	useRouteState: () => ({
		sessionId: route.sessionId,
		worktree: route.worktree,
		overlay: route.overlay,
	}),
}));

const createSession = vi.hoisted(() => vi.fn());
vi.mock("../lib/sessionCreate", () => ({ createSession }));
const switchInFlight = vi.hoisted(() => ({ value: false }));
vi.mock("../lib/wsStore", () => ({
	isWorktreeSwitchInFlight: () => switchInFlight.value,
}));

// The composer must never be on screen empty for a frame, so the draft is
// read at the moment of the push.
let draftWhenPushed: { text?: string; reveal?: string } | null = null;

function pushedSession(): string | undefined {
	const [target] = route.navigate.mock.calls.at(-1) ?? [];
	expect(target).toMatchObject({ to: WT_ROUTES.session });
	expect(target.replace).toBeUndefined();
	return target.params.sessionId;
}

describe("usePrefillComposer", () => {
	beforeEach(() => {
		route.sessionId = "s1";
		route.overlay = { type: "git", segment: "changes" };
		route.router.state.location.href = "/wt/git?session=s1";
		switchInFlight.value = false;
		useWorktreeStore.setState({ current: "wt" });
		useSessionDetailStore
			.getState()
			.setDetail("s1", makeSessionDetail({ id: "s1" }));
		draftWhenPushed = null;
		route.navigate.mockImplementation((target) => {
			const { inputs, reveals } = useInputStore.getState();
			const id = target.params.sessionId;
			draftWhenPushed = { text: inputs[id], reveal: reveals[id] };
		});
	});

	afterEach(() => {
		useSessionDetailStore.getState().clear();
		useInputStore.setState({ inputs: {}, attachments: {}, reveals: {} });
		vi.clearAllMocks();
	});

	it("writes into the current session's draft and pushes its chat", async () => {
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(pushedSession()).toBe("s1");
		expect(route.navigate).toHaveBeenCalledTimes(1);
		expect(draftWhenPushed).toEqual({ text: "Explain this", reveal: "ready" });
		expect(createSession).not.toHaveBeenCalled();
	});

	// A Git detail keeps the composer under it, so the draft is already on
	// the page the message is about.
	it("stays on a page that keeps the composer, and reveals the draft there", async () => {
		route.overlay = { type: "diff", path: "a.ts", staged: false };
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(route.navigate).not.toHaveBeenCalled();
		expect(useInputStore.getState().inputs.s1).toBe("Explain this");
		expect(useInputStore.getState().reveals.s1).toBe("ready");
	});

	// The composer on the page is the route session's, not the new one's.
	it("still takes the user to a session it had to create", async () => {
		route.sessionId = null;
		route.overlay = { type: "diff", path: "a.ts", staged: false };
		createSession.mockResolvedValue(makeSessionListItem({ id: "new" }));
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(pushedSession()).toBe("new");
	});

	it("pushes once for a double press before the route moves", async () => {
		let land: () => void = () => {};
		route.navigate.mockReturnValue(
			new Promise<void>((r) => {
				land = r;
			}),
		);
		const { result } = renderHook(() => usePrefillComposer());

		let first: Promise<void> | undefined;
		act(() => {
			first = result.current.prefill("Explain this");
		});
		await act(() => result.current.prefill("Explain this"));
		await act(async () => {
			land();
			await first;
		});

		expect(route.navigate).toHaveBeenCalledTimes(1);
	});

	it("goes after the user's words, and says it was added", async () => {
		useInputStore.setState({ inputs: { s1: "Mine" } });
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(useInputStore.getState().inputs.s1).toBe("Mine\n\nExplain this");
		expect(useInputStore.getState().reveals.s1).toBe("added");
	});

	// Absent, deleted, or another worktree's: the detail held is what decides.
	it.each([
		["no session in the URL", null],
		["a session this worktree does not hold", "gone"],
	])("creates a session for %s", async (_, sessionId) => {
		route.sessionId = sessionId;
		createSession.mockResolvedValue(makeSessionListItem({ id: "new" }));
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(createSession).toHaveBeenCalledTimes(1);
		expect(useInputStore.getState().inputs.new).toBe("Explain this");
		expect(pushedSession()).toBe("new");
	});

	it("shows pending while creating, and ignores a second press", async () => {
		route.sessionId = null;
		let resolve: (value: unknown) => void = () => {};
		createSession.mockReturnValue(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const { result } = renderHook(() => usePrefillComposer());

		let first: Promise<void> | undefined;
		act(() => {
			first = result.current.prefill("Explain this");
		});
		expect(result.current.isPending).toBe(true);
		expect(route.navigate).not.toHaveBeenCalled();
		act(() => {
			result.current.prefill("Explain this");
		});

		await act(async () => {
			resolve(makeSessionListItem({ id: "new" }));
			await first;
		});
		expect(result.current.isPending).toBe(false);
		expect(createSession).toHaveBeenCalledTimes(1);
		expect(route.navigate).toHaveBeenCalledTimes(1);
	});

	it("does not pull away a user who moved on while it was creating", async () => {
		route.sessionId = null;
		createSession.mockImplementation(async () => {
			route.router.state.location.href = "/wt/git?segment=history";
			return makeSessionListItem({ id: "new" });
		});
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(useInputStore.getState().inputs.new).toBe("Explain this");
		expect(useInputStore.getState().reveals).toEqual({});
		expect(route.navigate).not.toHaveBeenCalled();
	});

	// The create would be answered in the worktree the connection is leaving.
	it("refuses to create while the worktree is still opening", async () => {
		route.sessionId = null;
		switchInFlight.value = true;
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(createSession).not.toHaveBeenCalled();
		expect(route.navigate).not.toHaveBeenCalled();
		expect(result.current.error?.summary).toBe("Couldn't start a new chat");
	});

	it("stays put and reports a failed create", async () => {
		route.sessionId = null;
		createSession.mockRejectedValue(new Error("Not connected"));
		const { result } = renderHook(() => usePrefillComposer());

		await act(() => result.current.prefill("Explain this"));

		expect(result.current.error).toEqual({
			summary: "Couldn't start a new chat",
			detail: "Not connected",
		});
		expect(route.navigate).not.toHaveBeenCalled();
		expect(useInputStore.getState().inputs).toEqual({});

		act(() => result.current.dismissError());
		expect(result.current.error).toBeNull();
	});
});
