// Parses examples/*.rhy (must succeed) and test/reject/*.rhy (must fail).
//
//   node test/run.mjs              run everything
//   node test/run.mjs --dump       print each AST too
//   node test/run.mjs --only point run files whose name contains "point"

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, dump } from "../src/rhyme.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const showDump = process.argv.includes("--dump");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : null;

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".rhy")) out.push(p);
  }
  return out;
}

const cases = [
  ...walk(join(here, "..", "examples")).map((f) => ({ file: f, expect: "ok" })),
  ...walk(join(here, "reject")).map((f) => ({ file: f, expect: "fail" })),
].filter((c) => !only || c.file.includes(only));

let ok = 0;
let bad = 0;

for (const { file, expect } of cases) {
  const name = relative(join(here, ".."), file);
  const src = readFileSync(file, "utf8");
  let tree = null;
  let error = null;
  try {
    tree = parse(src);
  } catch (e) {
    error = e;
  }

  if (expect === "ok" && !error) {
    ok++;
    console.log(`ok   ${name}`);
    if (showDump) console.log(dump(tree).replace(/^/gm, "     "));
  } else if (expect === "fail" && error) {
    ok++;
    console.log(`ok   ${name}  (rejected: ${error.message})`);
  } else if (expect === "fail") {
    bad++;
    console.log(`FAIL ${name}  parsed, but must be rejected`);
  } else {
    bad++;
    console.log(`FAIL ${name}  ${error.message}`);
  }
}

console.log(`\n${ok} passed, ${bad} failed`);
process.exitCode = bad ? 1 : 0;
