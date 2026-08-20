import { test, expect } from "@playwright/test";

test.describe("Synthetic Login Flow", () => {
  test("Synthetic Login Flow", async ({ request }) => {
    let AUTH_TOKEN = '';

    // Step 1: Get auth token
    const response0 = await request.post(`https://auth.example.com/token`, {
      headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
      data: `grant_type=client_credentials`,
    });

    expect(response0.status()).toBe(200);

    // Extract AUTH_TOKEN from step 1 response
    try {
      const _extractBody0 = await response0.text();
      const _extractJson0 = JSON.parse(_extractBody0);
      AUTH_TOKEN = _extractJson0?.access_token ?? '';
    } catch { /* extraction failed, AUTH_TOKEN remains empty */ }

    // Step 2: Fetch profile
    const response1 = await request.get(`https://api.example.com/v1/profile`, {
      headers: {
      "Authorization": `Bearer ${AUTH_TOKEN}`
    },
    });
    const body1 = await response1.text();

    expect(response1.status()).toBe(200);
    expect(body1).toContain("profile");
  });
});
