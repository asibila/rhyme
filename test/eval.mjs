// Executes the runnable examples and compares stdout.
//   node test/eval.mjs
//   node test/eval.mjs --dump   (show actual output)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../src/eval.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const show = process.argv.includes("--dump");

const cases = [
  { file: "01-types-fgh", out: "\"int\"\n\"two\"\n\"one\"\n" },
  { file: "02-count", out: "" },
  { file: "03-rec-type", out: "" },
  { file: "04-bool-type", out: "" },
  { file: "05-point", out: "(10, 20)\n" },
  { file: "06-tuple-func", out: "(10, 20, 30)\n" },
  { file: "07-shadow", out: "123\n222\n" },
  { file: "08-higher-order", out: "123\n()\n" },
  { file: "09-var-record", out: "1000\n123\n" },
  { file: "10-module-expr", out: "123\n" },
  { file: "11-module-string", out: "\"abc\"\n" },
  { file: "12-module-block", out: "123\n" },
  { file: "13-ordering", out: "\"int\"\n\"any\"\n\"int\"\n\"g\"\n\"g\"\n" },
  { file: "14-arrow", out: "123\n1\n" },
  { file: "15-either-cast", out: "1\n" },
  { file: "16-inferred-signature", out: "" },
  { file: "17-cast-unification", error: /'F' has not been assigned/ },
  { file: "18-miss", out: "\"one\"\n\"fallback\"\n\"one-true\"\n\"fallback\"\n\"fallback\"\n", error: /has no body/ },
  { file: "19-counter", out: "0\n1\n" },
  { file: "20-operators", out: "1\n2\n3\n4\n5\n6\n7\n" },
  { file: "21-keys-disambiguate", out: "" },
  { file: "22-escapes", out: "" },
  { file: "23-questionmark", out: "" },
  { file: "24-module", out: "0<fn><fn>\n" },
  { file: "25-add-int", out: "3\n30\n42\n" },
  { file: "26-fmap-generic", out: "11-12-\n\"1\"-\"2\"-\n" },
  { file: "27-deduce", out: "1222-1123-\n" },
  { file: "28-partial-group", out: "\"42\"\n\"fallback\"\n" },
  { file: "29-parametric-types", out: "123\n123\nc1B\n\"5\"\n\"abc\"\npoint-of-int\npoint-of-?\n123\n1\n1\n" },
  { file: "30-inference", out: "123\n\"abc\"\n1\n5\n" },
  { file: "31-slots", out: "1\n2\n3\n1\n4\n7\n" },
  { file: "32-generic-box", out: "box-5\n" },
  { file: "33-constant", error: /constant/ },
  { file: "34-missing-arg", error: /missing named argument/ },
  { file: "35-inference-conflict", error: /expected int, got string/ },
  { file: "36-unpack-miss", error: /no key matches/ },
  { file: "37-concrete-slot", error: /on a \? parameter/ },
  { file: "38-dependent-type", error: /is not a type/ },
  { file: "39-type-args", out: "1\n2\n" },
  { file: "40-type-vars", out: "point-of-int\npoint-of-@?\n" },
  { file: "41-shapes", out: "12\n\"ok\"\n" },
  { file: "42-bodyless-nonunit", error: /bodyless clause requires a unit result/ },
  { file: "43-guards", out: "1\n1\n2\n3\n4\n5\n6\n7\n" },
  { file: "44-guard-fail", out: "null\n" },
  { file: "45-guard-nonunit", error: /guard predicate must return/ },
  { file: "46-function-guards", out: "7\n7\n10\n3\n" },
  { file: "47-function-guard-fail", out: "null\n" },
  { file: "48-comparison-outside", error: /comparisons are only allowed in guards/ },
  {
    file: "49-fable-generator",
    out:
      "A Small Fable\n" +
      "the brave fox sees a quiet mouse.\n" +
      "every curious owl follows the clever cat.\n" +
      "a quiet mouse wakes the brave dog.\n" +
      "cats\n" +
      "mice\n" +
      "the brave dog\n" +
      "fox\n" +
      "a clever fox follows the brave owl.\n" +
      "In the forest, softly.\n",
  },
  { file: "50-factoriel", out: "720\n" },
  { file: "51-bare-fn", bare: 41, out: "42" },
  { file: "52-null-guards", out: "null\nnull\n7\n6\nfalse\n7\nnull\n()\n" },
];

let ok = 0;
let bad = 0;

for (const c of cases) {
  const src = readFileSync(`${here}../examples/${c.file}.rhy`, "utf8");
  let actual = "";
  let error = null;
  try {
    const r = run(src);
    if (c.bare != null) {
      if (r.stdout) throw new Error(`bare mode wrote stdout: ${JSON.stringify(r.stdout)}`);
      const v = r.value.call([{ k: "num", v: c.bare }]);
      actual = String(v.v);
    } else {
      actual = r.stdout + (r.value.k !== "unit" ? r.display + "\n" : "");
    }
  } catch (e) {
    actual = e.stdout || "";
    error = e;
  }

  const expected = c.out ?? "";
  const outOk = actual === expected;
  const errOk = c.error ? !!error && c.error.test(error.message) : !error;

  if (outOk && errOk) {
    ok++;
    console.log(`ok   ${c.file}`);
  } else {
    bad++;
    console.log(`FAIL ${c.file}`);
    if (!outOk) {
      console.log(`  expected stdout ${JSON.stringify(expected)}`);
      console.log(`  actual   stdout ${JSON.stringify(actual)}`);
    }
    if (!errOk) {
      console.log(`  error: ${error ? error.message : "<none>"}`);
    }
  }
  if (show) console.log(JSON.stringify(actual));
}

console.log(`\n${ok} passed, ${bad} failed`);
process.exitCode = bad ? 1 : 0;
