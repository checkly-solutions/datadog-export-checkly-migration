import { CheckGroupV2 } from "checkly/constructs";

export const public_locations_group = new CheckGroupV2(
  "sample-migrated-public-checks",
  {
    name: "Sample Migrated Public Checks",
    activated: false,
    tags: ["migrated", "public", "sample"],
  }
);
