import { test, expect } from "@playwright/test";

test.describe("Portal Login Test", () => {
  test("Portal Login Test", async ({ page }) => {
  // Navigate to portal
  await page.goto(`https://portal.example.com/login`);

  // Step 1: Type email
  await page.locator("#email").fill(`demouser@example.com`);

  // Step 2: Click Next
  await page.locator("xpath=/descendant::*[@type=\"submit\" and @value=\"Next\"]").click();

  // Step 3: Type password
  await page.locator("#password").fill(`DemoPassword@12345`);

  // Step 4: Click Sign In
  await page.locator("xpath=/descendant::*[@type=\"submit\" and @value=\"Verify\"]").click();

  // Step 5: Verify logged in
  await page.getByText("recent reports").click();
  });
});
