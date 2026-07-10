/**
 * Migrated from Datadog Synthetic: syn-306-mbf
 */
import {
  PlaywrightCheck,
  Frequency,
} from "checkly/constructs";

new PlaywrightCheck("browser-pwcs-multi-browser-flow-syn-306-mbf", {
  name: "PWCS Multi Browser Flow",
  tags: ["env:synthetic","team:example","migration_check_id:syn-306-mbf","reviewMigrationFlag"],
  playwrightConfigPath: "pwcs-multi-browser-flow-syn-306-mbf.playwright.config.ts",
  pwProjects: ["chromium","firefox"],
  frequency: Frequency.EVERY_5M,
  locations: ["us-east-1"],
  activated: true,
  muted: false,
});
