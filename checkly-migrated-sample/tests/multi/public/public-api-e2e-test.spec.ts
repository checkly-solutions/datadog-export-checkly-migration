import { test, expect } from "@playwright/test";

test.describe("Public API E2E Test", () => {
  test("Public API E2E Test", async ({ request }) => {
    // Step 1: Get API status
    const response0 = await request.get(`https://api.example.com/v1/status`);
    const body0 = await response0.text();
    let jsonBody0: any;
    try { jsonBody0 = JSON.parse(body0); } catch { jsonBody0 = {}; }

    expect(response0.status()).toBe(200);
    expect(jsonBody0?.status).toBe("ok");

    // Step 2: Fetch sample resource
    const response1 = await request.get(`https://api.example.com/v1/resources/sample`);

    expect(response1.status()).toBe(200);
  });
});
