import { test, expect } from "@playwright/test";

test.describe("Cloud Status Page Check", () => {
  test("Cloud Status Page Check", async ({ page }) => {
  // Navigate to cloud status page
  await page.goto(`https://status.cloud-provider.example.com/`);

  // Step 1: Verify page loaded with operational status
  const statusText = await page.locator(".status-indicator").textContent();
  expect(statusText).toContain("All Systems Operational");
  });
});
