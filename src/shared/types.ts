/**
 * Shared TypeScript interfaces for Datadog to Checkly migration
 */

/**
 * Base Datadog test interface (from API response)
 */
export interface DatadogTest {
  public_id: string;
  name: string;
  type: string;
  subtype?: string;
  status?: string;
  tags?: string[];
  locations?: string[];
  config?: Record<string, unknown> & {
    configVariables?: DatadogConfigVariable[];
  };
  options?: Record<string, unknown> & {
    /**
     * Raw Datadog multi-browser device profiles (e.g. ["chrome.laptop_large",
     * "firefox.laptop_large"]). Lives at options.device_ids, never config.device_ids.
     * Carried untouched through step 01's transformTestLocations spread; read by
     * src/07 generateSpecFile to derive the Playwright engine set
     * (deriveEnginesFromDeviceIds) and by nothing else. Only the desktop
     * browser.viewport syntax (chrome.laptop_large) is parsed; the mobile
     * synthetics:mobile:device:* syntax is out of scope and lands in unmappedDeviceIds.
     */
    device_ids?: string[];
  };
  message?: string;
  monitor_id?: number;
  created_at?: string;
  modified_at?: string;
  creator?: Record<string, unknown>;
  /**
   * Set by the promotion transform (promote-api-to-multistep.ts) to record why
   * a test left the ApiCheck path (e.g. 'regex'). Consumed by step 06 to append
   * the promotedFromApiCheck marker tag and by step 12's promotion report.
   */
  _promotionReason?: string;
}

/**
 * Transformed test with pre-processed locations (output from step 01)
 */
export interface TransformedTest extends Omit<DatadogTest, 'locations'> {
  locations: string[];           // Mapped public Checkly locations
  privateLocations: string[];    // Checkly private location slugs (derived from Datadog pl:xxx)
  originalLocations: string[];   // Original Datadog locations for reference
}

/**
 * Browser test interface (for steps 07, 08)
 */
export interface BrowserTest {
  public_id: string;
  name: string;
  status?: string;
  tags?: string[];
  // Pre-processed by step 01:
  locations: string[];
  privateLocations: string[];
  originalLocations: string[];
  options?: {
    tick_every?: number;
    retry?: {
      count?: number;
      interval?: number;
    };
    ignoreServerCertificateError?: boolean;
    /**
     * Raw Datadog multi-browser device profiles (e.g. ["chrome.laptop_large",
     * "firefox.laptop_large"]). Lives at options.device_ids, never config.device_ids.
     * Carried untouched through step 01's transformTestLocations spread; read by
     * src/07 generateSpecFile to derive the Playwright engine set
     * (deriveEnginesFromDeviceIds) and by nothing else. Only the desktop
     * browser.viewport syntax (chrome.laptop_large) is parsed; the mobile
     * synthetics:mobile:device:* syntax is out of scope and lands in unmappedDeviceIds.
     */
    device_ids?: string[];
  };
  config?: {
    steps?: BrowserStep[];
    configVariables?: DatadogConfigVariable[];
  };
}

/**
 * Datadog client certificate configuration (mTLS).
 * Present on tests that require mutual TLS authentication.
 */
export interface DatadogCertificate {
  key?: { filename?: string; content?: string };
  cert?: { filename?: string; content?: string };
}

/**
 * Datadog configVariable entry from test config.
 * Three shapes exist:
 *   - type: "text", secure: false — has pattern (the value) and example
 *   - type: "text", secure: true  — no pattern/example (secret, value not exported)
 *   - type: "global"              — reference to account-level variable (has id)
 */
export interface DatadogConfigVariable {
  type: 'text' | 'global' | string;
  name: string;
  pattern?: string;
  example?: string;
  secure?: boolean;
  id?: string;
}

/**
 * Browser test step
 */
export interface BrowserStep {
  name: string;
  type: string;
  params?: Record<string, unknown>;
  allowFailure?: boolean;
}

/**
 * Datadog assertion format
 */
export interface DatadogAssertion {
  type: string;
  operator: string;
  target?: string | number;
  property?: string;
  targetjsonpath?: {
    jsonpath: string;
    operator: string;
    targetvalue: string | number;
  };
}

/**
 * Datadog retry configuration
 */
export interface DatadogRetry {
  count?: number;
  interval?: number;
}

/**
 * Multi-step test request
 */
export interface DatadogRequest {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  certificate?: DatadogCertificate;
  follow_redirects?: boolean;
  allow_insecure?: boolean;
  /**
   * HTTP Basic auth credentials from the Datadog raw export (config.request.basicAuth).
   * type 'web' indicates a form/browser login, not an Authorization: Basic header;
   * downstream emission gates on type !== 'web'.
   */
  basicAuth?: { username?: string; password?: string; type?: string };
  /**
   * Query parameters from the Datadog raw export (config.request.query).
   * Kept under the raw name 'query', not the step-02 intermediate 'queryParameters'.
   */
  query?: Record<string, string>;
}

/**
 * Datadog extracted value from a multi-step test step.
 * Used for inter-step variable extraction (e.g., OAuth token from response body).
 */
export interface DatadogExtractedValue {
  type: 'http_body' | string;
  parser: {
    type: 'json_path' | 'regex' | string;
    value: string;
  };
  name: string;
  secure?: boolean;
}

/**
 * Multi-step test step
 */
export interface DatadogStep {
  name: string;
  subtype?: string;
  request: DatadogRequest;
  assertions: DatadogAssertion[];
  allowFailure?: boolean;
  extractedValues?: DatadogExtractedValue[];
}

/**
 * Multi-step test interface (for steps 05, 06)
 */
export interface MultiStepTest {
  public_id: string;
  name: string;
  // Pre-processed by step 01:
  locations: string[];
  privateLocations: string[];
  originalLocations: string[];
  status?: string;
  tags?: string[];
  options?: {
    tick_every?: number;
    retry?: DatadogRetry;
  };
  config?: {
    steps?: DatadogStep[];
    configVariables?: DatadogConfigVariable[];
  };
}
