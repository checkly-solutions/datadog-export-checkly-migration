import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: `sample migrated checks - public`,
  logicalId: `sample-migrated-checks-public`,
  repoUrl: "https://github.com/example-org/checkly-migration-sample",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/public/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    runLocation: "us-west-1",
  },
});

export default config;
