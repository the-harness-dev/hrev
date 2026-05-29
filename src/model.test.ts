import { test, describe } from "node:test";
import assert from "node:assert";
import { resolveModel } from "./model";

describe("resolveModel", () => {
  const ORIGINAL_HREV_MODEL = process.env.HREV_MODEL;

  test.afterEach(() => {
    if (ORIGINAL_HREV_MODEL !== undefined) {
      process.env.HREV_MODEL = ORIGINAL_HREV_MODEL;
    } else {
      delete process.env.HREV_MODEL;
    }
  });

  test("rule-level model wins", () => {
    process.env.HREV_MODEL = "env-model";
    assert.strictEqual(resolveModel("rule-model", "project-model"), "rule-model");
  });

  test("project-level model is used when rule is absent", () => {
    process.env.HREV_MODEL = "env-model";
    assert.strictEqual(resolveModel(undefined, "project-model"), "project-model");
  });

  test("env var is used when rule and project are absent", () => {
    process.env.HREV_MODEL = "env-model";
    assert.strictEqual(resolveModel(undefined, undefined), "env-model");
  });

  test("throws when none is specified", () => {
    delete process.env.HREV_MODEL;
    assert.throws(() => resolveModel(undefined, undefined), /No model specified/);
  });

  test("empty string is falsy, falls through to next source", () => {
    process.env.HREV_MODEL = "env-model";
    assert.strictEqual(resolveModel("", "project-model"), "project-model");
  });
});
