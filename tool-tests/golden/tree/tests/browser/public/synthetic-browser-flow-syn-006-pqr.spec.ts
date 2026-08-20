import { test, expect } from "@playwright/test";
import { firstMatch, type CandidateFactory } from "../helpers";

test.describe("Synthetic Browser Flow", () => {
  test("Synthetic Browser Flow", async ({ page }) => {
    test.setTimeout(120_000);
    page.on('request', (request) => {
      if (request.isNavigationRequest()) {
        console.log('Navigation request:', request.url());
      }
    });
    // Step 1: Open login page
    await page.goto(`https://app.example.com/login`);

    // Step 2: Type username
    await page.locator("#username").fill(`user@example.com`);

    // Step 3: Click sign in
    const step3ClickSignIn: CandidateFactory = (root) => [
      root.getByRole("button", { name: "Sign in" }), // role
      root.locator("#submit"), // id
    ];
    await (await firstMatch(page, step3ClickSignIn)).click();

    // Step 4: Assert welcome text
    await expect(page.locator("body")).toContainText("Welcome");
  });
});
