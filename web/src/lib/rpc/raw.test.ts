import type { JSONRPCRequester } from "json-rpc-2.0";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRawActions } from "./raw";

describe("rawCapability", () => {
	const request = vi.fn(async () => ({
		path: "/api/raw/cap/clip.mp4",
		expires_at: "2026-01-02T03:04:05Z",
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
			target: {
				origin: { kind: "commit", hash: "abc1234", path: "site" },
				scope: "directory",
			},
			params: {
				origin: "commit",
				scope: "directory",
				hash: "abc1234",
				path: "site",
			},
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
	] as const)("sends a $target.origin.kind origin under the server's names", async ({
		target,
		params,
	}) => {
		const capability = await actions.rawCapability(target);

		expect(request).toHaveBeenCalledWith("raw.capability", params);
		expect(capability).toEqual({
			path: "/api/raw/cap/clip.mp4",
			expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5),
		});
	});
});
