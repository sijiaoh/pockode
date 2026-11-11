import { MEDIA_QUERIES } from "@pockode/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CloudLinkChangedNotification,
	CloudLinkFlow,
	CloudLinkStatus,
	CloudLinkUnlinked,
} from "../../../types/cloudLink";
import CloudLinkSection from "./CloudLinkSection";

/**
 * The server's side of `cloud_link.*`: the snapshot each subscribe answers
 * with, and the requests, each held until the test answers it.
 */
const server = vi.hoisted(() => ({
	snapshot: null as unknown as CloudLinkStatus | Error,
	notify: null as ((params: CloudLinkChangedNotification) => void) | null,
	subscribes: 0,
	start: null as unknown as () => Promise<CloudLinkFlow>,
	cancel: null as unknown as (flowId: string) => Promise<CloudLinkFlow>,
	unlink: null as unknown as () => Promise<CloudLinkUnlinked>,
}));

vi.mock("../../../lib/wsStore", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../../lib/wsStore")>();
	const { create } = await import("zustand");
	const useWSStore = create(() => ({
		status: "connected" as string,
		actions: {
			cloudLinkSubscribe: async (
				callback: (params: CloudLinkChangedNotification) => void,
			) => {
				server.subscribes++;
				server.notify = callback;
				const snapshot = server.snapshot;
				if (snapshot instanceof Error) throw snapshot;
				return { id: `sub-${server.subscribes}`, initial: snapshot };
			},
			cloudLinkUnsubscribe: async () => {},
			cloudLinkStart: () => server.start(),
			cloudLinkCancel: (flowId: string) => server.cancel(flowId),
			cloudLinkUnlink: () => server.unlink(),
		},
	}));
	return {
		useWSStore,
		isRPCTimeout: original.isRPCTimeout,
		isInvalidParamsRejection: original.isInvalidParamsRejection,
	};
});

const { useWSStore } = await import("../../../lib/wsStore");

const CLOUD = "https://cloud.example.com";
const MACHINE = "ada@studio-mac";

function status(over: Partial<CloudLinkStatus> = {}): CloudLinkStatus {
	return {
		cloud_url: CLOUD,
		credential: "none",
		relay: "guest",
		machine_name: MACHINE,
		...over,
	};
}

const LINKED = status({
	credential: "linked",
	relay: "attached",
	email: "ada@example.com",
});

let revision = 0;
// Never reset: the flows a page started outlive the section, so an id reused
// by a later test would already count as started here.
let flowIds = 0;
function flow(over: Partial<CloudLinkFlow> = {}): CloudLinkFlow {
	return {
		id: `flow-${++flowIds}`,
		revision: ++revision,
		phase: "starting",
		started_at: new Date().toISOString(),
		...over,
	};
}

function waiting(over: Partial<CloudLinkFlow> = {}): CloudLinkFlow {
	return flow({
		phase: "waiting",
		user_code: "BCDFGHJK",
		verification_url: `${CLOUD}/link#BCDFGHJK`,
		expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
		...over,
	});
}

/** A request the test answers when it chooses. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function push(next: CloudLinkStatus) {
	act(() => server.notify?.({ id: "sub", status: next }));
}

/** Drops the socket and comes back, so the section subscribes afresh. */
async function reconnect(snapshot: CloudLinkStatus) {
	server.snapshot = snapshot;
	act(() => useWSStore.setState({ status: "reconnecting" }));
	await act(async () => useWSStore.setState({ status: "connected" }));
}

/** The machine row's title and the line under it. */
async function findRow(title: string, subtitle?: string) {
	const line = await screen.findByText(title, { selector: "p" });
	if (subtitle !== undefined) {
		expect(line.nextElementSibling).toHaveTextContent(subtitle);
	}
	return line;
}

function setFinePointer(fine: boolean) {
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: fine && query === MEDIA_QUERIES.finePointer,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => true,
		}),
	});
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
	revision = 0;
	server.snapshot = status();
	server.notify = null;
	server.subscribes = 0;
	server.start = () => Promise.reject(new Error("start not expected"));
	server.cancel = () => Promise.reject(new Error("cancel not expected"));
	server.unlink = () => Promise.reject(new Error("unlink not expected"));
	useWSStore.setState({ status: "connected" });
});

afterEach(() => {
	window.matchMedia = originalMatchMedia;
});

describe("CloudLinkSection", () => {
	describe("the card", () => {
		it("names the machine before it is linked", async () => {
			render(<CloudLinkSection />);
			await findRow("Not linked", MACHINE);
			expect(screen.getByRole("button", { name: "Link" })).toBeEnabled();
			expect(screen.queryByText(/This Pockode/)).not.toBeInTheDocument();
		});

		it("is green and names the account only once this Pockode is listed", async () => {
			server.snapshot = LINKED;
			const { container } = render(<CloudLinkSection />);
			await findRow("Linked as ada@example.com", MACHINE);
			await findRow("This Pockode is listed", "cloud.example.com");
			expect(container.querySelector(".text-th-success")).not.toBeNull();
			expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
				"href",
				CLOUD,
			);

			// A relay still catching up: the account is not known *now*.
			push({ ...LINKED, relay: "pending", email: undefined });
			await findRow("Linked", MACHINE);
			await findRow("Adding this Pockode…");
			expect(screen.queryByText(/ada@example\.com/)).not.toBeInTheDocument();
			expect(container.querySelector(".text-th-success")).toBeNull();
		});

		it.each([
			[
				"not_attached",
				"This Pockode isn't listed",
				"Linking again won't fix this",
			],
			["guest", "This Pockode isn't listed", "The server log says why"],
			["disabled", "This Pockode isn't listed", "Remote access is off"],
		] as const)("draws relay %s on the instance row", async (relay, title, subtitle) => {
			server.snapshot = status({ credential: "linked", relay });
			render(<CloudLinkSection />);
			await findRow("Linked", MACHINE);
			await findRow(title, subtitle);
		});

		it("offers to link again when the cloud refuses the link, with no instance row", async () => {
			server.snapshot = status({ credential: "linked", relay: "link_invalid" });
			render(<CloudLinkSection />);
			await findRow("Link no longer valid", MACHINE);
			expect(screen.getByRole("button", { name: "Link again" })).toBeEnabled();
			expect(screen.getByRole("button", { name: "Unlink" })).toBeEnabled();
			expect(screen.queryByText(/This Pockode/)).not.toBeInTheDocument();
		});

		it("names another cloud's link, and asks before linking over it", async () => {
			const user = userEvent.setup();
			server.snapshot = status({
				credential: "other_cloud",
				other_cloud_url: "https://other.example.org",
			});
			server.start = vi.fn(() => new Promise<CloudLinkFlow>(() => {}));
			render(<CloudLinkSection />);
			await findRow("Linked to another cloud", "other.example.org");

			await user.click(screen.getByRole("button", { name: "Link" }));
			const dialog = screen.getByRole("dialog", {
				name: "Link to cloud.example.com instead?",
			});
			expect(dialog).toHaveTextContent(
				/linked to other\.example\.org only until/,
			);
			expect(dialog).toHaveTextContent(MACHINE);
			expect(server.start).not.toHaveBeenCalled();

			await user.click(within(dialog).getByRole("button", { name: "Link" }));
			expect(server.start).toHaveBeenCalledTimes(1);
		});

		it("shows linking as unavailable, with nothing to retry", async () => {
			server.snapshot = new JSONRPCErrorException("no config dir", -32013);
			render(<CloudLinkSection />);
			await findRow(
				"Linking unavailable",
				"This Pockode can't store a cloud link",
			);
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
		});

		it("never draws a failed read as Not linked", async () => {
			const user = userEvent.setup();
			server.snapshot = new Error("cloud.json: permission denied");
			render(<CloudLinkSection />);
			await findRow("Couldn't read the link status", "Retry, or reload");
			expect(
				screen.getByText("cloud.json: permission denied"),
			).toBeInTheDocument();
			expect(screen.queryByText("Not linked")).not.toBeInTheDocument();

			server.snapshot = status();
			await user.click(screen.getByRole("button", { name: "Retry" }));
			await findRow("Not linked");
		});

		it("keeps the last status while disconnected, with its actions off", async () => {
			render(<CloudLinkSection />);
			await findRow("Not linked");
			act(() => useWSStore.setState({ status: "reconnecting" }));
			expect(screen.getByText("Not linked")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Link" })).toBeDisabled();
		});
	});

	describe("the link sheet", () => {
		it("starts a flow and shows its code and link, nowhere but the page", async () => {
			const user = userEvent.setup();
			const reply = deferred<CloudLinkFlow>();
			server.start = vi.fn(() => reply.promise);
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));

			const sheet = screen.getByRole("dialog", { name: /Link this machine/ });
			expect(sheet).toHaveTextContent(MACHINE);
			// The flow's id is not known yet, and cancel needs it.
			expect(
				within(sheet).getByRole("button", { name: "Cancel" }),
			).toBeDisabled();

			const started = waiting();
			await act(async () => reply.resolve(started));
			expect(await within(sheet).findByText("BCDF-GHJK")).toBeInTheDocument();
			expect(
				within(sheet).getByText("Code: B C D F, G H J K"),
			).toBeInTheDocument();
			expect(
				within(sheet).getByRole("link", { name: /Open approval page/ }),
			).toHaveAttribute("href", started.verification_url);
			// A phone gets no QR code: it would ask the phone to scan itself.
			expect(within(sheet).queryByRole("img", { name: /QR code/ })).toBeNull();
			expect(
				within(sheet).getByRole("button", { name: "Cancel" }),
			).toBeEnabled();

			expect(JSON.stringify({ ...localStorage })).not.toContain("BCDFGHJK");
			expect(window.location.href).not.toContain("BCDFGHJK");
		});

		it("leads with a QR code under a fine pointer", async () => {
			setFinePointer(true);
			const user = userEvent.setup();
			const started = waiting();
			server.start = () => Promise.resolve(started);
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));

			expect(
				await screen.findByRole("img", {
					name: "QR code for the approval page",
				}),
			).toBeInTheDocument();
			expect(
				screen.getByRole("link", { name: /Open on this computer/ }),
			).toHaveAttribute("href", started.verification_url);
		});

		it("continues the running flow without starting another", async () => {
			const user = userEvent.setup();
			server.snapshot = status({ flow: waiting() });
			server.start = vi.fn(() => Promise.reject(new Error("no")));
			render(<CloudLinkSection />);
			await findRow("Linking…", "· started earlier");

			await user.click(screen.getByRole("button", { name: "Continue" }));
			expect(await screen.findByText("BCDF-GHJK")).toBeInTheDocument();
			expect(server.start).not.toHaveBeenCalled();
		});

		it("never calls the user's own flow one started earlier", async () => {
			const user = userEvent.setup();
			const started = waiting();
			server.start = () => Promise.resolve(started);
			const { unmount } = render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));
			await screen.findByText("BCDF-GHJK");
			await user.keyboard("{Escape}");
			const row = await findRow("Linking…");
			expect(row.nextElementSibling).not.toHaveTextContent("started earlier");

			// Leaving Settings and coming back is still this page.
			unmount();
			server.snapshot = status({ flow: started });
			render(<CloudLinkSection />);
			const again = await findRow("Linking…");
			expect(again.nextElementSibling).not.toHaveTextContent("started earlier");
		});

		it("ignores an ended flow while its start is out", async () => {
			const user = userEvent.setup();
			server.snapshot = status({
				flow: flow({ phase: "failed", failure: { reason: "expired" } }),
			});
			server.start = () => new Promise<CloudLinkFlow>(() => {});
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));

			const sheet = screen.getByRole("dialog", { name: /Link this machine/ });
			expect(
				within(sheet).getByText("Starting…", { selector: "p" }),
			).toBeInTheDocument();
			expect(within(sheet).queryByText("This code expired")).toBeNull();
		});

		it("shows a refused start with Try again", async () => {
			const user = userEvent.setup();
			server.start = vi.fn(() => Promise.reject(new Error("cloud is down")));
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"cloud is down",
			);
			server.start = vi.fn(() => Promise.resolve(waiting()));
			await user.click(screen.getByRole("button", { name: "Try again" }));
			expect(await screen.findByText("BCDF-GHJK")).toBeInTheDocument();
		});

		it("lets a refused start give way to a flow started elsewhere", async () => {
			const user = userEvent.setup();
			server.start = () => Promise.reject(new Error("cloud is down"));
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));
			await screen.findByRole("alert");

			const elsewhere = waiting();
			push(status({ flow: elsewhere }));
			expect(await screen.findByText("BCDF-GHJK")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).toBeNull();

			// And how that flow ends is shown, not a fresh "Starting…".
			push(
				status({
					flow: flow({
						id: elsewhere.id,
						phase: "failed",
						failure: { reason: "expired" },
					}),
				}),
			);
			expect(
				await screen.findByRole("heading", { name: "This code expired" }),
			).toBeInTheDocument();
		});

		it("closes into Unavailable when start answers -32013", async () => {
			const user = userEvent.setup();
			server.start = () =>
				Promise.reject(new JSONRPCErrorException("no config dir", -32013));
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));

			await findRow("Linking unavailable");
			expect(screen.queryByRole("dialog")).toBeNull();
		});

		it("keeps the newer copy whichever arrives first, the reply or the notification", async () => {
			const user = userEvent.setup();
			const replies = [deferred<CloudLinkFlow>(), deferred<CloudLinkFlow>()];
			let call = 0;
			server.start = () => replies[call++].promise;
			render(<CloudLinkSection />);

			// The notification first, then the reply with the flow as it was when
			// start answered: older.
			await user.click(await screen.findByRole("button", { name: "Link" }));
			const starting = flow();
			push(status({ flow: waiting({ id: starting.id }) }));
			await act(async () => replies[0].resolve(starting));
			expect(await screen.findByText("BCDF-GHJK")).toBeInTheDocument();

			// The reply first, then a notification that was overtaken.
			await user.keyboard("{Escape}");
			push(status({ flow: flow({ phase: "canceled" }) }));
			await user.click(await screen.findByRole("button", { name: "Link" }));
			const stale = flow();
			await act(async () =>
				replies[1].resolve(waiting({ id: stale.id, user_code: "MNPQRSTV" })),
			);
			await screen.findByText("MNPQ-RSTV");
			push(status({ flow: stale }));
			expect(screen.getByText("MNPQ-RSTV")).toBeInTheDocument();
		});

		it("only Cancel cancels: closing leaves the flow running", async () => {
			const user = userEvent.setup();
			server.cancel = vi.fn();
			server.start = () => Promise.resolve(waiting());
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));
			await screen.findByText("BCDF-GHJK");

			await user.keyboard("{Escape}");
			expect(screen.queryByRole("dialog")).toBeNull();
			await findRow("Linking…");
			expect(screen.getByText(/^Expires in \d+:\d\d$/)).toBeInTheDocument();
			expect(server.cancel).not.toHaveBeenCalled();

			await user.click(screen.getByRole("button", { name: "Continue" }));
			expect(await screen.findByText("BCDF-GHJK")).toBeInTheDocument();
		});

		it("closes on a cancel that took", async () => {
			const user = userEvent.setup();
			const running = waiting();
			server.snapshot = status({ flow: running });
			server.cancel = vi.fn(() =>
				Promise.resolve({
					...running,
					phase: "canceled",
					revision: 99,
				} as CloudLinkFlow),
			);
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));
			await user.click(await screen.findByRole("button", { name: "Cancel" }));

			expect(server.cancel).toHaveBeenCalledWith(running.id);
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			await findRow("Not linked");
			// A cancel is somebody's deliberate act: nothing to tell.
			expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
		});

		it("stays open on the phase an approval reached before the cancel", async () => {
			const user = userEvent.setup();
			const running = waiting();
			server.snapshot = status({ flow: running });
			server.cancel = () =>
				Promise.resolve(flow({ id: running.id, phase: "finishing" }));
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));
			await user.click(await screen.findByRole("button", { name: "Cancel" }));

			const sheet = screen.getByRole("dialog", { name: /Link this machine/ });
			expect(
				await within(sheet).findByText("Approved, saving the link…", {
					selector: "p",
				}),
			).toBeInTheDocument();
			// A flow holding a token can no longer be cancelled.
			expect(
				within(sheet).queryByRole("button", { name: "Cancel" }),
			).toBeNull();
		});

		it("stays open with the error when the cancel fails, until the flow moves on", async () => {
			const user = userEvent.setup();
			const running = waiting();
			server.snapshot = status({ flow: running });
			server.cancel = () => Promise.reject(new Error("socket closed"));
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));
			await user.click(await screen.findByRole("button", { name: "Cancel" }));

			// The flow may still be running: the sheet must not say otherwise.
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Couldn't cancel: socket closed",
			);
			expect(screen.getByRole("dialog")).toBeInTheDocument();

			// Approved meanwhile: the error was about a button that is gone.
			push({
				...LINKED,
				flow: flow({
					id: running.id,
					phase: "linked",
					email: "ada@example.com",
				}),
			});
			expect(
				await screen.findByRole("heading", { name: "This machine is linked" }),
			).toBeInTheDocument();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("does not carry a cancel's error over to a newer flow", async () => {
			const user = userEvent.setup();
			server.snapshot = status({ flow: waiting() });
			server.cancel = () => Promise.reject(new Error("socket closed"));
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));
			await user.click(await screen.findByRole("button", { name: "Cancel" }));
			await screen.findByRole("alert");

			push(status({ flow: waiting({ user_code: "MNPQRSTV" }) }));
			expect(await screen.findByText("MNPQ-RSTV")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("follows a newer flow after a cancel answered invalid params", async () => {
			const user = userEvent.setup();
			server.snapshot = status({ flow: waiting() });
			server.cancel = () =>
				Promise.reject(
					new JSONRPCErrorException(
						"no such flow",
						JSONRPCErrorCode.InvalidParams,
					),
				);
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));
			await user.click(await screen.findByRole("button", { name: "Cancel" }));

			push(
				status({ flow: waiting({ id: "flow-newer", user_code: "MNPQRSTV" }) }),
			);
			expect(await screen.findByText("MNPQ-RSTV")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).toBeNull();
		});

		it("picks up on reconnect in the server's phase, Linked included", async () => {
			const user = userEvent.setup();
			const running = waiting();
			server.snapshot = status({ flow: running });
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));

			act(() => useWSStore.setState({ status: "reconnecting" }));
			// The sheet keeps its flow while the socket is down.
			expect(screen.getByText("BCDF-GHJK")).toBeInTheDocument();
			expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

			await reconnect({
				...LINKED,
				relay: "pending",
				email: undefined,
				flow: flow({
					id: running.id,
					phase: "linked",
					email: "ada@example.com",
				}),
			});
			const sheet = screen.getByRole("dialog", { name: /Link this machine/ });
			expect(
				await within(sheet).findByText("Linked as ada@example.com"),
			).toBeInTheDocument();
			expect(
				within(sheet).getByText("Adding this Pockode…"),
			).toBeInTheDocument();
			expect(
				within(sheet).getByRole("link", { name: /Open cloud\.example\.com/ }),
			).toHaveAttribute("href", CLOUD);
		});

		it("reads a running flow missing from the snapshot as a restart", async () => {
			const user = userEvent.setup();
			server.snapshot = status({ flow: waiting() });
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));

			await reconnect(status());
			expect(
				await screen.findByRole("heading", {
					name: "Pockode restarted, so linking stopped.",
				}),
			).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Start again" })).toBeEnabled();
		});

		it("keeps an ending on screen through a restart", async () => {
			const user = userEvent.setup();
			server.snapshot = status({
				flow: flow({ phase: "failed", failure: { reason: "declined" } }),
			});
			render(<CloudLinkSection />);
			// No running flow: Link starts one, which ends at once.
			const ended = flow({ phase: "failed", failure: { reason: "declined" } });
			server.start = () => Promise.resolve(ended);
			await user.click(await screen.findByRole("button", { name: "Link" }));
			const declined = { name: "Linking was declined" };
			expect(await screen.findByRole("heading", declined)).toBeInTheDocument();

			await reconnect(status());
			expect(screen.getByRole("heading", declined)).toBeInTheDocument();
		});

		it.each([
			["expired", "This code expired", "Start again"],
			["declined", "Linking was declined", "Start again"],
			["other", "Linking failed", "Try again"],
		] as const)("tells failure %s with its own action", async (reason, title, retry) => {
			const user = userEvent.setup();
			server.start = () =>
				Promise.resolve(
					flow({
						phase: "failed",
						failure: { reason, detail: "HTTP 500" },
						left_behind: true,
					}),
				);
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Link" }));

			const sheet = screen.getByRole("dialog", { name: /Link this machine/ });
			expect(
				await within(sheet).findByRole("heading", { name: title }),
			).toBeInTheDocument();
			expect(within(sheet).getByRole("button", { name: retry })).toBeEnabled();
			expect(
				within(sheet).queryByRole("button", { name: "Details" }) !== null,
			).toBe(reason === "other");
			expect(sheet).toHaveTextContent(/extra entry for this machine/);
		});
	});

	describe("last attempt", () => {
		it("says nothing on the card when the sheet told it", async () => {
			const user = userEvent.setup();
			const running = waiting();
			server.snapshot = status({ flow: running });
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Continue" }));
			await screen.findByText("BCDF-GHJK");

			push(
				status({
					flow: flow({
						id: running.id,
						phase: "failed",
						failure: { reason: "declined" },
					}),
				}),
			);
			await screen.findByRole("heading", { name: "Linking was declined" });
			await user.keyboard("{Escape}");
			await findRow("Not linked");
			expect(screen.queryByText(/Your last/)).toBeNull();
		});

		it("tells a watched flow's failure once, when the sheet was closed", async () => {
			const user = userEvent.setup();
			const running = waiting();
			server.snapshot = status({ flow: running });
			render(<CloudLinkSection />);
			await findRow("Linking…");

			push(
				status({
					flow: flow({
						id: running.id,
						phase: "failed",
						failure: { reason: "expired" },
					}),
				}),
			);
			expect(
				await screen.findByText(
					"Your last link code expired before it was approved.",
				),
			).toBeInTheDocument();
			await findRow("Not linked");

			await user.click(screen.getByRole("button", { name: "Dismiss" }));
			expect(screen.queryByText(/Your last link code expired/)).toBeNull();
		});

		it("says nothing of a flow it never saw running", async () => {
			server.snapshot = status({
				flow: flow({ phase: "failed", failure: { reason: "expired" } }),
			});
			render(<CloudLinkSection />);
			await findRow("Not linked");
			expect(screen.queryByText(/Your last/)).toBeNull();
		});

		it("tells a restart that took the watched flow", async () => {
			server.snapshot = status({ flow: waiting() });
			render(<CloudLinkSection />);
			await findRow("Linking…");

			await reconnect(status());
			expect(
				await screen.findByText(
					"Pockode restarted, so your last attempt to link stopped.",
				),
			).toBeInTheDocument();
		});
	});

	describe("unlink", () => {
		it("hands focus to the card when the button that opened it is gone", async () => {
			const user = userEvent.setup();
			const reply = deferred<CloudLinkUnlinked>();
			server.snapshot = status({ credential: "linked", relay: "link_invalid" });
			server.unlink = () => reply.promise;
			render(<CloudLinkSection />);
			// The notice's Unlink: the notice goes with the link.
			await user.click(await screen.findByRole("button", { name: "Unlink" }));
			await user.click(
				within(screen.getByRole("dialog")).getByRole("button", {
					name: /Unlink/,
				}),
			);

			// The status closes the dialog before the reply lands.
			push(status());
			const row = await findRow("Not linked");
			await waitFor(() =>
				expect(document.activeElement).toBe(row.closest('[tabindex="-1"]')),
			);
			await act(async () =>
				reply.resolve({ was_linked: true, cloud_url: CLOUD }),
			);
		});

		it("names the machine and account, stays up while it runs, and closes on Not linked", async () => {
			const user = userEvent.setup();
			const reply = deferred<CloudLinkUnlinked>();
			server.snapshot = LINKED;
			server.unlink = () => reply.promise;
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Unlink" }));

			const dialog = screen.getByRole("dialog", {
				name: "Unlink this machine?",
			});
			expect(dialog).toHaveTextContent(
				`Every Pockode on ${MACHINE} — this one, other projects and cluster nodes — leaves ada@example.com's list.`,
			);
			await user.click(within(dialog).getByRole("button", { name: /Unlink/ }));
			// Cancelling cannot take back a request already sent.
			await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
			expect(dialog).toBeInTheDocument();

			// The status gets there before the reply.
			push(status());
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			await findRow("Not linked");
			await act(async () =>
				reply.resolve({ was_linked: true, cloud_url: CLOUD }),
			);
		});

		it("leaves a notice when the cloud could not be told", async () => {
			const user = userEvent.setup();
			server.snapshot = LINKED;
			server.unlink = async () => {
				push(status());
				return {
					was_linked: true,
					cloud_url: CLOUD,
					revoke_error: "connection refused",
				};
			};
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Unlink" }));
			await user.click(
				within(screen.getByRole("dialog")).getByRole("button", {
					name: /Unlink/,
				}),
			);

			expect(
				await screen.findByText(
					/cloud\.example\.com couldn't be told: connection refused/,
				),
			).toHaveTextContent(`Remove ${MACHINE} there`);
			expect(
				screen.getByRole("link", { name: /Open cloud\.example\.com/ }),
			).toHaveAttribute("href", CLOUD);
		});

		it("reads its own timeout as no answer yet, not a failure", async () => {
			const user = userEvent.setup();
			server.snapshot = LINKED;
			server.unlink = () =>
				Promise.reject(new JSONRPCErrorException("Request timed out", 0));
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Unlink" }));
			await user.click(
				within(screen.getByRole("dialog")).getByRole("button", {
					name: /Unlink/,
				}),
			);

			expect(
				await within(screen.getByRole("dialog")).findByText(
					"No answer yet. The card will show whether it went through.",
				),
			).toBeInTheDocument();
		});

		it("says what is left on a link the cloud no longer accepts", async () => {
			const user = userEvent.setup();
			server.snapshot = status({ credential: "linked", relay: "link_invalid" });
			render(<CloudLinkSection />);
			await user.click(await screen.findByRole("button", { name: "Unlink" }));
			expect(screen.getByRole("dialog")).toHaveTextContent(
				`This removes the link ${MACHINE} no longer uses.`,
			);
		});
	});
});
