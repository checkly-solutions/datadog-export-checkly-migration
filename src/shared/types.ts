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
  config?: Record<string, unknown>;
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
  };
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
  };
}
