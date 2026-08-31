import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAbortError } from "./api";
import {
	nameCollision,
	nextAvailableName,
	UploadError,
	uploadFile,
} from "./fileUpload";

vi.mock("../utils/config", () => ({
	getApiBaseUrl: () => "http://localhost:8080",
}));

const logout = vi.fn();

vi.mock("./authStore", () => ({
	authActions: { getToken: () => "test-token", logout: () => logout() },
}));

/** Stands in for `XMLHttpRequest`, which jsdom has no server to answer. */
class FakeXHR {
	static instances: FakeXHR[] = [];

	method = "";
	url = "";
	headers = new Map<string, string>();
	body: FormData | null = null;
	status = 0;
	responseText = "";
	upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;

	constructor() {
		FakeXHR.instances.push(this);
	}

	open(method: string, url: string) {
		this.method = method;
		this.url = url;
	}

	setRequestHeader(name: string, value: string) {
		this.headers.set(name, value);
	}

	send(body: FormData) {
		this.body = body;
	}

	abort() {
		this.onabort?.();
	}

	respond(status: number, responseText = "") {
		this.status = status;
		this.responseText = responseText;
		this.onload?.();
	}

	reportProgress(loaded: number, total: number) {
		this.upload.onprogress?.({
			lengthComputable: true,
			loaded,
			total,
		} as ProgressEvent);
	}
}

function only(): FakeXHR {
	expect(FakeXHR.instances).toHaveLength(1);
	return FakeXHR.instances[0];
}

function request(overrides: Partial<Parameters<typeof uploadFile>[0]> = {}) {
	const file = new File(["hello"], "logo.png");
	return {
		file,
		name: file.name,
		destPath: "src/assets",
		worktree: "feature",
		overwrite: false,
		...overrides,
	};
}

function errorBody(code: string, message: string, extra: object = {}) {
	return JSON.stringify({ error: message, code, ...extra });
}

/** Lets the promise chain inside `uploadFile` settle. */
async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("uploadFile", () => {
	beforeEach(() => {
		logout.mockClear();
		FakeXHR.instances = [];
		vi.stubGlobal("XMLHttpRequest", FakeXHR);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("authenticates and names the destination it writes to", async () => {
		const done = uploadFile(request({ overwrite: true }));
		const xhr = only();

		expect(xhr.method).toBe("POST");
		expect(xhr.url).toBe(
			"http://localhost:8080/api/files/upload?path=src%2Fassets&overwrite=true&worktree=feature",
		);
		expect(xhr.headers.get("Authorization")).toBe("Bearer test-token");

		xhr.respond(200, JSON.stringify({ files: [] }));
		await expect(done).resolves.toBeUndefined();
	});

	it("says nothing about the root, the main worktree, or not overwriting", async () => {
		const done = uploadFile(request({ destPath: "", worktree: "" }));
		expect(only().url).toBe("http://localhost:8080/api/files/upload");

		only().respond(200, JSON.stringify({ files: [] }));
		await done;
	});

	it("sends the file under the name it was given, not its own", async () => {
		uploadFile(request({ name: "logo (1).png" }));

		const part = only().body?.get("file");
		expect(part).toBeInstanceOf(File);
		expect((part as File).name).toBe("logo (1).png");
	});

	it("reports how much of the body has gone out", async () => {
		const onProgress = vi.fn();
		uploadFile(request({ onProgress }));

		only().reportProgress(512, 2048);

		expect(onProgress).toHaveBeenCalledWith(0.25);
	});

	it("phrases a name collision and does not offer a plain retry", async () => {
		const done = uploadFile(request());
		only().respond(
			409,
			errorBody(
				"conflict",
				"logo.png already exists; retry with overwrite=true to replace it",
			),
		);

		const error = await done.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(UploadError);
		expect(error).toMatchObject({
			// A query parameter is not an action anyone can take from the queue, and
			// the buttons beside the message already are.
			message: "logo.png already exists",
			code: "conflict",
			// The two resolutions replace it; sending the identical request again
			// can only fail the same way.
			canRetry: false,
		});
	});

	it("keeps what the server knows about a 409 that this side cannot", async () => {
		const done = uploadFile(request());
		// Only the server ran `Lstat`. Flattening this to "Already exists" leaves
		// the user pressing Replace on something it will refuse again for exactly
		// the reason it just gave.
		only().respond(
			409,
			errorBody("conflict", "src/assets/logo.png is a directory"),
		);

		await expect(done).rejects.toThrow("src/assets/logo.png is a directory");
	});

	it("still has something to say about a 409 with no message", async () => {
		const done = uploadFile(request());
		only().respond(409, errorBody("conflict", ""));

		await expect(done).rejects.toThrow("Already exists");
	});

	it("quotes the endpoint's own ceiling on a rejection, and never retries it", async () => {
		const done = uploadFile(request());
		only().respond(
			413,
			errorBody("too_large", "over the limit", { limit: 33554432 }),
		);

		const error = await done.catch((e: unknown) => e);
		expect(error).toMatchObject({
			message: "Too large (max 32 MB)",
			canRetry: false,
		});
	});

	it("keeps the server's detail for a fault the user cannot act on", async () => {
		const done = uploadFile(request());
		only().respond(500, errorBody("internal", "write failed: no space left"));

		await expect(done).rejects.toThrow(
			"Server error: write failed: no space left",
		);
	});

	it("passes an unrecognised code's message through untouched", async () => {
		const done = uploadFile(request());
		only().respond(400, errorBody("something_new", "a reason from the future"));

		await expect(done).rejects.toThrow("a reason from the future");
	});

	it("falls back to the status when the body is not the contract's", async () => {
		const done = uploadFile(request());
		only().respond(502, "<html>Bad Gateway</html>");

		await expect(done).rejects.toThrow("Upload failed with HTTP 502");
	});

	it("ends the session when the token is refused", async () => {
		const done = uploadFile(request());
		only().respond(401, "unauthorized");

		await expect(done).rejects.toThrow("Your session has expired");
		expect(logout).toHaveBeenCalled();
	});

	it("reports what a partly-completed request had already stored", async () => {
		const done = uploadFile(request());
		only().respond(
			400,
			errorBody("invalid_request", "body cut short", {
				written: [{ path: "src/assets/logo.png", name: "logo.png", size: 5 }],
			}),
		);

		const error = await done.catch((e: unknown) => e);
		expect(error).toMatchObject({ storedCount: 1 });
	});

	it("has one thing to say about a connection that never answered", async () => {
		const done = uploadFile(request());
		only().onerror?.();

		await expect(done).rejects.toThrow("Connection lost");
	});

	it("cancels in flight, and distinguishably from a failure", async () => {
		const controller = new AbortController();
		const done = uploadFile(request({ signal: controller.signal }));

		controller.abort();
		await flush();

		const error = await done.catch((e: unknown) => e);
		expect(isAbortError(error)).toBe(true);
	});

	it("sends nothing at all when the signal has already fired", async () => {
		const controller = new AbortController();
		controller.abort();

		const error = await uploadFile(
			request({ signal: controller.signal }),
		).catch((e: unknown) => e);

		expect(isAbortError(error)).toBe(true);
		expect(FakeXHR.instances).toHaveLength(0);
	});
});

describe("nameCollision", () => {
	const entries = [
		{ name: "logo.png", type: "file" as const, path: "assets/logo.png" },
		{ name: "icons", type: "dir" as const, path: "assets/icons" },
	];

	it("tells a folder apart from a file, which the 409 does not", () => {
		expect(nameCollision("logo.png", entries)).toBe("file");
		expect(nameCollision("icons", entries)).toBe("folder");
		expect(nameCollision("hero.png", entries)).toBe("none");
	});

	it("claims nothing about a directory it has never listed", () => {
		// Guessing "taken" from an absent listing would block an upload with
		// nothing in its way; the endpoint's 409 is the backstop.
		expect(nameCollision("logo.png", null)).toBe("none");
	});
});

describe("nextAvailableName", () => {
	it("leaves a free name alone", () => {
		expect(nextAvailableName("logo.png", new Set(["hero.png"]))).toBe(
			"logo.png",
		);
	});

	it("numbers a copy, and keeps counting past the copies", () => {
		expect(nextAvailableName("logo.png", new Set(["logo.png"]))).toBe(
			"logo (1).png",
		);
		expect(
			nextAvailableName("logo.png", new Set(["logo.png", "logo (1).png"])),
		).toBe("logo (2).png");
	});

	it("counts on from a name that is already a copy", () => {
		// Otherwise a collision the cached listing did not know about would turn
		// each press of Keep both into another " (1)".
		expect(nextAvailableName("logo (1).png", new Set(["logo (1).png"]))).toBe(
			"logo (2).png",
		);
		// Only when it collides: a file genuinely named this way is left alone.
		expect(nextAvailableName("logo (1).png", new Set(["logo.png"]))).toBe(
			"logo (1).png",
		);
	});

	it("treats a dotfile's name as a name, not an extension", () => {
		expect(nextAvailableName(".env", new Set([".env"]))).toBe(".env (1)");
		expect(nextAvailableName("Makefile", new Set(["Makefile"]))).toBe(
			"Makefile (1)",
		);
	});
});
