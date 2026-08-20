/**
 * Companion Playwright config for a migrated multi-browser Playwright Check Suite.
 * One project per distinct engine; the project names match the check's pwProjects.
 * testDir points at the generated spec directory; testMatch scopes discovery to
 * this check's single spec so it never sweeps in sibling browser specs.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '../../../tests/browser/public',
  testMatch: 'pwcs-multi-browser-flow-syn-306-mbf.spec.ts',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
