import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"));

test("the package declares its OMP entry point and is not auto-installed into Pi", () => {
  expect(packageJson.omp.extensions).toEqual(["./src/index.ts"]);
  expect(packageJson.pi).toBeUndefined();
});
