# Rhyme2

A language design in progress, plus an **executable front end**: a lexer and
parser for every example so far, in plain Node.js with no dependencies.

There is no evaluator yet — the program parses and shows you the syntax tree.
`SPEC.md` holds the semantics we've pinned down and the questions still open.

## Requirements

Node.js 20 or newer (developed on Node 26). Nothing to install.

## Run

Parse all examples:

```
node bin/rhyme.mjs examples
```

Parse one file and print its syntax tree:

```
node bin/rhyme.mjs --dump examples/05-point.rhy
```

Look at the tokens instead:

```
node bin/rhyme.mjs --tokens examples/01-types-fgh.rhy
```

Run the test suite (valid examples must parse, `test/reject/*` must not):

```
node test/run.mjs
```

With npm scripts:

```
npm run check
npm run dump -- examples/09-var-record.rhy
npm test
```

`--dump` also works on directories. A parse error prints the line and a caret:

```
fail test/reject/bare-keys.rhy: a definition head must be `$...` keys or a projection path at 7:10 (got sym "<-")
func 1 2 <- (10, 20, 30);
         ^
```

## Layout

```
SPEC.md                 language notes: rules, examples, open questions
bin/rhyme.mjs           CLI: parse files/directories, dump AST or tokens
src/rhyme.mjs           lexer + parser + AST printer
examples/*.rhy          18 working snippets, one idea each
test/reject/*.rhy       snippets that must FAIL to parse
test/run.mjs            runs both sets
```

## What parses today

- `name: [in] out;` ascriptions, including function types and products
- type definitions `name: {params} `display` => (ctor; ...);`
- definitions `$name <- [binders] (result) { body };`
- `$`-quoted keys: `$[type]`, `$[X:]`, `$(expr)`, `$(ctor $[X:] ...)`
- blocks `{ ... }`, shapes `(res:)`, `()`, nested definitions
- definitions in expression position: `print ($[int] <- n)`
- display holes `\(name)` and `\(name:type)`, on types and constructors
- expressions: application, `.field`, tuple `(a, b, c)`, pair `(t => v)`, `+`
- modules with `#!/bin/rhyme`, bare expressions and `(n:int) { ... };`

Not yet: nothing is evaluated. Display holes are parsed (`\(name)` references a
binder, `\(name:type)` declares one), but they are not type-checked.

## Comments

`#` starts a comment and runs to the end of the line, so `#!/bin/rhyme` is just
a comment too. Put expected output next to `print` calls:

```
print (a + b + c);      # 60
```
