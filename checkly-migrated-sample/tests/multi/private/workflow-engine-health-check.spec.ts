import { test, expect } from "@playwright/test";

test.describe("Workflow Engine Health Check", () => {
  test("Workflow Engine Health Check", async ({ request }) => {
    // Step 1: Workflow Engine US PROD health check
    const response0 = await request.get(`http://workflow-engine-us-prod.internal.example.net/health`);
    const body0 = await response0.text();
    let jsonBody0: any;
    try { jsonBody0 = JSON.parse(body0); } catch { jsonBody0 = {}; }

    // Response time assertion: lessThan 1000ms (handled by Checkly)
    expect(response0.status()).toBe(200);
    expect(jsonBody0?.status).toBe("healthy");

    // Step 2: Workflow Engine EU PROD health check
    const response1 = await request.get(`http://workflow-engine-eu-prod.internal.example.net/health`);
    const body1 = await response1.text();
    let jsonBody1: any;
    try { jsonBody1 = JSON.parse(body1); } catch { jsonBody1 = {}; }

    // Response time assertion: lessThan 1000ms (handled by Checkly)
    expect(response1.status()).toBe(200);
    expect(jsonBody1?.status).toContain("healthy");

    // Step 3: Workflow Engine APAC PROD health check
    const response2 = await request.get(`http://workflow-engine-apac-prod.internal.example.net/health`);
    const body2 = await response2.text();
    let jsonBody2: any;
    try { jsonBody2 = JSON.parse(body2); } catch { jsonBody2 = {}; }

    // Response time assertion: lessThan 1000ms (handled by Checkly)
    expect(response2.status()).toBe(200);
    expect(jsonBody2?.status).toBe("healthy");
  });
});
