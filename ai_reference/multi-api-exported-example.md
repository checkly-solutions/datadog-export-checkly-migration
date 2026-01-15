# Datadog Multi-Step API Test Export Example

Example JSON structure for a multi-step API test (`subtype: "multi"`).

```json
{
  "public_id": "abc-123-xyz",
  "name": "API Service - Multi-step Health Check",
  "status": "live",
  "type": "api",
  "subtype": "multi",
  "tags": [
    "env:prod",
    "team:platform"
  ],
  "config": {
    "configVariables": [],
    "steps": [
      {
        "id": "step-001",
        "name": "Check Base Webservice",
        "subtype": "http",
        "extractedValues": [],
        "allowFailure": true,
        "isCritical": true,
        "assertions": [
          {
            "operator": "lessThan",
            "type": "responseTime",
            "target": 10000
          },
          {
            "operator": "is",
            "type": "statusCode",
            "target": 200
          },
          {
            "operator": "contains",
            "type": "body",
            "target": "Login"
          }
        ],
        "request": {
          "method": "GET",
          "url": "https://api.example.com/webservice/api.asmx",
          "httpVersion": "http1"
        }
      },
      {
        "id": "step-002",
        "name": "Login",
        "subtype": "http",
        "extractedValues": [],
        "allowFailure": true,
        "isCritical": true,
        "assertions": [
          {
            "operator": "is",
            "type": "statusCode",
            "target": 200
          },
          {
            "operator": "lessThan",
            "type": "responseTime",
            "target": 10000
          },
          {
            "operator": "contains",
            "type": "body",
            "target": "Logged In"
          }
        ],
        "request": {
          "method": "POST",
          "url": "https://api.example.com/webservice/api.asmx?op=Login",
          "body": "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\">\n  <soap:Body>\n    <Login xmlns=\"http://example.com/webservices/\">\n      <Name>{{USERNAME}}</Name>\n      <Password>{{PASSWORD}}</Password>\n    </Login>\n  </soap:Body>\n</soap:Envelope>",
          "headers": {
            "content-type": "text/xml"
          },
          "httpVersion": "http1"
        }
      },
      {
        "id": "step-003",
        "name": "Logout",
        "subtype": "http",
        "extractedValues": [],
        "allowFailure": false,
        "isCritical": true,
        "assertions": [
          {
            "operator": "lessThan",
            "type": "responseTime",
            "target": 10000
          },
          {
            "operator": "contains",
            "type": "body",
            "target": "Not Logged In"
          },
          {
            "operator": "is",
            "type": "statusCode",
            "target": 200
          }
        ],
        "request": {
          "method": "GET",
          "url": "https://api.example.com/webservice/api.asmx/Logout",
          "headers": {
            "content-type": "text/xml"
          },
          "httpVersion": "http1"
        }
      }
    ]
  },
  "options": {
    "tick_every": 900,
    "min_failure_duration": 900,
    "min_location_failed": 1
  },
  "locations": [
    "aws:us-east-1",
    "aws:eu-west-1"
  ]
}
```

## Key Fields for Multi-Step Tests

| Field | Description |
|-------|-------------|
| `subtype` | `multi` indicates a multi-step API test |
| `config.steps` | Array of sequential API requests |
| `steps[].id` | Unique step identifier |
| `steps[].name` | Step display name |
| `steps[].allowFailure` | If `true`, continue to next step on failure |
| `steps[].isCritical` | If `true`, marks test as failed when step fails |
| `steps[].extractedValues` | Variables extracted from response for use in later steps |
| `steps[].assertions` | Assertions for this step |
| `steps[].request` | HTTP request configuration |

## Converted Playwright Test

Multi-step tests convert to Playwright specs using the `request` fixture (no browser):

```typescript
import { test, expect } from "@playwright/test";

const BASE_URL = "https://api.example.com/webservice";

test.describe("API Service - Multi-step Health Check", () => {
  test("should verify webservice login flow", async ({ request }) => {
    // Step 1: Check Base Webservice
    const baseResponse = await request.get(`${BASE_URL}/api.asmx`);
    expect(baseResponse.status()).toBe(200);
    expect(await baseResponse.text()).toContain("Login");

    // Step 2: Login
    const loginResponse = await request.post(`${BASE_URL}/api.asmx?op=Login`, {
      headers: { "content-type": "text/xml" },
      data: `<soap:Envelope>...</soap:Envelope>`,
    });
    expect(loginResponse.status()).toBe(200);
    expect(await loginResponse.text()).toContain("Logged In");

    // Step 3: Logout
    const logoutResponse = await request.get(`${BASE_URL}/api.asmx/Logout`);
    expect(logoutResponse.status()).toBe(200);
    expect(await logoutResponse.text()).toContain("Not Logged In");
  });
});
```

## Checkly MultiStepCheck Construct

```typescript
import { MultiStepCheck, Frequency } from "checkly/constructs";

new MultiStepCheck("api-service-health-check", {
  name: "API Service - Multi-step Health Check",
  code: {
    entrypoint: "./api-service-health.spec.ts",
  },
  frequency: Frequency.EVERY_15M,
  locations: ["us-east-1", "eu-west-1"],
});
```
