import { useCoverPage } from "@pockode/shared";
import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	permissionRequestActions,
	type TranscriptPermission,
	usePermissionRequestStore,
} from "../../lib/permissionRequestStore";
import type {
	MessageStatus,
	PermissionRequest,
	SessionTurn,
} from "../../types/message";
import { REFUSAL_SENTENCE_MS, usePermissionBatch } from "./usePermissionBatch";

const IDLE: SessionTurn = { phase: "idle", open: false, since: "" };

const blockedOn = (...ids: string[]): SessionTurn => ({
	phase: "blocked",
	open: true,
	since: "",
	blockers: ids.map((request_id) => ({
		kind: "permission",
		request_id,
		raised_at: "",
	})),
});

const request = (id: string): PermissionRequest => ({
	requestId: id,
	toolName: "Bash",
	toolInput: { command: `run ${id}` },
	toolUseId: `tool-${id}`,
});

interface Props {
	turn: SessionTurn;
	turnKnown?: boolean;
	isCodex?: boolean;
	replyStatus?: MessageStatus;
	shown?: boolean;
	transcript?: ReadonlyMap<string, TranscriptPermission>;
}

function setup(initial: Props) {
	return renderHook(
		({
			turn,
			turnKnown = true,
			isCodex = false,
			replyStatus,
			shown = true,
			transcript = new Map(),
		}: Props) =>
			usePermissionBatch({
				sessionId: "s1",
				turn,
				turnKnown,
				transcript,
				isCodex,
				replyStatus,
				shown,
			}),
		{ initialProps: initial },
	);
}

describe("usePermissionBatch", () => {
	beforeEach(() => {
		usePermissionRequestStore.setState({
			sessionId: null,
			records: {},
			outcomes: {},
			unreadable: {},
		});
		permissionRequestActions.reset("s1", [request("a"), request("b")]);
	});

	it("opens once per batch, and a collapse holds until the batch ends", () => {
		const { result, rerender } = setup({ turn: blockedOn("a") });
		expect(result.current.up).toBe(true);

		act(() => result.current.collapse());
		expect(result.current.up).toBe(false);
		expect(result.current.bannerUp).toBe(true);

		rerender({ turn: blockedOn("a", "b") });
		expect(result.current.up).toBe(false);
		expect(result.current.bannerCount).toBe(2);

		rerender({ turn: IDLE });
		rerender({ turn: blockedOn("b") });
		expect(result.current.up).toBe(true);
	});

	it("does not end a batch while the turn is unknown", () => {
		const { result, rerender } = setup({ turn: blockedOn("a") });
		act(() => result.current.collapse());

		// A reconnect: the detail is reloading, its turn a placeholder.
		rerender({ turn: IDLE, turnKnown: false });
		rerender({ turn: blockedOn("a") });
		expect(result.current.up).toBe(false);
	});

	it("keeps its state while canvas view is off the screen", () => {
		const { result, rerender } = setup({ turn: blockedOn("a"), shown: false });
		expect(result.current.up).toBe(false);
		expect(result.current.bannerUp).toBe(false);

		// A batch that started under chat view is open on coming back.
		rerender({ turn: blockedOn("a"), shown: true });
		expect(result.current.up).toBe(true);
	});

	it("waits while another layer is up", () => {
		function Layer() {
			useCoverPage(true, { onBack: () => {} });
			return null;
		}
		const layer = render(<Layer />);
		const { result, rerender } = setup({ turn: blockedOn("a") });
		expect(result.current.up).toBe(false);
		expect(result.current.bannerUp).toBe(true);

		layer.unmount();
		rerender({ turn: blockedOn("a") });
		expect(result.current.up).toBe(true);
	});

	it("lists a blocker with no record, unreadable only if the subscribe reply had none", () => {
		permissionRequestActions.reset("s1", [request("a")], ["a", "lost"]);
		const { result } = setup({ turn: blockedOn("a", "lost", "coming") });
		expect(
			result.current.permissions.map((p) => [p.request, p.unreadable]),
		).toEqual([
			[request("a"), undefined],
			[null, true],
			[null, undefined],
		]);
		expect(result.current.bannerCount).toBe(3);
		expect(result.current.oldest).toEqual(request("a"));
	});

	it("keeps the panel mounted, hidden, while canvas view is off the screen", () => {
		const { result, rerender } = setup({ turn: blockedOn("a") });
		rerender({ turn: blockedOn("a"), shown: false });
		expect(result.current.up).toBe(false);
		expect(result.current.drawn).toBe(true);

		rerender({ turn: blockedOn("a"), shown: true });
		expect(result.current.up).toBe(true);

		rerender({ turn: blockedOn("a"), shown: false });
		rerender({ turn: IDLE, shown: false });
		expect(result.current.drawn).toBe(false);
	});

	it("prefers the transcript's card to the store's", () => {
		const { result } = setup({
			turn: blockedOn("a"),
			transcript: new Map([["a", { request: request("a"), status: "denied" }]]),
		});
		expect(result.current.permissions[0].status).toBe("denied");
	});

	describe("the expiry line", () => {
		const endWith = (props: Partial<Props> = {}) => {
			const hook = setup({ turn: blockedOn("a", "b"), ...props });
			act(() => {
				permissionRequestActions.settle("s1", "a", {
					status: "expired",
					reason: "timeout",
				});
				permissionRequestActions.settle("s1", "b", {
					status: "expired",
					reason: "timeout",
				});
			});
			hook.rerender({ turn: IDLE, ...props });
			return hook;
		};

		it("says what expired once the batch is over, until dismissed", () => {
			const { result } = endWith();
			expect(result.current.expiryText).toBe(
				"2 permission requests expired: they were not answered in time, so they counted as denials and the tools did not run.",
			);
			act(() => result.current.dismissExpiry());
			expect(result.current.expiryText).toBeNull();
		});

		it("is not shown while the batch goes on", () => {
			const { result } = setup({ turn: blockedOn("a", "b") });
			act(() =>
				permissionRequestActions.settle("s1", "a", { status: "expired" }),
			);
			expect(result.current.expiryText).toBeNull();
		});

		it("is left out after a Stop, and stays out once the user sends again", () => {
			const { result, rerender } = endWith({ replyStatus: "interrupted" });
			expect(result.current.expiryText).toBeNull();
			// The send opens a reply that is not interrupted.
			rerender({ turn: IDLE, replyStatus: "streaming" });
			expect(result.current.expiryText).toBeNull();
		});

		it("waits, after a withdrawal with no reason, to learn whether it was a Stop", () => {
			// Codex's order: the approvals withdrawn while the turn runs on, the
			// turn's end, and only then the reply's `interrupted` record.
			const running: SessionTurn = { phase: "running", open: true, since: "" };
			const { result, rerender } = setup({
				turn: blockedOn("a"),
				isCodex: true,
				replyStatus: "streaming",
			});
			act(() =>
				permissionRequestActions.settle("s1", "a", { status: "expired" }),
			);
			rerender({ turn: running, isCodex: true, replyStatus: "streaming" });
			expect(result.current.expiryText).toBeNull();
			rerender({ turn: IDLE, isCodex: true, replyStatus: "streaming" });
			expect(result.current.expiryText).toBeNull();
			rerender({ turn: IDLE, isCodex: true, replyStatus: "interrupted" });
			expect(result.current.expiryText).toBeNull();
			// Latched: the next send's reply does not bring it back.
			rerender({ turn: IDLE, isCodex: true, replyStatus: "complete" });
			expect(result.current.expiryText).toBeNull();
		});

		it("says a withdrawal with no reason once the reply has ended on its own", () => {
			const { result, rerender } = setup({
				turn: blockedOn("a"),
				isCodex: true,
				replyStatus: "streaming",
			});
			act(() =>
				permissionRequestActions.settle("s1", "a", { status: "expired" }),
			);
			rerender({ turn: IDLE, isCodex: true, replyStatus: "streaming" });
			expect(result.current.expiryText).toBeNull();
			rerender({ turn: IDLE, isCodex: true, replyStatus: "complete" });
			expect(result.current.expiryText).toBe(
				"The agent stopped waiting for this request, so it counted as a denial and the tool did not run.",
			);
		});

		it("stays once said, through a Stop of the next turn", () => {
			const { result, rerender } = endWith();
			expect(result.current.expiryText).not.toBeNull();
			rerender({ turn: IDLE, replyStatus: "interrupted" });
			expect(result.current.expiryText).not.toBeNull();
		});

		it("is left out after a denial on Claude, not on Codex", () => {
			const deny = () =>
				permissionRequestActions.settle("s1", "b", { status: "denied" });
			const claude = setup({ turn: blockedOn("a", "b") });
			act(() => {
				deny();
				permissionRequestActions.settle("s1", "a", { status: "expired" });
			});
			claude.rerender({ turn: IDLE });
			expect(claude.result.current.expiryText).toBeNull();
			claude.unmount();

			// The same outcome — b denied, a expired — on Codex.
			const codex = setup({ turn: blockedOn("a", "b"), isCodex: true });
			codex.rerender({ turn: IDLE, isCodex: true });
			expect(codex.result.current.expiryText).toBe(
				"The agent stopped waiting for this request, so it counted as a denial and the tool did not run.",
			);
		});
	});

	it("says a refused send for 4s, restarted by each attempt", () => {
		vi.useFakeTimers();
		try {
			const { result } = setup({ turn: blockedOn("a") });
			act(() => result.current.sendRefused());
			expect(result.current.refused).toBe(true);
			act(() => vi.advanceTimersByTime(REFUSAL_SENTENCE_MS - 1000));
			act(() => result.current.sendRefused());
			act(() => vi.advanceTimersByTime(REFUSAL_SENTENCE_MS - 1000));
			expect(result.current.refused).toBe(true);
			expect(result.current.attempt).toBe(2);
			act(() => vi.advanceTimersByTime(1000));
			expect(result.current.refused).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
