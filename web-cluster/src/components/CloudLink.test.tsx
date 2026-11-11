import {
	type CloudLinkChangedNotification,
	type CloudLinkFlow,
	type CloudLinkStatus,
	type CloudLinkUnlinked,
	MEDIA_QUERIES,
} from "@pockode/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JSONRPCErrorCode, JSONRPCErrorException } from "json-rpc-2.0";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudLink } from "./CloudLink";

// The header's Cloud sheet (docs/cloud-link-ui.md, which web's Settings card
// follows too): the status, the device flow, and unlink — in one sheet whose
// views take turns.

/**
 * The server's side of `cloud_link.*`: the snapshot each subscribe answers
 * with, and the requests, each held until the test answers it.
 */
const server = vi.hoisted(() => ({
	snapshot: null as unknown as CloudLinkStatus | Error,
	notify: null as ((params: CloudLinkChangedNotification) => void) | null,
	subscribes: 0,
	unsubscribed: [] as string[],
	/** Notified to a new subscription before its reply goes out. */
	early: null as CloudLinkStatus | null,
	start: null as unknown as () => Promise<CloudLinkFlow>,
	cancel: null as unknown as (flowId: string) => Promise<CloudLinkFlow>,
	unlink: null as unknown as () => Promise<CloudLinkUnlinked>,
}));

vi.mock("../lib/wsStore", async (importOriginal) => {
	const original = await importOriginal<typeof import("../lib/wsStore")>();
	const { create } = await import("zustand");
	const useWSStore = create(() => ({
		status: "connected" as string,
		actions: {
			cloudLinkSubscribe: async (
				callback: (params: CloudLinkChangedNotification) => void,
			) => {
				server.subscribes++;
				server.notify = callback;
				const id = `sub-${server.subscribes}`;
				if (server.early) callback({ id, status: server.early });
				const snapshot = server.snapshot;
				if (snapshot instanceof Error) throw snapshot;
				return { id, status: snapshot };
			},
			cloudLinkUnsubscribe: async (id: string) => {
				server.unsubscribed.push(id);
			},
			cloudLinkStart: () => server.start(),
			cloudLinkCancel: (flowId: string) => server.cancel(flowId),
			cloudLinkUnlink: () => server.unlink(),
		},
	}));
	return {
		useWSStore,
		isConnectionLost: original.isConnectionLost,
		isInvalidParamsRejection: original.isInvalidParamsRejection,
	};
});

const { useWSStore } = await import("../lib/wsStore");

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

/** Drops the socket and comes back, so the panel subscribes afresh. */
async function reconnect(snapshot: CloudLinkStatus) {
	server.snapshot = snapshot;
	act(() => useWSStore.setState({ status: "reconnecting" }));
	await act(async () => useWSStore.setState({ status: "connected" }));
}

/** Renders the header button and opens the sheet on the status. */
async function openSheet() {
	const user = userEvent.setup();
	render(<CloudLink />);
	await user.click(screen.getByRole("button", { name: "Cloud account" }));
	await screen.findByRole("dialog", { name: "Cloud account" });
	return user;
}

/** A row's title and the line under it. */
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
	server.early = null;
	server.unsubscribed = [];
	server.start = () => Promise.reject(new Error("start not expected"));
	server.cancel = () => Promise.reject(new Error("cancel not expected"));
	server.unlink = () => Promise.reject(new Error("unlink not expected"));
	useWSStore.setState({ status: "connected" });
});

afterEach(() => {
	window.matchMedia = originalMatchMedia;
});

describe("CloudLink: the status", () => {
	it("names the machine before it is linked", async () => {
		await openSheet();
		await findRow("Not linked", MACHINE);
		expect(screen.getByRole("button", { name: "Link" })).toBeEnabled();
		expect(screen.queryByText(/This cluster/)).not.toBeInTheDocument();
	});

	it("is green and names the account only once this cluster is listed", async () => {
		server.snapshot = LINKED;
		await openSheet();
		const dialog = screen.getByRole("dialog");
		await findRow("Linked as ada@example.com", MACHINE);
		await findRow("This cluster is listed", "cloud.example.com");
		expect(dialog.querySelector(".text-th-success")).not.toBeNull();
		expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
			"href",
			CLOUD,
		);

		// A relay still catching up: the account is not known *now*.
		push({ ...LINKED, relay: "pending", email: undefined });
		await findRow("Linked", MACHINE);
		await findRow("Adding this cluster…");
		expect(screen.queryByText(/ada@example\.com/)).not.toBeInTheDocument();
		expect(dialog.querySelector(".text-th-success")).toBeNull();
	});

	it("never draws a failed read as Not linked, and Retry reads again", async () => {
		server.snapshot = new Error("cloud.json: permission denied");
		const user = await openSheet();
		await findRow("Couldn't read the link status");
		expect(screen.getByText("cloud.json: permission denied")).toBeVisible();
		expect(screen.queryByText("Not linked")).not.toBeInTheDocument();

		server.snapshot = status();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		await findRow("Not linked", MACHINE);
	});

	it("shows -32013 as unavailable, with nothing to retry", async () => {
		server.snapshot = new JSONRPCErrorException("no config dir", -32013);
		await openSheet();
		await findRow("Linking unavailable");
		expect(
			screen.queryByRole("button", { name: /Retry|Link/ }),
		).not.toBeInTheDocument();
	});

	it("puts a change notified before the snapshot on top of it, not under it", async () => {
		const running = waiting();
		server.snapshot = status({ flow: running });
		server.early = status({
			flow: {
				...running,
				revision: ++revision,
				phase: "finishing",
				user_code: undefined,
				verification_url: undefined,
			},
		});
		await openSheet();
		await findRow("Linking…", "Approved, saving the link…");
	});

	it("closes a subscription whose reply lands after it was given up", async () => {
		const { unmount } = render(<CloudLink />);
		unmount();
		await waitFor(() => expect(server.unsubscribed).toEqual(["sub-1"]));
	});

	it("follows the status while the sheet is closed, and reads again on return to the tab", async () => {
		render(<CloudLink />);
		await waitFor(() => expect(server.subscribes).toBe(1));

		server.snapshot = LINKED;
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(server.subscribes).toBe(2);
		expect(server.unsubscribed).toEqual(["sub-1"]);

		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Cloud account" }));
		await findRow("Linked as ada@example.com", MACHINE);
	});
});

describe("CloudLink: linking", () => {
	it("starts a flow and shows the code and the link — the link first on a phone", async () => {
		setFinePointer(false);
		const start = deferred<CloudLinkFlow>();
		server.start = () => start.promise;
		const user = await openSheet();

		await user.click(await screen.findByRole("button", { name: "Link" }));
		const sheet = await screen.findByRole("dialog", {
			name: "Link this machine",
		});
		// The phase also goes to the live region; this is the line on screen.
		expect(
			within(sheet).getByText("Starting…", { selector: "p" }),
		).toBeVisible();
		// Its id is not known yet, and cancel needs it.
		expect(
			within(sheet).getByRole("button", { name: "Cancel" }),
		).toBeDisabled();

		const shown = waiting();
		await act(async () => start.resolve(shown));
		expect(await within(sheet).findByText("BCDF-GHJK")).toBeVisible();
		expect(
			within(sheet).getByText("Code: B C D F, G H J K"),
		).toBeInTheDocument();
		expect(
			within(sheet).getByRole("link", { name: "Open approval page" }),
		).toHaveAttribute("href", shown.verification_url);
		expect(within(sheet).queryByRole("img")).not.toBeInTheDocument();
		expect(within(sheet).getByText(/^Expires in \d:\d\d$/)).toBeVisible();
	});

	it("leads with a QR code under a mouse", async () => {
		setFinePointer(true);
		server.snapshot = status({ flow: waiting() });
		const user = await openSheet();

		await user.click(await screen.findByRole("button", { name: "Continue" }));
		expect(
			await screen.findByRole("img", { name: "QR code for the approval page" }),
		).toBeVisible();
		expect(
			screen.getByRole("link", { name: "Open on this computer" }),
		).toBeVisible();
	});

	it("resumes a running flow without starting another, and closing leaves it running", async () => {
		const running = waiting();
		server.snapshot = status({ flow: running });
		const startSpy = vi.fn(() => Promise.reject(new Error("no")));
		server.start = startSpy;
		const cancelSpy = vi.fn();
		server.cancel = cancelSpy;
		const user = await openSheet();

		// Not started by this page: a reload, or another device.
		await findRow("Linking…", "· started earlier");
		await user.click(screen.getByRole("button", { name: "Continue" }));
		await screen.findByText("BCDF-GHJK");
		expect(startSpy).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Close" }));
		await user.click(screen.getByRole("button", { name: "Cloud account" }));
		await findRow("Linking…");
		expect(screen.getByRole("button", { name: "Continue" })).toBeVisible();
		expect(cancelSpy).not.toHaveBeenCalled();
	});

	it("keeps the copy with the higher revision, whichever arrives first", async () => {
		const start = deferred<CloudLinkFlow>();
		server.start = () => start.promise;
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Link" }));

		const started = flow();
		const later = waiting({ id: started.id });
		push(status({ flow: later }));
		await act(async () => start.resolve(started));
		expect(await screen.findByText("BCDF-GHJK")).toBeVisible();
	});

	it("goes back to the status once Cancel is answered canceled", async () => {
		const running = waiting();
		server.snapshot = status({ flow: running });
		server.cancel = async (id) => ({
			...running,
			id,
			revision: ++revision,
			phase: "canceled",
		});
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Continue" }));
		await user.click(await screen.findByRole("button", { name: "Cancel" }));

		await screen.findByRole("dialog", { name: "Cloud account" });
		await findRow("Not linked", MACHINE);
	});

	it("goes back to the status, unavailable, when start answers -32013", async () => {
		server.start = () =>
			Promise.reject(new JSONRPCErrorException("no config dir", -32013));
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Link" }));

		await findRow("Linking unavailable");
		expect(
			screen.queryByRole("dialog", { name: "Link this machine" }),
		).not.toBeInTheDocument();
	});

	it("stays on the phase the approval reached when Cancel comes too late", async () => {
		const running = waiting();
		server.snapshot = status({ flow: running });
		server.cancel = async () => ({
			...running,
			revision: ++revision,
			phase: "linked",
			email: "ada@example.com",
		});
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Continue" }));
		await user.click(await screen.findByRole("button", { name: "Cancel" }));

		expect(
			await screen.findByRole("heading", { name: "This machine is linked" }),
		).toBeVisible();
		expect(screen.getByText("Linked as ada@example.com")).toBeVisible();
		expect(
			screen.getByRole("link", { name: "Open cloud.example.com" }),
		).toBeVisible();
	});

	it("keeps the flow on screen when the cancel itself fails", async () => {
		server.snapshot = status({ flow: waiting() });
		server.cancel = () => Promise.reject(new Error("server busy"));
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Continue" }));
		await user.click(await screen.findByRole("button", { name: "Cancel" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Couldn't cancel: server busy",
		);
		expect(screen.getByText("BCDF-GHJK")).toBeVisible();
	});

	it("follows a newer flow when the cancel names one that was replaced", async () => {
		const first = waiting();
		server.snapshot = status({ flow: first });
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Continue" }));
		const newer = waiting({ user_code: "WXYZWXYZ" });
		server.cancel = async () => {
			push(status({ flow: newer }));
			throw new JSONRPCErrorException(
				"not the latest flow",
				JSONRPCErrorCode.InvalidParams,
			);
		};
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(await screen.findByText("WXYZ-WXYZ")).toBeVisible();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it.each([
		["expired", "This code expired", "Start again"],
		["declined", "Linking was declined", "Start again"],
		["other", "Linking failed", "Try again"],
	] as const)("says how a %s flow ended", async (reason, title, retry) => {
		const running = waiting();
		server.snapshot = status({ flow: running });
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Continue" }));
		push(
			status({
				flow: {
					...running,
					revision: ++revision,
					phase: "failed",
					failure: { reason, detail: "boom" },
					left_behind: true,
				},
			}),
		);

		expect(await screen.findByRole("heading", { name: title })).toBeVisible();
		expect(screen.getByRole("button", { name: retry })).toBeEnabled();
		expect(screen.getByText(/An extra entry for this machine/)).toBeVisible();
	});

	it("reads a running flow missing from the reconnect snapshot as a restart", async () => {
		server.snapshot = status({ flow: waiting() });
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Continue" }));
		await screen.findByText("BCDF-GHJK");

		await reconnect(status());
		expect(
			await screen.findByRole("heading", {
				name: "The cluster restarted, so linking stopped.",
			}),
		).toBeVisible();
	});

	it("tells once how a flow it watched ended while its view was away", async () => {
		const running = waiting();
		server.snapshot = status({ flow: running });
		const user = await openSheet();
		await findRow("Linking…");

		push(
			status({
				flow: {
					...running,
					revision: ++revision,
					phase: "failed",
					failure: { reason: "expired" },
				},
			}),
		);
		await findRow("Not linked", MACHINE);
		expect(
			screen.getByText("Your last link code expired before it was approved."),
		).toBeVisible();

		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText(/Your last link code/)).not.toBeInTheDocument();
	});

	it("tells a start refused after its view was left on the status", async () => {
		const start = deferred<CloudLinkFlow>();
		server.start = () => start.promise;
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Link" }));
		await screen.findByRole("dialog", { name: "Link this machine" });
		await user.click(screen.getByRole("button", { name: "Close" }));

		await act(async () => start.reject(new Error("cluster shutting down")));
		await user.click(screen.getByRole("button", { name: "Cloud account" }));
		expect(
			await screen.findByText("Your last attempt to link couldn't start."),
		).toBeVisible();
		await user.click(screen.getByRole("button", { name: "Details" }));
		expect(screen.getByText("cluster shutting down")).toBeVisible();

		// Its button gone, focus stays inside the sheet.
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(
			screen.queryByText("Your last attempt to link couldn't start."),
		).not.toBeInTheDocument();
		expect(screen.getByRole("dialog")).toContainElement(
			document.activeElement as HTMLElement,
		);
	});

	it("asks before linking over another cloud's link, naming both", async () => {
		server.snapshot = status({
			credential: "other_cloud",
			other_cloud_url: "https://dev.example.org",
		});
		server.start = () => new Promise(() => {});
		const user = await openSheet();
		await findRow("Linked to another cloud", "dev.example.org");

		await user.click(screen.getByRole("button", { name: "Link" }));
		const ask = await screen.findByRole("dialog", {
			name: "Link to cloud.example.com instead?",
		});
		expect(ask).toHaveTextContent(/stays linked to dev\.example\.org/);
		expect(ask).toHaveTextContent(MACHINE);

		await user.click(within(ask).getByRole("button", { name: "Link" }));
		expect(
			await screen.findByRole("dialog", { name: "Link this machine" }),
		).toBeVisible();
	});
});

describe("CloudLink: unlinking", () => {
	it("asks in the sheet, naming the machine and the account, and stays up while it runs", async () => {
		server.snapshot = LINKED;
		const unlink = deferred<CloudLinkUnlinked>();
		server.unlink = () => unlink.promise;
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Unlink" }));

		const ask = await screen.findByRole("dialog", {
			name: "Unlink this machine?",
		});
		expect(ask).toHaveTextContent(
			`Every Pockode on ${MACHINE} — this cluster, its nodes and other projects — leaves ada@example.com's list.`,
		);
		await user.click(within(ask).getByRole("button", { name: "Unlink" }));
		expect(within(ask).getByRole("button", { name: "Back" })).toBeDisabled();

		// The status says so before the reply does: the question is over.
		push(status());
		await screen.findByRole("dialog", { name: "Cloud account" });
		await act(async () => unlink.resolve({ was_linked: true }));
		await findRow("Not linked", MACHINE);
	});

	it("leaves a notice when the cloud could not be told", async () => {
		server.snapshot = LINKED;
		server.unlink = async () => {
			push(status());
			return {
				was_linked: true,
				cloud_url: CLOUD,
				revoke_error: "cloud unreachable",
			};
		};
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Unlink" }));
		await user.click(
			within(
				await screen.findByRole("dialog", { name: "Unlink this machine?" }),
			).getByRole("button", { name: "Unlink" }),
		);

		expect(
			await screen.findByText(
				/Unlinked here, but cloud\.example\.com couldn't be told: cloud unreachable/,
			),
		).toBeVisible();
	});

	it("does not call a dropped connection a failed unlink", async () => {
		server.snapshot = LINKED;
		server.unlink = () =>
			Promise.reject(new JSONRPCErrorException("Connection lost", 0));
		const user = await openSheet();
		await user.click(await screen.findByRole("button", { name: "Unlink" }));
		await user.click(
			within(
				await screen.findByRole("dialog", { name: "Unlink this machine?" }),
			).getByRole("button", { name: "Unlink" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The status will show whether it went through.",
		);
	});
});
