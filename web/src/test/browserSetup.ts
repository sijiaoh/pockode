import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import "./waitPolicy";
// The app's real stylesheet, so Tailwind classes have their real sizes — the
// point of running in a browser at all.
import "../index.css";

afterEach(() => {
	cleanup();
});
