# Rhyme2

A language design in progress, with a working **parser** and a **dynamic
evaluator** in plain Node.js. No dependencies.

`SPEC.md` holds the design: settled rules (§12), open questions (§15), and
current syntax **v4 (§19)**; §17/§18 keep v2 and v3 for history.

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
sum: int;                 # optional: narrows the sink
$sum = add_int 1 2;
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
node test/run.mjs      # examples parse, reject cases fail (67 cases)
node test/eval.mjs     # runnable examples produce the expected output (42 cases)
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

The evaluator is dynamic — types are values and checks are runtime checks; there
is **no static checker** yet. It implements syntax v4 (§19):

- `?` is the top/dynamic type: any value, any number of writes; it is never
  usable as a type (no dependent types);
- `@T` is a named type variable and `@?` an anonymous one: a module value’s hole
  is solved by the first assignment, a function parameter’s is fresh per call;
- values, mutable environments, top-to-bottom initialisation;
- binding/assignment uses `=` (`$x = e`, `name $keys = e`, `expr.field = v`);
  `<-` is gone and is a parse error;
- modules as bare statement lists: results go to output sinks (`$stdout` and
  shebang `--output name:path`), rendered at the end;
- declarations with display literals are **constants** (types/constructors);
  `$type_1 = …` is rejected;
- typed constants/defaults (`name: T => default`), shared or fresh as
  parameterised; named braces fill omitted parameters;
- bodies `... expr` / `... r: { … }`; `=> rhs` without `...` is a default;
- tables: positional keys and `${…}` groups, highest specificity wins, the body
  is the fallback; a clause `...` body sees only unmatched parameters;
- slots: `$[T]`/`$[@T]`/`$[@?]` type arguments; `$[X: T]`/`$[X: @T]`/`$[X: ?]`
  value slots; `$[X: T => ?]` unpacks a `?` value as a concrete `T`;
- shapes: `$(1)`, `$(ctor …)`, `$(type_1)`; typed patterns `$(T => v)` are gone;
- headless narrowing `$[X: int => ?] = G;`;
- generic dispatch by value shapes (`fmap`) and dynamic dispatch by `?` unpacking
  (`to_string`);
- record types and construction (`counter { $id = 1 }`, `point int { }`),
  methods as fields, per-instance state, visibility from the display template;
- application: positional, partial, and named `{ $p = v }` braces; `@` holes are
  inferred from the supplied values;
- display: templates with holes and backslash escapes, `to_string`; strings are
  quoted at the boundary;
- operators: `! && || == != < <= > >=` (no arithmetic operators);
- arithmetic builtins `add_int` / `add`, curried: `add_int 1` is a function;
  `print_int` / `print_float` / `print_bool` return strings.

Examples that run: 01–16, 19–32, 39–41; 17/18, 33–38 and 42 are deliberate
runtime errors (unassigned `F`, `H` with keys but no body, constant assignment,
missing argument, inference conflict, unpack miss, illegal concrete slot on `?`,
dependent type position, bodyless clause with a non-unit result). Example 23
keeps the value/table part; its dependent type position is legacy.

Not implemented: the static checker and full type inference. Removed v1–v3 forms
are parse/runtime errors, kept as `test/reject/` cases.

## Comments

`#` starts a comment to the end of the line, so `#!/bin/rhyme` is a comment too.
