# Rhyme2

A language design in progress, with a working **parser** and a **dynamic
evaluator** in plain Node.js. No dependencies.

`SPEC.md` holds the design: settled rules (§12), open questions (§15), and
current syntax v3 (§18); §17 keeps v2 for history.

## Run

Execute a program:

```
node bin/rhyme.mjs --run examples/01-types-fgh.rhy
```

```
"int"
"two"
"one"
```

Outputs are rendered in display form when the program finishes, so strings keep
their quotes. A shebang can add file sinks:

```
#!/bin/rhyme --output sum:out/sum.txt
$sum <- add_int 1 2;
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
node test/run.mjs      # every example parses (44 cases)
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
yet. It implements syntax v3 (§18):

- values, mutable environments, top-to-bottom initialisation;
- modules as bare statement lists: no `self`, results go to output sinks
  (`$stdout` and shebang `--output name:path`), rendered at the end;
- bodies `... expr` and `... r: { … }` (the named result starts from the declared
  type); a contextual `...` lambda is legal as a direct call argument;
- tables: positional keys and `${…}` groups (partial groups match by parameter
  name), highest specificity wins, the body is the fallback; a clause `...` body
  sees only the parameters the clause did not match;
- `$f <- g` makes `g` a function's fallback;
- patterns: literals, constructors, binders, type slots, packed `(T => v)`;
- record types and construction (`counter { $id <- 1 }`), methods as fields,
  per-instance state, visibility from the display template;
- application: positional, partial, and named `{ $p <- v }` braces, with
  call-site deduction of omitted type parameters;
- display: templates with holes and backslash escapes, `to_string`; strings are
  quoted at the boundary;
- operators: `! && || == != < <= > >=` (no arithmetic operators);
- arithmetic builtins `add_int` / `add`, curried: `add_int 1` is a function;
  `print_int` / `print_float` / `print_bool` return strings.

Examples that run: 01–28. `22-system` declares stubs and prints nothing; `17`
and `18` are expected to fail at run time (a declared-but-unassigned `F`, and `H`
with keys but no body).

Not implemented: the static checker. Removed v1/v2 forms are parse errors, kept
as `test/reject/` cases.

## Comments

`#` starts a comment to the end of the line, so `#!/bin/rhyme` is a comment too.
