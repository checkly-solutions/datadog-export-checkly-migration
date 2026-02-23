import { test, expect } from "@playwright/test";

test.describe("Data Explorer Navigation", () => {
  test("Data Explorer Navigation", async ({ page }) => {
  // Navigate to data explorer
  await page.goto(`https://explorer.example.com/`);

  // Step 1: Verify page title
  await expect(page).toHaveTitle(/Data Explorer/);

  // Step 2: Click on navigation item
  await page.locator(".nav-item >> text=Reports").click();

  // Step 3: Verify reports page loaded
  await expect(page.locator(".reports-container")).toBeVisible();
  });
});
