import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileDownload } from "./useFileDownload";

const downloadFile = vi.fn();

vi.mock("../lib/fileDownload", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/fileDownload")>()),
	downloadFile: (...args: unknown[]) => downloadFile(...args),
}));

function abortError() {
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	return error;
}

describe("useFileDownload", () => {
	beforeEach(() => {
		downloadFile.mockReset();
	});

	// An aborted transfer only settles once its fetch notices, which can be
	// after the user has already started downloading the next file.
	it("keeps a newer download running when an older one settles late", async () => {
		const settleFirst: (() => void)[] = [];
		downloadFile
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
					size: 1,
					onError: () => {},
				}),
			{ initialProps: { path: "a.txt" } },
		);

		act(() => result.current.toggle());
		rerender({ path: "b.txt" });
		act(() => result.current.toggle());
		await act(async () => settleFirst[0]());

		expect(result.current.isDownloading).toBe(true);
		expect(result.current.label).toBe("Cancel download");
	});
});
