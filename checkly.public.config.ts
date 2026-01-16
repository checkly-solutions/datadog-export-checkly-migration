import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: `datadog migrated checks - public`,
  logicalId: `data-dog-migrated-checks-public`,
  repoUrl: "https://github.com/modern-sapien/next-danube-webshop",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "checkly-migrated/__checks__/**/public/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    runLocation: "us-west-1",
  },
});

export default config;
