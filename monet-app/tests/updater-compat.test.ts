import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("updater restarts the app bundle and renders install errors", () => {
  const source = readFileSync(path.join(root, "src", "main.ts"), "utf8");
  assert.match(source, /await invoke\("restart_after_update"\)/);
  assert.doesNotMatch(source, /plugin-process/);
  assert.match(source, /class="update-error"/);
  assert.match(source, /update-error-message/);
});
