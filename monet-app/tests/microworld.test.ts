import assert from "node:assert/strict";
import test from "node:test";

import { microworldStateRows } from "../src/microworld.ts";

test("microworldStateRows compares the current snapshot with the prior step", () => {
  const steps = [
    { state: { code: "xyz", token: "—", retries: "0" } },
    { state: { code: "consumed", token: "abc", retries: "0" } },
  ];

  assert.deepEqual(microworldStateRows(steps, 1), [
    { key: "code", before: "xyz", value: "consumed", changed: true },
    { key: "retries", before: "0", value: "0", changed: false },
    { key: "token", before: "—", value: "abc", changed: true },
  ]);
});

test("microworldStateRows treats the first step as the initial state", () => {
  const steps = [{ state: { status: "requested" } }];

  assert.deepEqual(microworldStateRows(steps, 0), [
    { key: "status", before: null, value: "requested", changed: true },
  ]);
});

test("microworldStateRows keeps removed keys visible", () => {
  const steps = [
    { state: { code: "xyz", token: "—" } },
    { state: { token: "abc" } },
  ];

  assert.deepEqual(microworldStateRows(steps, 1)[0], {
    key: "code",
    before: "xyz",
    value: null,
    changed: true,
  });
});
