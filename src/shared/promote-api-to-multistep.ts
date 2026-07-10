/**
 * Shared, reason-parameterized promotion transform (REGX-05/06/08).
 *
 * A single-step Datadog API test that carries a regex assertion (operator
 * 'matches' or 'doesNotMatch') cannot be represented faithfully by a Checkly
 * ApiCheck without downgrading the assertion. Instead of downgrading, the whole
 * test is promoted to a one-step multi-step test that replays the request and
 * asserts with a native RegExp downstream.
 *
 * This module is the single seam the rest of phase 05 routes through: step 03
 * routes on shouldPromote, steps 05/06 replay the promoted step, and step 12
 * reports on the _promotionReason field set here. It is pure: no module-level
 * mutable state, no IO, no re-escaping of regex targets (targets embed verbatim
 * and are escaped at emission time via parseDatadogRegex, REGX-02).
 */

import type { DatadogTest, DatadogAssertion, DatadogRequest } from './types.ts';

/**
 * Why a test must leave the ApiCheck path. 'regex' is the only reason wired in
 * v1; 'javascript' is the designed-in extension point (REGX-08, TRKB-04) that
 * milestone 2 turns on without reshaping this transform.
 */
export type PromotionReason = 'regex' | 'javascript';

/**
 * Detect the reasons a test must be promoted off the ApiCheck path.
 *
 * @param test A Datadog test (single-step API test in practice).
 * @returns ['regex'] when any assertion uses operator 'matches' or
 *   'doesNotMatch'; [] when none apply.
 */
export function detectPromotionReasons(test: DatadogTest): PromotionReason[] {
  const reasons: PromotionReason[] = [];
  const assertions = (test.config?.assertions as DatadogAssertion[] | undefined) ?? [];
  if (assertions.some((a) => a.operator === 'matches' || a.operator === 'doesNotMatch')) {
    reasons.push('regex');
  }
  // JS-assertion reason: designed-in extension point (REGX-08, TRKB-04) but NOT
  // wired in v1. Milestone 2 enables it here without changing the transform:
  // if (assertions.some((a) => a.type === 'javascript')) reasons.push('javascript');
  return reasons;
}

/**
 * Whether a test should be promoted to a multi-step test.
 *
 * Excludes subtype 'multi' tests, which the existing step 03 split already
 * routes; promotes only single-step tests that carry a promotion reason.
 *
 * @param test A Datadog test.
 * @returns true only for a non-multi test with at least one promotion reason.
 */
export function shouldPromote(test: DatadogTest): boolean {
  return test.subtype !== 'multi' && detectPromotionReasons(test).length > 0;
}

/**
 * Reshape a single-step API test into a one-step multi-step test.
 *
 * Produces exactly one step holding ALL of the test's assertions (REGX-06: one
 * unit, never a subset and never split). The step's request replays method,
 * url, headers, body, basicAuth, query, and certificate from config.request,
 * plus follow_redirects and allow_insecure lifted from test.options, so the
 * downstream generators (step 05) can reproduce the original request. All
 * top-level fields (status, options, tags, locations, public_id, etc.) are
 * preserved via spread. The step subtype is 'http' so hasOnlyHttpSteps admits
 * it. A _promotionReason field records why, consumed by the step 12 report.
 *
 * @param test The single-step API test to promote.
 * @param reasons The promotion reasons detected for this test.
 * @returns A shallow-cloned test carrying a single config.steps entry.
 */
export function promoteApiTestToMultiStep(
  test: DatadogTest,
  reasons: PromotionReason[],
): DatadogTest {
  const req = (test.config?.request as DatadogRequest | undefined) ?? {};
  const options = (test.options ?? {}) as {
    follow_redirects?: boolean;
    allow_insecure?: boolean;
  };
  const assertions = (test.config?.assertions as DatadogAssertion[] | undefined) ?? [];
  // Drop the now-stale top-level request/assertions from the copied config: they
  // are fully carried into the single step below, and no downstream step (05/06/
  // 12) reads config.request or config.assertions for a promoted multi-step test.
  // Keeping them would duplicate the data in multi-step-tests.json (IN-02).
  const { request: _request, assertions: _assertions, ...restConfig } =
    (test.config ?? {}) as Record<string, unknown>;
  return {
    ...test,
    // Non-tag field consumed by the step 12 promotion report section.
    _promotionReason: reasons.join(','),
    config: {
      ...restConfig,
      steps: [
        {
          name: test.name,
          subtype: 'http',
          request: {
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: req.body,
            basicAuth: req.basicAuth,
            query: req.query,
            certificate: req.certificate,
            follow_redirects: options.follow_redirects,
            allow_insecure: options.allow_insecure,
          },
          assertions,
        },
      ],
    },
  } as DatadogTest;
}
