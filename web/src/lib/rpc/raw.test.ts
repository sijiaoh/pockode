import type { JSONRPCRequester } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRawActions, pageRawTarget, pageRawUrl } from "./raw";

describe("rawCapability", () => {
	const request = vi.fn(async () => ({
		path: "/api/raw/cap/clip.mp4",
		expires_at: "2026-01-02T03:04:05Z",
		worktree: "feature",
	}));
	const client = { request } as unknown as JSONRPCRequester<void>;
	const actions = createRawActions(() => client);

	beforeEach(() => request.mockClear());

	// The server refuses a field that belongs to another origin, so each origin
	// must send its own names and nothing else.
	it.each([
		{
			target: {
				origin: { kind: "file", path: "media/clip.mp4" },
				scope: "file",
			},
			params: { origin: "file", scope: "file", path: "media/clip.mp4" },
		},
		{
			target: { origin: { kind: "file" }, scope: "root" },
			params: { origin: "file", scope: "root" },
		},
		{
			target: { origin: { kind: "commit", hash: "abc1234" }, scope: "root" },
			params: { origin: "commit", scope: "root", hash: "abc1234" },
		},
		{
			target: {
				origin: {
					kind: "attachment",
					sessionId: "s1",
					id: "a.png",
					worktree: "feature-x",
				},
				scope: "file",
			},
			params: {
				origin: "attachment",
				scope: "file",
				session_id: "s1",
				id: "a.png",
				worktree: "feature-x",
			},
		},
	] as const)("sends a $target.origin.kind $target.scope origin under the server's names", async ({
		target,
		params,
	}) => {
		const capability = await actions.rawCapability(target);

		expect(request).toHaveBeenCalledWith("raw.capability", params);
		expect(capability).toEqual({
			path: "/api/raw/cap/clip.mp4",
			expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5),
			worktree: "feature",
		});
	});
});

describe("pageRawTarget", () => {
	const capability = "https://app.example/api/raw/cap/";

	// Where the page sits decides nothing: its relative URLs resolve against
	// its own path under the one root, `../` and a page at the root included.
	it.each([
		["index.html", "https://app.example/api/raw/cap/index.html"],
		[
			"docs/site/a b.html",
			"https://app.example/api/raw/cap/docs/site/a%20b.html",
		],
	])("loads %s at its own path under the root", (path, url) => {
		const target = pageRawTarget({ kind: "file", path });

		expect(target).toEqual({ origin: { kind: "file" }, scope: "root" });
		expect(pageRawUrl(target, capability, path)).toBe(url);
	});

	it("roots a commit's page in the commit", () => {
		expect(
			pageRawTarget({
				kind: "commit",
				hash: "abc1234",
				path: "site/index.html",
			}),
		).toEqual({ origin: { kind: "commit", hash: "abc1234" }, scope: "root" });
	});

	// The root scope withholds any dot-prefixed component.
	it.each([
		"docs/.vitepress/dist/index.html",
		".hidden.html",
	])("shows %s on its own", (path) => {
		const origin = { kind: "file", path } as const;
		const target = pageRawTarget(origin);

		expect(target).toEqual({ origin, scope: "file" });
		expect(pageRawUrl(target, "/api/raw/cap/x.html", path)).toBe(
			"/api/raw/cap/x.html",
		);
	});
});
