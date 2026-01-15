import { test, expect } from "@playwright/test";

const BASE_URL = "https://api.example.com/webservice";

test.describe("ScheduALL API - Multi-step Health Check", () => {
  test("should verify webservice login flow", async ({ request }) => {
    // Step 1: Check Base Webservice
    const baseResponse = await request.get(`${BASE_URL}/api.asmx`);

    expect(baseResponse.status()).toBe(200);
    const baseBody = await baseResponse.text();
    expect(baseBody).toContain("Login");

    // Step 2: Login
    const loginResponse = await request.post(`${BASE_URL}/api.asmx?op=Login`, {
      headers: {
        "content-type": "text/xml",
      },
      data: `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Login xmlns="http://example.com/webservices/">
      <Name>{{USERNAME}}</Name>
      <Password>{{PASSWORD}}</Password>
    </Login>
  </soap:Body>
</soap:Envelope>`,
    });

    expect(loginResponse.status()).toBe(200);
    const loginBody = await loginResponse.text();
    expect(loginBody).toContain("Logged In");

    // Step 3: Logout
    const logoutResponse = await request.get(`${BASE_URL}/api.asmx/Logout`, {
      headers: {
        "content-type": "text/xml",
      },
    });

    expect(logoutResponse.status()).toBe(200);
    const logoutBody = await logoutResponse.text();
    expect(logoutBody).toContain("Not Logged In");
  });
});
