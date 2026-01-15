Matching Datadog API - subtype: multi to Checkly Multi Step Check attributes

## Construct to Construct Mapping

| Datadog Attribute | Checkly Attribute | Notes |
|-------------------|-------------------|-------|
| `public_id` | `logicalId` | Used as construct ID |
| `name` | `name` | Check display name |
| `tags` | `tags` | Array of string tags |
| `options.tick_every` | `frequency` | Mapped via FREQUENCY_MAP (seconds → enum) |
| `options.retry` | `retryStrategy` | Converted to RetryStrategyBuilder |
| `locations` | `locations` | Public locations only (aws:* prefix stripped) |
| `locations` (pl:*) | `privateLocations` | Private locations kept as-is |
| `status: "live"` | `activated: true` | Check activation status |

## Step to Playwright Mapping

Datadog has an array of `config.steps` for API `subtype: multi`. These map to Playwright request API calls. Multi Step Checks using Playwright in Checkly NEVER call the browser.

| Datadog Step Attribute | Playwright Equivalent | Notes |
|------------------------|----------------------|-------|
| `steps[].name` | Comment/step label | Used for documentation |
| `steps[].request.method` | `request.get()`, `request.post()`, etc. | HTTP method |
| `steps[].request.url` | First argument to request method | URL string |
| `steps[].request.headers` | `{ headers: {...} }` option | Request headers object |
| `steps[].request.body` | `{ data: ... }` option | Request body (POST/PUT/PATCH) |
| `steps[].assertions` | `expect()` calls | See assertion mapping below |
| `steps[].allowFailure: true` | `expect.soft()` | Soft assertion - logs but doesn't stop |
| `steps[].extractedValues` | Manual implementation | Variable extraction between steps |

## Assertion Mapping

| Datadog Operator | Playwright expect Method |
|------------------|--------------------------|
| `is` | `.toBe()` |
| `isNot` | `.not.toBe()` |
| `lessThan` | `.toBeLessThan()` |
| `moreThan` | `.toBeGreaterThan()` |
| `contains` | `.toContain()` |
| `doesNotContain` | `.not.toContain()` |
| `matches` | `.toMatch()` |
| `doesNotMatch` | `.not.toMatch()` |

## Assertion Types

| Datadog Type | Playwright Target |
|--------------|-------------------|
| `statusCode` | `response.status()` |
| `body` | `await response.text()` |
| `header` | `response.headers()["header-name"]` |
| `responseTime` | Handled by Checkly (not in Playwright) |

