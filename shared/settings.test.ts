import { describe, expect, it } from "vitest";
import { sidekickSettings } from "./settings";

describe("sidekick settings", () => {
  it("remembers model configs by default", () => {
    expect(sidekickSettings.schema.parse({}).rememberModelConfig).toBe(true);
  });

  it("enables model config memory when migrating older settings", () => {
    const migrated = sidekickSettings.migrate?.({ defaultModel: "follow" }, 3);
    expect(migrated).toMatchObject({ rememberModelConfig: true });
  });
});
