/**
 * Which entry owns a test file is decided by its name alone, so neither config
 * can pick up the other's files: `*.browser.test.{ts,tsx}` runs in real
 * browsers (`vitest.browser.config.ts`), every other `*.test.*` in jsdom
 * (`vitest.config.ts`).
 */
export const BROWSER_TEST_FILES = "src/**/*.browser.test.{ts,tsx}";
