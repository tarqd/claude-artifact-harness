import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

/**
 * The image ships a preinstalled Chromium that may not match the revision this
 * Playwright pins. Fall back to the preinstalled binary when the pinned one is
 * missing; never run `playwright install` here.
 */
const preinstalled = "/opt/pw-browsers/chromium";
const executablePath = existsSync(preinstalled) ? preinstalled : undefined;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
