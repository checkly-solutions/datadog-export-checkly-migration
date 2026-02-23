import { defineConfig } from "checkly";

const config = defineConfig({
  projectName: `sample migrated checks - private`,
  logicalId: `sample-migrated-checks-private`,
  repoUrl: "https://github.com/example-org/checkly-migration-sample",
  checks: {
    activated: true,
    muted: false,
    runtimeId: "2025.04",
    checkMatch: "__checks__/**/private/*.check.ts",
    ignoreDirectoriesMatch: [],
  },
  cli: {
    privateRunLocation: "some-private-location0-slug"
  },
});

export default config;
