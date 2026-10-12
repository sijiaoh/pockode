import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
// The app's real stylesheet, so Tailwind classes have their real sizes — the
// point of running in a browser at all.
import "../index.css";

// Same margin, and the same reason, as `setup.ts`.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
	cleanup();
});
