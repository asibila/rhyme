#!/usr/bin/env node
// rhyme2 — parse .rhy files and print what the grammar made of them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { lex, parse, dump } from "../src/rhyme.mjs";
import { run, EvalError } from "../src/eval.mjs";

const USAGE = `rhyme2 — parse .rhy files

usage:
  node bin/rhyme.mjs <file.rhy | directory> ...

flags:
  --dump      print the AST for each file
  --tokens    print the token stream instead
  --quiet     only report failures and the summary
  -h, --help  show this text

examples:
  node bin/rhyme.mjs examples
  node bin/rhyme.mjs examples/05-point.rhy
  node bin/rhyme.mjs --dump examples/09-var-record.rhy
  node bin/rhyme.mjs --tokens examples/01-types-fgh.rhy
`;

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const flags = new Set(argv.filter((a) => a.startsWith("-")));
const paths = argv.filter((a) => !a.startsWith("-"));

if (paths.length === 0) {
  console.log(USAGE);
  process.exit(2);
}

function walk(p, out) {
  const st = statSync(p);
  if (!st.isDirectory()) {
    out.push(p);
    return;
  }
  for (const name of readdirSync(p).sort()) {
    const q = join(p, name);
    if (statSync(q).isDirectory()) walk(q, out);
    else if (extname(name) === ".rhy") out.push(q);
  }
}

const files = [];
for (const p of paths) walk(p, files);

if (files.length === 0) {
  console.error("no .rhy files found");
  process.exit(2);
}

function caret(src, line, col) {
  const text = src.split(/\r?\n/)[line - 1] ?? "";
  return `${text}\n${" ".repeat(Math.max(0, col - 1))}^`;
}

let failed = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const name = relative(process.cwd(), f) || f;
  try {
    if (flags.has("--run")) {
      const { stdout, value, display } = run(src, { file: name });
      if (stdout) process.stdout.write(stdout);
      if (value.k !== "unit") console.log(display);
      continue;
    }
    if (flags.has("--tokens")) {
      const toks = lex(src).filter((t) => t.t !== "eof");
      console.log(`${name}: ${toks.length} tokens`);
      if (!flags.has("--quiet")) {
        for (const t of toks) console.log(`  ${t.line}:${t.col}  ${t.t}  ${JSON.stringify(t.v)}`);
      }
      continue;
    }
    const tree = parse(src);
    if (flags.has("--dump")) {
      console.log(`== ${name} ==`);
      console.log(dump(tree));
    } else if (!flags.has("--quiet")) {
      console.log(`ok   ${name}`);
    }
  } catch (e) {
    failed++;
    if (e.stdout) process.stdout.write(e.stdout);
    console.error(`fail ${name}: ${e.message}`);
    const m = /at (\d+):(\d+)/.exec(e.message);
    if (m) console.error(caret(src, Number(m[1]), Number(m[2])));
  }
}

if (!flags.has("--run") || failed) {
  console.log(`\n${files.length - failed}/${files.length} ${flags.has("--run") ? "ran" : "parsed"}`);
}
process.exitCode = failed ? 1 : 0;
