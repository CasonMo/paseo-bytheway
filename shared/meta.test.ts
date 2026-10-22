import { readFileSync } from "node:fs";
import { test } from "vitest";
import { isNewer, PLUGIN_VERSION } from "./meta";

test("isNewer compares numeric segments", () => {
  if (isNewer("0.1.3", "0.1.2")) return;
  throw new Error("0.1.3 should be newer than 0.1.2");
});

test("same version is not newer", () => {
  if (!isNewer("0.1.2", "0.1.2")) return;
  throw new Error("equal versions should not be newer");
});

test("prerelease suffix ignored for core compare", () => {
  if (!isNewer("0.13.1", "0.13.0-beta.1")) {
    throw new Error("0.13.1 should be newer than 0.13.0-beta.1 core");
  }
  if (isNewer("0.13.0-beta.1", "0.13.0")) {
    throw new Error("prerelease should not beat same core release");
  }
});

test("PLUGIN_VERSION is a semver string", () => {
  if (!/^\d+\.\d+\.\d+/.test(PLUGIN_VERSION)) throw new Error(PLUGIN_VERSION);
});

test("PLUGIN_VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    version: string;
  };
  if (pkg.version !== PLUGIN_VERSION) {
    throw new Error(`package.json ${pkg.version} != shared/meta ${PLUGIN_VERSION}`);
  }
});
