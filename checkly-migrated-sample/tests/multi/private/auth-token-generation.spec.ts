import { test, expect } from "@playwright/test";

test.describe("Auth Token Generation", () => {
  test("Auth Token Generation", async ({ request }) => {
    // Step 1: Request auth token
    const response0 = await request.post(`https://auth.internal.example.net/oauth2/token`, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: `grant_type=client_credentials&client_id=${process.env.SAMPLE_CLIENT_ID}&client_secret=${process.env.SAMPLE_CLIENT_SECRET}`,
    });
    const body0 = await response0.text();
    let jsonBody0: any;
    try { jsonBody0 = JSON.parse(body0); } catch { jsonBody0 = {}; }

    expect(response0.status()).toBe(200);
    expect(jsonBody0?.access_token).toBeTruthy();

    // Step 2: Validate token
    const response1 = await request.get(`https://auth.internal.example.net/oauth2/introspect`, {
      headers: {
        "Authorization": `Bearer ${jsonBody0.access_token}`,
      },
    });

    expect(response1.status()).toBe(200);
  });
});
