Datadog provides an API based export only for existing synthetics and monitors.

At Checkly (a synthetic monitoring solution) we want to support customers in their migration from Datadog.

It seems like the best approach is to create a code based approach that can make this process easier.

We need to get all the Browser and API based synthetics and environment variables as we will likely use these with our solution as well.

The following calls and links are likely useful for creating the workflow. We are iterating through all the synthetics that return and getting their configurations

### Workflow steps

This entire workflow hinges on the customer creating an API key that we they can use to gather all of their synthetic monitoring resources.

### Export steps

Have customer create an API key that you can use to make a series of calls or they can.

1. This API key will need the following permissions;
   1. synthetics get calls
      1. `synthetics_read`
   2. monitor get calls
      1. `monitors_read`
   3. env var related
      1. `synthetics_global_variable_read`
      2. `apm_api_catalog_read`
   4. public and private locations
      1. `synthetics_private_location_read`

### Synthetics export workflow

#### Instruction

This first step should be a create a node based file where we can input environment variables and the API keys to make the calls to gather all the synthetics and other resources we'll need to migrate

Likely we need to get all all resources, and write them to appropriate files to iterate over before we work on the migration steps. We should keep API separate from UI based synthetics.

#### Related resources

[Get all synthetic tests](https://docs.datadoghq.com/api/latest/synthetics/#get-the-list-of-all-synthetic-tests)

**GET** https://api.datadoghq.com/api/v1/synthetics/tests

[Get a test configuration](https://docs.datadoghq.com/api/latest/synthetics/?code-lang=typescript#get-a-test-configuration)

**GET** https://api.datadoghq.com/api/v1/synthetics/tests/{public_id}

[Get an API test](https://docs.datadoghq.com/api/latest/synthetics/#get-an-api-test)

**GET** https://api.datadoghq.com/api/v1/synthetics/tests/api/{public_id}

[Get a Browser test](https://docs.datadoghq.com/api/latest/synthetics/#get-a-browser-test)

**GET** https://api.datadoghq.com/api/v1/synthetics/tests/browser/{public_id}

[Get all global variables](https://docs.datadoghq.com/api/latest/synthetics/#get-all-global-variables)

**GET** https://api.datadoghq.com/api/v1/synthetics/variables

### Migration to Checkly workflow

#### UI based migration

For each UI based synthetic we need to convert to a Playwright test first. This can be done with AI. After that we need to create Browser checks based on the checkly.rules.md file - there is a Browser construct there that we can reference.

#### API based migration

For each API based synthetic we just need to convert from the Datadog based synthetic and rewrite as a API check using the checkly.rules.md file. 

#### Multi Step Check based migration
If an API has subtype: multi in Datadog we should convert to a Multi Step API check. This means convert to a Playwright test that doesn't call the browser and then tie to a Multi Step check construct.

**Implemented Pipeline:**

1. `npm run filter-multi` - Separates multi-step tests into `exports/multi-step-tests.json`
2. `npm run generate:multi-specs` - Generates Playwright `.spec.ts` files from the JSON
3. `npm run generate:multi-checks` - Generates `MultiStepCheck` constructs referencing the spec files
4. `npm run migrate:multi` - Runs steps 2-3 in sequence

**Key Files:**
- `src/04-generate-api-check-constructs-from-json.js` - Generates ApiCheck constructs
- `src/05-generate-multi-step-specs.js` - Converts Datadog steps to Playwright API test code
- `src/06-generate-multi-step-constructs.js` - Generates MultiStepCheck constructs with Datadog metadata

**Output Locations (separated by public/private locations):**
- API checks: `checkly-migrated/__checks__/api/{public,private}/`
- Multi-step checks: `checkly-migrated/__checks__/multi/{public,private}/`
- Playwright specs: `checkly-migrated/tests/multi/{public,private}/`

**Location Separation Logic:**
- Tests with ANY private location (`pl:*`) → `private/` folder
- Tests with ONLY public locations → `public/` folder

**File Naming Convention:**
- Filenames are based on the Datadog synthetic `name` (e.g., `sports-portal-score-api.check.ts`)
- The `logicalId` in constructs uses the Datadog `public_id` for traceability

**Attribute Mappings (Datadog → Checkly MultiStepCheck):**
- `public_id` → `logicalId` (construct ID)
- `name` → `name`
- `tags` → `tags`
- `options.tick_every` → `frequency`
- `options.retry` → `retryStrategy`
- `locations` → `locations` (public) + `privateLocations` (pl:* prefixed)
- `status: "live"` → `activated: true`

**Step Mappings (Datadog → Playwright):**
- `steps[].request.method` → `request.get()`, `request.post()`, etc.
- `steps[].request.url` → URL parameter
- `steps[].request.headers` → `headers` option
- `steps[].request.body` → `data` option
- `steps[].assertions` → `expect()` calls
- `steps[].allowFailure: true` → `expect.soft()` (soft assertions)

**Non-HTTP Step Limitation:**
Tests containing non-HTTP steps are **skipped entirely** during migration. Playwright's request API only supports HTTP/HTTPS.

| Skipped Subtype | Alternative Checkly Construct |
|-----------------|-------------------------------|
| `tcp` | `TcpMonitor` |
| `icmp` | Not available |
| `dns` | `DnsMonitor` |
| `wait` | Manual implementation |

Skipped tests are recorded in `_manifest.json` under the `skipped` array with their incompatible subtypes.

**Manual Review Required:**
- `extractedValues` - Variable extraction between steps may need manual adjustment
- Private locations (`pl:*`) - Need to be mapped to Checkly PrivateLocation constructs
- Complex body parsing (JSON path, regex) - May need manual implementation
- Non-HTTP tests - Need manual conversion using TcpMonitor, DnsMonitor, or custom solutions

Again we mainly want repeatable logic that can help us migrate multiple customers over to Checkly, not one off solutions.

### Browser Test Migration

**Implemented Pipeline:**

1. `npm run generate:browser-specs` - Generates Playwright `.spec.ts` files from browser tests
2. `npm run generate:browser-checks` - Generates `BrowserCheck` constructs referencing the spec files
3. `npm run migrate:browser` - Runs steps 1-2 in sequence

**Key Files:**
- `src/07-generate-browser-specs.js` - Converts Datadog browser steps to Playwright test code
- `src/08-generate-browser-constructs.js` - Generates BrowserCheck constructs with Datadog metadata

**Output Locations (separated by public/private locations):**
- Browser checks: `checkly-migrated/__checks__/browser/{public,private}/`
- Playwright specs: `checkly-migrated/tests/browser/{public,private}/`

**Attribute Mappings (Datadog → Checkly BrowserCheck):**
- `public_id` → `logicalId` (construct ID)
- `name` → `name`
- `tags` → `tags`
- `options.tick_every` → `frequency`
- `options.retry` → `retryStrategy`
- `locations` → `locations` (public) + `privateLocations` (pl:* prefixed)
- `status: "live"` → `activated: true`

**Step Mappings (Datadog → Playwright):**

| Datadog Step Type | Playwright Equivalent |
|-------------------|----------------------|
| `goToUrl` | `page.goto()` |
| `typeText` | `locator.fill()` |
| `click` | `locator.click()` |
| `hover` | `locator.hover()` |
| `pressKey` | `page.keyboard.press()` |
| `selectOption` | `locator.selectOption()` |
| `wait` | `page.waitForTimeout()` |
| `refresh` | `page.reload()` |
| `scroll` | `page.evaluate(() => window.scrollBy())` |
| `assertElementPresent` | `expect(locator).toBeVisible()` |
| `assertElementContent` | `expect(locator).toContainText()` |
| `assertPageContains` | `expect(page.locator("body")).toContainText()` |
| `assertCurrentUrl` | `expect(page).toHaveURL()` |
| `runApiTest` | `page.request.get/post()` |

**Element Locator Extraction Priority:**
1. ID attribute (`#elementId`)
2. data-testid attribute (`[data-testid="value"]`)
3. name attribute (`[name="value"]`)
4. Text content (`page.getByText()`)
5. CSS class (`.className`)
6. XPath (fallback)

**Variable Conversion:**
- Datadog: `{{ VARIABLE_NAME }}`
- Checkly: `${process.env.VARIABLE_NAME}`

**Manual Review Required:**
- Element locators may need adjustment if Datadog's multiLocator data is incomplete
- Private locations (`pl:*`) - Need to be mapped to Checkly PrivateLocation constructs
- Complex assertions with regex patterns may need manual refinement
- `runApiTest` embedded API calls - May need additional assertion logic

### Environment Variables Migration

**Implemented Pipeline:**

1. `npm run convert:variables` - Converts Datadog global variables to Checkly format

**Key Files:**
- `src/09-convert-global-variables.js` - Converts variables and generates import/delete scripts

**Output Location:**
- `checkly-migrated/variables/`

**Output Files:**
- `env-variables.json` - Non-secure variables with values (clean array of `{key, value, locked}`)
- `secrets.json` - Secure variables without values (need manual entry)
- `create-variables.sh` - Shell script to create vars via Checkly API
- `delete-variables.sh` - Shell script to delete vars via Checkly API

**Attribute Mappings (Datadog → Checkly):**
- `name` → `key`
- `value.value` → `value`
- `value.secure: true` → `locked: true` (and empty value - Datadog doesn't export secure values)
- `value.secure: false` → `locked: false`

**Important Notes:**
- Datadog does NOT export values for secure variables
- Secret values must be obtained from secure storage and filled in manually
- The shell scripts require `jq` to be installed
- Variables/secrets exist outside version control (sensitive data)