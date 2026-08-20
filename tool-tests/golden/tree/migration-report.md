# Datadog to Checkly Migration Report

**Generated:** NORMALIZED
**Source:** datadoghq.com
**Export Date:** NORMALIZED

## Summary

- **Datadog Synthetics:** 6
- **Checkly Checks Created:** 8
- **Conversion Rate:** 133%

## What Was Migrated

| Check Type | Public | Private | Total |
|------------|--------|---------|-------|
| API Checks | 1 | 1 | 2 |
| Browser Checks | 3 | 0 | 3 |
| Multi-Step Checks | 1 | 0 | 1 |
| TCP Monitors | 1 | 0 | 1 |
| DNS Monitors | 1 | 0 | 1 |

## Migration Flags

**2 flag(s)** mark points where the generator could not close a gap deterministically.
Each flagged check carries a `reviewMigrationFlag` tag; checks flagged `locator-unresolvable` are additionally deactivated (`activated: false`).

### zero-assertion (1)

- `syn-206-tuv`: This spec contains no runtime assertion; the migrated check verifies nothing. Authoring a meaningful assertion is an intent judgment left to the developer (the tool never auto-invents one).

### pwcs-engines-deduped (1)

- `syn-306-mbf`: Datadog declared 3 browser device profiles (chrome.laptop_large, firefox.laptop_large, edge.laptop_large); deduplicated to 2 distinct Playwright engine project(s) (chromium, firefox). Edge is Chromium-based and runs under the chromium project.

> **Action:** Review each flagged step in its generated spec (grep `// MIGRATION-FLAG:`), fix or replace the flagged residue, then remove the `reviewMigrationFlag` tag and re-activate any deactivated checks.

## Self-Healing Locator Chains

**1 check(s)** emitted a multi-candidate `firstMatch()` fallback chain and are left ACTIVE for review.
Each carries a `reviewMultiSelector` tag. The chain tries an ordered list of candidate locators and resolves the first that matches, searching the main page and every iframe, so a check keeps working when one selector shifts.

When every candidate misses at runtime the spec prints the `MIGRATION-LOCATOR-EXHAUSTION` token to the run log and error group, distinct from an ordinary selector timeout. Grep for it in Checkly run results to find a check whose locators all went stale.

- `syn-006-pqr` [public]: Synthetic Browser Flow

> **Action:** For each check, verify the element the chain resolved is the one the original Datadog step targeted, then remove the `reviewMultiSelector` tag once confirmed.

## Playwright Check Suites (Multi-Browser)

**1 check(s)** migrated to a Playwright Check Suite (PlaywrightCheck) because Datadog declared more than one browser.
Each runs a companion `playwright.config.ts` with one project per distinct Playwright engine, so the migrated check exercises the same browser engines the original Datadog test did.

- `syn-306-mbf` [public]: PWCS Multi Browser Flow (3 declared browser(s) -> 2 distinct Playwright engine(s))

> **Action:** After deploy, confirm each Playwright Check Suite runs the intended browser projects (the companion config lists them), then verify the migrated behavior matches the original Datadog browser test.

### Playwright Check Suite entitlement

A PlaywrightCheck requires the `PLAYWRIGHT_NATIVE` entitlement on your Checkly account.

> **Action:** Confirm the entitlement is enabled (run `npx checkly account plan PLAYWRIGHT_NATIVE` or check the Checkly billing page) before deploying any Playwright Check Suite.

### @playwright/test dependency

The generated project declares `@playwright/test` (^1.61.1) as a devDependency because Checkly bundles each Playwright Check Suite from a locally resolvable copy of the package.

> **Action:** Run `npm install` in the generated project directory before `npx checkly test` or `npx checkly deploy` so every Playwright Check Suite bundles successfully.

---

## Action Required

### 1. Create Private Locations in Checkly (1 locations)

Create these private locations in Checkly with the **exact slugs** shown below.
The generated checks already reference these slugs.

| Checkly Slug (to create) | Checks Using It | Original Datadog ID |
|--------------------------|-----------------|---------------------|
| `example-private` | 1 | pl:example-private-location-00000000 |

### 3. Import Variables to Checkly

After filling in secret values, run from `./checkly-migrated/golden/`:

```bash
npm run create-variables
```

### 4. Configure Alert Channels

**Edit:** `./checkly-migrated/golden/default_resources/alertChannels.ts`

Configure your alert channels (Email, Slack, PagerDuty, etc.) before deployment.

### 5. Test the Migration

Run from `./checkly-migrated/golden/`:

```bash
# Test public location checks
npm run test:public

# Test private location checks (after creating private locations)
npm run test:private
```

### 6. Deploy to Checkly

Run from `./checkly-migrated/golden/`:

```bash
# Deploy public checks first
npm run deploy:public

# Deploy private checks after creating private locations
npm run deploy:private
```

### 7. Backfill Checkly UUIDs

After deploying, populate the `checkly_uuid` column in `migration-mapping.csv`:

```bash
npm run update-mapping
```

This matches deployed checks by their `migration_check_id` tag and writes the Checkly UUID into the CSV for downstream tooling and dashboards.

---

## Environment Variable Usage

**1 unique variables** are referenced across all checks.

### Most Used Variables

| Variable | Checks | Example Checks |
|----------|--------|----------------|
| `AUTH_TOKEN` | 1 | Synthetic Login Flow |

---

## Notes

### Conversion Notes
- Browser test element locators may need manual review for accuracy
- Multi-step test variable extraction between steps may need adjustment
- Check groups are created but set to `activated: false` by default
- Individual checks preserve their Datadog status: `paused` monitors become `activated: false`
- Redirect and TLS options are migrated only when they diverge from the Datadog defaults: `follow_redirects: false` becomes `followRedirects: false`, `allow_insecure: true` becomes `skipSSL: true`, and browser `ignoreServerCertificateError: true` becomes `ignoreHTTPSErrors: true`. Absent fields are omitted because the Checkly defaults (follow redirects, verify TLS) match the Datadog defaults, so omission preserves the original behavior.
- A validating partner with live Datadog access should verify the explicit false-redirect and skip-TLS cases (the ones that emit `followRedirects: false` or `skipSSL: true`), since the captured export did not exercise them.

### Unsupported Features
The following Datadog features cannot be automatically migrated:

| Feature | Reason |
|---------|--------|
| SSL/ICMP tests | Checkly does not yet have direct equivalents (TCP and DNS are supported as of 2026 via TcpMonitor / DnsMonitor) |
| OPTIONS HTTP method | Checkly supports: GET, POST, PUT, HEAD, DELETE, PATCH |
| JavaScript assertions | Custom JS assertions must be manually converted to Playwright |
| Multi-step wait steps | Steps with `subtype: wait` are not supported |
