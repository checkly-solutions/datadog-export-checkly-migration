import { test, expect } from "@playwright/test";

test.describe("Dashboard Login Flow", () => {
  test("Dashboard Login Flow", async ({ page }) => {
  // Navigate to start URL
  await page.goto(`https://dashboard.internal.example.net/login`);

  // Step 1: Type text on input #username
  await page.locator("#username").fill(`testuser@example.com`);

  // Step 2: Click on input "submit"
  await page.locator("xpath=/descendant::*[@type=\"submit\" and @value=\"Next\"]").click();

  // Step 3: Type text on input #password
  await page.locator("#password").fill(`${process.env.DASHBOARD_PASSWORD}`);

  // Step 4: Click on input "submit"
  await page.locator("xpath=/descendant::*[@type=\"submit\" and @value=\"Sign In\"]").click();

  // Step 5: Verify dashboard loaded
  await page.getByText("Welcome to Dashboard").click();
  });
});
