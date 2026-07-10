import { test, expect } from "@playwright/test";

test.describe("PWCS Multi Browser Flow", () => {
  test("PWCS Multi Browser Flow", async ({ page }) => {
    test.setTimeout(120_000);
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        console.log('Navigation request:', request.url());
      }
    });
    // Step 1: Open checkout page
    await page.goto(`https://app.example.com/checkout`);

    // Step 2: Assert checkout text
    await expect(page.locator("body")).toContainText("Checkout");
  });
});
