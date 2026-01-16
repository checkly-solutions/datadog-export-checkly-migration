import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: `datadog migrated checks - private`,
  logicalId: `data-dog-migrated-checks-private`,
  repoUrl: "https://github.com/modern-sapien/next-danube-webshop",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "checkly-migrated/__checks__/**/private/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    privateRunLocation: "some-private-location0-slug"
  },
});

export default config;
