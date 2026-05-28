import { test, describe } from "node:test";
import assert from "node:assert";
import { diffContainsPath } from "./diff";
import { Diff, DiffFile } from "./types";

 function makeDiff(paths: string[]): Diff {
   const files: DiffFile[] = paths.map((p) => ({ path: p, content: "---" }));
    return { files, raw: "" };
 }

 describe("diffContainsPath", () => {
   test("matches exact prefix", () => {
     const diff = makeDiff(["src/cli.ts", "src/graph.ts"]);
     assert.strictEqual(diffContainsPath(diff, "src/"), true);
   });

   test("no match when prefix absent", () => {
     const diff = makeDiff(["tests/cli.test.ts"]);
     assert.strictEqual(diffContainsPath(diff, "src/"), false);
   });

   test("empty diff returns false", () => {
     const diff = makeDiff([]);
     assert.strictEqual(diffContainsPath(diff, "src/"), false);
   });

   test("matches nested paths", () => {
     const diff = makeDiff(["src/utils/helpers.ts"]);
     assert.strictEqual(diffContainsPath(diff, "src/utils/"), true);
   });
 });
