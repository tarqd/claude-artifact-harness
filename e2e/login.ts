/**
 * Owner login for the specs. The owner token is posted, never put in a URL
 * (security review, finding 9), and the response's cookies land in the
 * page's browser context, so the browser is the owner from here on.
 */
import type { Page } from "@playwright/test";

export async function loginAsOwner(page: Page, shellOrigin: string, token: string): Promise<void> {
  const response = await page.request.post(`${shellOrigin}/login`, { form: { token } });
  if (!response.ok()) throw new Error(`owner login failed: ${response.status()}`);
}
