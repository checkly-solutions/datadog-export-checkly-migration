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
  options?: Record<string, unknown>;
  message?: string;
  monitor_id?: number;
  created_at?: string;
  modified_at?: string;
  creator?: Record<string, unknown>;
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
