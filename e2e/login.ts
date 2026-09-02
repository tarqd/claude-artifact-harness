/**
 * Owner login for the specs. The token is posted, never put in a URL
 * (security review, finding 9), and the browser submits the rendered form
 * rather than posting behind its back: that is the only path in the suite
 * that carries a real `Origin` and `Sec-Fetch-Site`, which is exactly what
 * the same-origin guard on `POST /login` refuses a login without.
 */
import type { Page } from "@playwright/test";

export async function loginAsOwner(page: Page, shellOrigin: string, token: string): Promise<void> {
  await page.goto(`${shellOrigin}/login`);
  await page.locator("#token").fill(token);
  await page.locator('button[type="submit"]').click();
  await page.waitForFunction(
    () => document.body.textContent?.includes("logged in as the owner") === true,
    undefined,
    { timeout: 15_000 },
  );
}
