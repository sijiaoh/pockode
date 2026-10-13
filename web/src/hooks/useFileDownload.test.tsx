import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileDownload } from "./useFileDownload";

const saveRawFile = vi.fn();

vi.mock("./useRawMediaSource", () => ({
	saveRawFile: (...args: unknown[]) => saveRawFile(...args),
}));

function abortError() {
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	return error;
}

function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={new QueryClient()}>
			{children}
		</QueryClientProvider>
	);
}

describe("useFileDownload", () => {
	beforeEach(() => {
		saveRawFile.mockReset();
	});

	it("saves a commit's file from that commit, under its own name", async () => {
		saveRawFile.mockResolvedValue(undefined);
		const { result } = renderHook(
			() =>
				useFileDownload({
					path: "src/app.ts",
					worktree: "",
					hash: "abc1234",
					onError: () => {},
				}),
			{ wrapper },
		);

		await act(async () => result.current.toggle());

		expect(saveRawFile).toHaveBeenCalledWith(
			expect.anything(),
			{ kind: "commit", hash: "abc1234", path: "src/app.ts" },
			"app.ts",
			expect.any(AbortSignal),
		);
		// Handed to the browser: the transfer is no longer the app's to show.
		expect(result.current.isDownloading).toBe(false);
	});

	// The probe and the hand-over settle late enough for the user to have
	// started downloading the next file by then.
	it("keeps a newer download running when an older one settles late", async () => {
		const settleFirst: (() => void)[] = [];
		saveRawFile
			.mockImplementationOnce(
				() =>
					new Promise((_resolve, reject) => {
						settleFirst.push(() => reject(abortError()));
					}),
			)
			.mockImplementationOnce(() => new Promise(() => {}));
		const { result, rerender } = renderHook(
			({ path }) =>
				useFileDownload({
					path,
					worktree: "",
					onError: () => {},
				}),
			{ initialProps: { path: "a.txt" }, wrapper },
		);

		act(() => result.current.toggle());
		rerender({ path: "b.txt" });
		act(() => result.current.toggle());
		await act(async () => settleFirst[0]());

		expect(result.current.isDownloading).toBe(true);
		expect(result.current.label).toBe("Cancel download");
	});
});
