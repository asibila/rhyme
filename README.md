# Rhyme2

A language design in progress, with a working **parser** and a **dynamic
evaluator** in plain Node.js. No dependencies.

`SPEC.md` holds the design: settled rules (§12), open questions (§15), and
syntax v2 (§17).

## Run

Execute a program:

```
node bin/rhyme.mjs --run examples/01-types-fgh.rhy
```

```
int
two
one
```

Parse and dump its syntax tree:

```
node bin/rhyme.mjs --dump examples/05-point.rhy
```

Show tokens:

```
node bin/rhyme.mjs --tokens examples/01-types-fgh.rhy
```

Run the test suites:

```
node test/run.mjs      # every example parses (38 cases)
node test/eval.mjs     # every runnable example produces the expected output (28 cases)
```

With npm:

```
npm test
npm run run -- examples/19-counter.rhy
npm run dump -- examples/09-var-record.rhy
```

## Layout

```
SPEC.md              design: rules, answers, open questions
bin/rhyme.mjs        CLI: parse, dump, tokens, run
src/rhyme.mjs        lexer + parser + AST printer
src/eval.mjs         evaluator (values, dispatch, records, display)
examples/*.rhy       the corpus, one idea each
test/reject/*.rhy    programs that must fail to parse
test/run.mjs         parse checks
test/eval.mjs        execution checks
```

## What runs today

The evaluator is dynamic — types are values, but there is **no static checker**
yet. It implements syntax v2 (§17):

- values, mutable environments, top-to-bottom initialisation;
- modules as statement lists with an implicit `self`;
- bodies with parameters in scope by name and a pre-bound `self`
  (`\self (name)` renames it; the result is its final value);
- tables: positional keys and `${…}` groups (partial groups match by parameter
  name), highest specificity wins, the body is the fallback;
- patterns: literals, constructors, binders, type slots, packed `(T => v)`;
- record types and construction (`counter { $id <- 1 }`), methods as fields,
  per-instance state, visibility from the display template;
- application: positional, partial, and named `{ $p <- v }` braces;
- display: templates with holes and backslash escapes, the `\print` directive
  and `to_string`;
- operators: `! && || == != < <= > >=` (no arithmetic operators);
- arithmetic builtins `add_int` / `add`, curried: `add_int 1` is a function.

Examples that run: 01–28. `22-system` declares stubs and prints nothing; `17`
and `18` are expected to fail at run time (a declared-but-unassigned `F`, and `H`
with keys but no body).

Not implemented: the static checker. Removed v1 forms are parse errors, kept as
`test/reject/` cases.

## Comments

`#` starts a comment to the end of the line, so `#!/bin/rhyme` is a comment too.
