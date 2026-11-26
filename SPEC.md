# Rhyme2 — working spec (v0.5)

Status: reverse-engineered from examples. Marked **[?]** where inferred, not confirmed.
Nothing here is normative yet; this exists so we can disagree with something concrete.

Current surface syntax: **v4 (§19)**. §17/§18 record v2/v3 for history.

## 1. Declarations

```
F: [int] string;          # F : int -> string
F: [int] [bool] string;   # F : int -> bool -> string   (curried)
```

* `[t]` introduces one parameter of type `t`; groups are applied left to right.
  `t = ?` means the parameter *is* a type (see 3.2).
* One bracket is exactly one parameter. They are never grouped:
  `[n:] [m:]` is two parameters, `[n: m:]` is not a thing.
* `[]` is one parameter of type **unit**, so `f: [];` is called as `f ()`.
  Arity 0 is written with no brackets at all (`get_point: point`), and is a
  different arity.
* An elided result is unit: `assign_value: [int];` is `[int] ()`.
* Binders in a declaration are **placeholders** whose types are deduced from the
  definition: `auto_function: [n:] (m:);`.
* `name: [t1] ... [tn] r` declares `name : t1 -> ... -> tn -> r`.
* Parameters are curried: `F 1` is a value of type `[bool] string`, i.e. `bool -> string`.
* Partial application is first-class, hence `F 1` is observable *before* arg 2 is known.

## 2. Tables and rules

```
$F = [] "";              # root of F's key trie, default value ""
F $[int] = "int";        # depth-1 key: [int]  -> "int"
```

* `=` **defines** an entry; it does not overwrite.
* `$X` is a **definition head**, not an expression. The store has no first-class
  name: `F` (unmarked) is the callable value, but `$F` cannot be passed, stored,
  or returned.
* A key is a *path* of parameters: `F $[int] $[true] = "x"` is depth 2.
* `[]` is the empty path (depth 0) = the root.
* The root's value is the fallback consulted when no key path matches.
* Matching: **specificity and source order both matter.** `$F = body` assigns
  the *whole* object; `F $[int] = ...` assigns *part* of it and shadows the
  whole. Which of the two criteria wins when they disagree is Q3.

## 3. Patterns

A key is written in **pattern space**, and `$` is the marker for pattern space.
It is mandatory, because a bare `count new_rec` would parse as an application:

```
count $(new_rec) = 0;                        # the value new_rec
count $(unshift_rec $[X:] $[Y:]) = ...;      # an application, two holes
F $[int] = "int";                            # one type slot
G $(1) = "one";                              # the literal 1
```

* `$(e)` quotes an expression as a pattern; `$[s]` quotes a single slot.
* Quotation **nests**: the holes inside `$(...)` are themselves `$[...]`. A head
  may therefore contain several `$` — `count $(unshift_rec $[X:] $[Y:])` has
  three.
* `$` occurs only left of `=`, i.e. only in a head. So the real split is
  **head = pattern space, body = expression space**. The same construct is
  unmarked on the right: `[n:]` binds in a body, `$[X:]` binds in a key.
* A definition is therefore an **expression**, not a statement form: because `$`
  only ever sits left of `=`, any `$... = ...` is a definition wherever it
  occurs — `print ($[int] = n)` included. Parentheses are only grouping.
* The headless forms differ by what the key is:
  `$[T] = e` is a **cast** (give `e` the type `T`, yield the value);
  `$(pattern) = e` destructures; `$name = e` assigns.
* Patterns never appear in an expression, so there is no anonymous match: to
  dispatch, a table must be named first, then extended or called.

| head | introduces |
| --- | --- |
| `$F = ...` | `F`'s definition (no key) |
| `F $[int] = ...` | one entry at `F`'s key |
| `count $(new_rec) = ...` | one entry at a value-pattern key |

Pattern forms:

| pattern | matches |
| --- | --- |
| `?`  | any **type** — `?` is `Type`, never a value |
| `int` | the type constant `int` — but see 3.1 |
| `1`, `"x"` | the literal, at the slot's type |
| `(t => v)` | a value `v` tagged with its type `t` |
| `$(new_rec)` | a constructor, structurally |
| `$(unshift_rec $[X:] $[Y:])` | an application, binding `X` and `Y` |

### 3.1 Overloaded constants **[?]**

`int` in `F: [?]` position denotes the *type* `int` as a `Type`-valued datum.
`int` in `G: [int]` position denotes *any value of type* `int`.
Resolution is by elaboration against the declared parameter type.

### 3.2 `?` is the type of types

`?` is `Type`. It never matches a value. A bracket is one curried parameter and
its content is `name: type`, with either side elidable:

| form | parameter |
| --- | --- |
| `[int]` | anonymous value of type `int` |
| `[n:]` | named value; type **implied by the declaration** |
| `[n:int]` | named value of type `int` |
| `[?]` | anonymous **type** ("capture type only") |
| `[T: ?]` | named **type** |

So `F: [T: ?] int` takes a type and returns `int`, and in

```
F: [int] string;
$F = [n:] to_string n;
```

the `[n:]` is elaborated to `int` from the declaration — the definition site
need not repeat what the ascription already says.

Likewise `F: [?] string; F $[int] = "int";` is *type* dispatch: `F int` passes
the type `int` as a type argument, not a value of type `int`.

`[=> ?]` **[?]** reads as the anonymous dependent pair — sugar for
`[T: ?] [n:T]`, "a type and a value of it". `(int => 1)` is its introduction
form, and `H 1` wraps `1` as `(int => 1)` before matching.

### 3.3 Products and pairs

```
func: [int] [int] (int, int, int);
func $(1) $(2) = (10, 20, 30);
```

* `(t, t, ...)` is a positional **product type**, and `(e, e, ...)` is a value
  of it. So `,` is a type former and an expression former at once.
* That contrasts with `=>`, which pairs a thing with its label or type:
  `t => v` as a value, and `` `display` => (ctors) `` in a declaration. If it is
  one connective, `=>` is a **labeled pair** everywhere and `( , )` is the
  unlabeled product — which would settle Q9.
* The runtime therefore renders products structurally, with separators
  (presumably `(10, 20, 30)`). So "empty display = structural fold" is no longer
  unprincipled, though products may be intrinsic like `int`. **[?]**

## 4. Application

```
print (F int)   # int
print (G 2)     # two
print (H 1)     # one
```

1. Elaborate the argument into the current node's parameter type.
2. Match it against that node's outgoing edges.
3. Recurse; on no match, take the nearest default.
4. At full arity, return the leaf value.

## 5. Types and display

```
bool: `bool` => (false: `F`; true: `T`);

rec: [T: ?] `` => (
	new_rec: `new_rec`;
	unshift_rec: [T] [rec T] ``;
);
```

* A definition can carry a display too:
  `new_counter: [] `\(id)\(increment)` { ... };` — a displayed constructor or
  function. Its holes reference fields declared in the body (`\(id)`), whereas
  `\(value:int)` declares a field inline. Both forms are confirmed by
  `examples/19-counter.rhy`.
* There are now four tails after `name: {params}`:
  `type` (function type), `` `display` => (ctors) `` (type definition),
  `` `display` { ... } `` (displayed definition / object body), and
  `=> value` (declare and initialise, type inferred).
* Types take parameters with the same bracket syntax as functions, so a type is
  a **curried type constructor**: `rec` takes a type and yields a type, written
  `rec T`. Type application is juxtaposition, exactly like term application.
* A constructor is `name : {param} `display` ;` — a curried function whose
  codomain is implicitly the enclosing type. `unshift_rec` is
  `[T] -> [rec T] -> rec T`.
* Definitions may be recursive (`rec` occurs inside `unshift_rec`'s own
  parameter type), so the former is nominal/inductive, not an abbreviation.
* There are **two** display positions and they mean different things:
  * the **type** display is how the *type as a value* renders (`F int` -> `int`);
  * the **constructor** display is how a *value* of that constructor renders.
  A parameterised type may legitimately have no display (`rec` has `` `` ``);
  that only means the type is not printable, not its values.
* A display literal is a **template**, not a constant: it may mention the
  declaration's parameters. `T` is legal inside a literal because a type has a
  representation of its own — the type display — so the hole is well defined.
* Hole syntax is `\(name[: type])`. The typed form **declares** a field and
  renders it; the bare form **references** a binder already in scope:
  * `left: [reason: T] `\(reason)` — references the parameter;
  * `new_var: `new_var-\(value:int)` — declares `value`;
  * `either: [T: ?] [U: ?] `either-\(T)-\(U)`` — a *type* display referencing
    its type parameters.
  So a template can double as a record schema:

  ```
  new_var: `new_var-\(value:int)-\(assign_value:[int]())` {
      $value = 0;
      ...
  };
  ```

  `new_var` has two fields, `value:int` and `assign_value:[int]()`, declared in
  the template and filled by the body. **[?]** (Q38)
* So display is a quasi-quotation, the text-space twin of `$` in pattern space:
  `$` quotes a term into a pattern, backticks quote text with holes. **[?]**
* The template is the **whole** rendering: `new_point` has two `[int]` fields but
  displays `` `point` ``, so fields are not appended automatically. Rendering is
  not structural by default; what the template omits is never shown.
* Empty `` `` `` renders as **no text** — it stays empty (Q23). So a constructor
  with an empty template contributes nothing; `new_rec` still prints
  `new_rec`.
* Display and `to_string` do **not** overlap. A backtick literal is not a string:
  it renders. `to_string` produces a `string` value and is not total over `?`
  (answer 25).
* The earlier `F: [?] string` is still *more* expressive in one respect — it can
  name types that have no display of their own — but not in the general case.

## 6. Modules

```
#!/bin/rhyme
(n:int) {
   $n = 123;
};
```
```
#!/bin/rhyme
123
```
```
#!/bin/rhyme
"abc"
```

* A module is a file whose first line is `#!/bin/rhyme`; the rest is the body.
* Body is either a bare expression (`123`, `"abc"`) or a block
  `(n:int) { ... }` whose parenthesised head is a **declaration list** (7.3) and
  whose body defines those names.
* `$n = 123` is `$F = [] ""` with the path omitted, so **the omitted path is
  the empty path**: it defines the root of `n`.
* The main module's result is rendered at the terminal:
  `123` -> `123`, `"abc"` -> `"abc"` (quotes kept), `true` -> `T`.

## 7. Definitions and binders

```
F: [int] string;              # ascription: F : int -> string
$F = [n:] to_string n;       # definition: F's body
```

* `:` **ascribes**: `name : type`, never destructures. Destructuring is a
  `$`-pattern binding with the tuple spelled out:
  `$(a:, b:, c:) = func $(1) $(2);` (Q30 answered). `$name =` is the value
  form.
* `(n:int) { $n = 123; }` is then: `n` is annotated `int` in the interface and
  given a value in the body.
* `$` marks the binding being **introduced**: `$F = ...` introduces the name's
  first definition; `F $[int] = ...` introduces one key under an already
  declared name. Either way it is the new part that carries the `$`.
* A bracket is one **argument slot** in every context: a parameter in a
  declaration, a type argument in an application (`rec [T:]`), a sub-pattern in
  a clause. `[]` is the slot-less form.
* The bracket holds a **parameter**: `[n:]` is a named value whose type is
  implied by the declaration, `[n:int]` names it explicitly, `[T: ?]` names a
  *type* parameter, and `[int]` is anonymous. A parameter with a name is a
  binder in the body; `[int]` without a name is a filter.
* A parameter's type comes from the declaration at that position, so `[n:]` is
  elaborated to `int` above. No annotation is needed at the definition site.
* Bodies are expressions. Definition forms seen so far:

  | form | binds / filters |
  | --- | --- |
  | `$F = [] expr` | empty parameter list |
  | `$F = [n:] expr` | one argument, no filter |
  | `$F = [n:] [m:] expr` | two arguments, one bracket each |
  | `F $[int] = expr` | no binding; filters the argument |

* `to_string` converts a value to a **string value**, which is not its display.
  Display literals are not strings, and `to_string` never produces one
  (answer 25).

### 7.1 Clauses and constructor patterns

```
count: [rec [T:]] int;
count $(new_rec) = 0;
count $(unshift_rec $[X:] $[Y:]) = 1 + count (Y);
```

* A function is a set of clauses sharing a name; each key is a pattern at the
  parameter's type. There is no `match` expression, so clauses are top level and
  recursion is by name.
* Keys are `$`-quoted (§3): `$(new_rec)` is the nullary constructor pattern,
  `$(unshift_rec $[X:] $[Y:])` destructures. Without the `$` these would read
  as applications, so the marking is syntactic necessity, not decoration.
* Each bracket in a pattern is one slot and lines up 1:1 with the constructor's
  declaration: `unshift_rec: [T] [rec T]`, hence `X : T` and `Y : rec T`.
  Pattern binders get their types by elaboration, like everything else.
* `[rec [T:]]` is a `rec T` for an **implicit** `T`, inferred from `rec`'s
  declared `[T: ?]`. So `count` is polymorphic without naming a type parameter:
  the same "type implied by position" rule as `[n:]`, one level up. **[?]**
* Since constructors are known, exhaustiveness is checkable — the principled
  alternative to silently falling back to a default.

### 7.2 Pattern binding

```
point: `point` => ( new_point: [int] [int] `point`; );

get_point: point;
$get_point = new_point 10 20;
$(new_point $[X:] $[Y:]) = get_point;
print (X + Y);          # 30
```

* `=` binds a **pattern** to an expression, uniformly. A name binding
  (`$get_point = e`) is the degenerate case; an application pattern
  (`count $(new_rec) = 0`) is a clause. Nothing distinguishes a "clause" from a
  "definition" except whether the pattern applies a name.
* The third line has no head at all: `$(new_point $[X:] $[Y:]) = get_point`
  introduces `X` and `Y` into the enclosing scope. So patterns are **statement
  level**, not confined to clause heads — which corrects §3's "patterns only in
  heads". They are still not expressions: there is no `match` value.
* `:` and `=` are complementary rather than alternative: `get_point: point;`
  ascribes, `$get_point = ...` supplies the value. Which is also why
  `a, b, c: func 1 2;` is awkward (Q30).

### 7.3 Blocks and scope

```
func_1: [int] int;
$func_1 = [var_1:] (n:) {
	$var_1 = 123;
	$n = 123;
};

var_1: int;
$var_1 = 222;
print (func_1 var_1);                   # 123
print (var_1);                          # 222
```

* A block is `(decls) { defs }`: the **parens are a declaration list**, the same
  shape as a module header, and the body supplies values with `$... =`.
  Brackets are curried parameter binders. So a definition can be
  `$name = {bracket binder} (block)`.
* `$var_1 = 123` inside the block does **not** reach the outer `var_1`: the last
  line still prints `222`. So `=` introduces a scope-relative binding — global
  at top level, local inside a block — and shadowing is lexical.
* The example cannot say which of `[var_1:]` and `(n:)` carries the argument, nor
  what the block returns, because every value is `123` (Q34–Q35).

### 7.4 Shapes and bodies: `E { ... }`

`{ }` is always juxtaposed with an expression on its left, and that expression
says what the body returns. It is not a scope block; it is a **shape** being
filled.

| left expression | body returns |
| --- | --- |
| `()` | unit — the empty record |
| `(res:)` | a one-field record, collapsing to `res` |
| `[x:] (res:)` | a function: input `x`, result record `(res:)` |
| `new_var` | an instance of `var` |
| `(n:int)` | a one-field record named `n` (a module's export) |

* So `$replace_and_return_old = [v:] (res:) { ... }` assigns a **function
  value**: brackets are input, the parens are the result shape, braces fill it.
* `name: [in] out;` ascribes. `name: [in] out { ... }` ascribes and defines in one
  step. `$name = [in-names] (out-names) { ... }` does the same in two. That
  resolves the earlier `apply_123:` line: it is the compact form.
* Result names elaborate from the declared result type exactly like parameters:
  `(res:)` against `int`, `()` against `()`, `(x: y: z:)` against
  `(int, int, int)`.
* Inside the braces, filling a declared result slot is `$res = v.value`. Every
  name or pattern target of `=` carries `$`; only projections are bare (§7.5).

### 7.5 Records, projection, mutation

```
var: `var` => new_var: `new_var-\(value:int)-\(assign_value:[int]())` {
	$value = 0;
	$assign_value = [x:] () { $value = x };
};
```

* A constructor with a body builds a **mutable record**. Its fields are the
  template's holes; its body supplies their values.
* `.` projects: `v.value`, `v.assign_value`. Applying a projected function is a
  method call: `v.assign_value 123`.
* `=` on a projection assigns: `V1.value = 1000`.
* That gives two lvalue forms and no third: `$target = e` where the target is a
  name or a pattern, and `path.field = e` where the target is a projection. The
  dot path takes no `$` because it is an *expression*, not a pattern; `:`
  targets never take `$` at all. So the head grammar is: `:` declares bare,
  `$... =` assigns marked, `expr.field =` mutates through a path.
* The nested `[x:] () { $value = x }` closes over the instance's `value`, so the
  field and the closure share one cell. Each `new_var` therefore gets its own:
  the first `replace_and_return_old V1` reads `1000` and writes `123`, the second
  reads `123`.
* A constructor with no parameters is a value (`$V1 = new_var`), not a call.`

## 8. Open questions

1. **Defaults vs. currying.** The root default has type `r`, but the root's type is
   `t1 -> r`. With arity 1 they coincide; with arity 2 a miss at depth 1 cannot
   return `""` and still be `bool -> string`. Per-node default? Leaf-only default?
2. **Commit vs. backtrack.** Because `F 1` is observable, the trie must pick a node
   at depth 1 without seeing arg 2. So `F [int] [bool]` + `F [?] [string]` cannot
   backtrack on `F 1 "x"` unless the closure carries *all* viable nodes. Which?
3. **Ordering.** First-match in source order, or most-specific-wins, evaluated
   per node? (Locally different answers are possible.)
4. **Rules at depth < arity.** Legal if the value has the residual function type?
5. **Ground vs. binding keys.** Are `?` keys allowed (unification, relations), or
   only literals and wildcards (dispatch)?
6. **Missing keys.** `G 3` yields `""` silently. Is the default semantic, or sugar
   for an error handler with a strict mode?
7. **Arity 0.** `[]` alone — a thunk? A constant?
8. Builtins (`print`, `int`, `string`) vs. library.

## 9. Questions raised by types / display / modules

9. **`=>` is doing three jobs.** `bool: ... => (...)`, `(int => 1)` as a typed
   value, and `[=> ?]` as a domain. One connective ("lhs yields rhs") or three
   overloaded ones? If one, what is its type?
10. **Constructors are nullary here.** Can they carry payload types
    (`some: `some` [?]`), i.e. is the type former a GADT/variant rather than an
    enum? If not, `[=> ?]` (a dependent pair) has no declaration form.
11. **Is display required?** What happens to a type without a backtick literal —
    compile error, fallback to its name, or unrenderable? Exhaustive display
    would be a nice guarantee: `print` only accepts values the main module can show.
12. **Is display recursive?** How does a variant containing a `bool` render —
    via the constructor's literal only, or by threading nested displays
    (`some T`)? And how are backticks/quotes escaped inside a display literal?
13. **`print` vs. boundary rendering.** Turn 1 had `print (F int)`. Now rendering
    is what happens when a module's result hits the terminal. Two mechanisms, or
    is `print` the same projection exposed mid-computation?
14. **What is a module's value?** For `(n:int) { $n = 123; }` — is the result
    `123`, the block's store, or a function awaiting `n`? Correspondingly, is
    `(n:int)` an input signature (script argument), a pattern, or an exported
    interface? Can the caller override the `$n = 123` binding?
15. **Module references.** Not shown: how one module names another (import,
    path, or a default resolution rule). Also, does a non-main module ever
    render, or only the entry point?

## 10. Questions raised by binders

16. **`[]` vs `[n:]`.** If `[]` is a genuine empty binder list, then
    `$G = [] ""` makes `G` a constant, not a function — contradicting
    `G: [int] string`. Leading hypothesis: `[]` means "matches any remaining
    path", i.e. a catch-all, so it is *not* arity 0. Confirm.
17. **Bodies vs. cases.** `$F = [n:] ...` matches every argument, so if
    source order decided, it would shadow `F $[int] = "int"`. Is a body
    always the last branch tried, or is matching by specificity?
18. Is `[n:]` accepted as shorthand only where the declaration supplies a type
    (i.e. does it ever default to `?`)? And is `[T:]` legal, inferring `?`?
19. Are `$[...]` and `$(...)` one form or two? `$[int]` and `$(1)` both read as
    a single argument, so the difference may be "slot" vs "whole expression",
    or merely type vs value.
20. Does `to_string` equal the backtick display and accept any `?`? What is
    `to_string` of a value whose type has no display — error, or fallback?
    Suggested signature if it is generic: `[T: ?] [n:T] string`.
21. Does `$F = ...` *replace* F's store or add an entry (the root)? Can a
    file contain both `$F = [n:] ...` and `F $[int] = ...` without clobbering?
22. Is `[=> ?]` literally sugar for `[T: ?] [n:T]`? If so, is `[T: ?] [n:T]`
    also legal in a *declaration*, and is `(t => v)` the only pair form?
23. Does empty `` `` `` on a constructor mean "render the fields" (structural),
    or "render the constructor's name", or "unprintable"?
24. Can a display template mention the constructor's **fields**, or only its
    type parameters? Can it join or recurse (flattening the tail), or does it
    inevitably nest?
25. What is the hole syntax inside a backtick literal — `$T`, `[T]`, `${T}`?
    Is it the same `$` that quotes patterns?
26. Can a display slot hold a **table** or function instead of a literal?
27. Can a `$`-quoted pattern appear anywhere other than a head — passed to a
    function, bound to a name, returned? If not, no reusable or local match.
28. Are clause sets exhaustiveness-checked, or may they be partial and fall back
    to a default? `count` has no default.
29. Can `$(f x)` quote a general application, or only constructor forms and
    literals? I.e. is `$(...)` a full expression grammar with holes, or a shape
    grammar?
30. Is `:` one operator (bind a pattern to an expression, ascription being the
    case where the RHS is a type) or two (ascription vs destructuring)?
    `get_point: point` is clearly ascription; `a, b, c: func 1 2` is clearly not.
31. Is `=` uniformly "bind pattern to expression", with clauses as application
    patterns? Then `a, b, c` and `$(new_point $[X:] $[Y:])` are statement-level
    bindings, and `$` is needed only where the left side would parse as a call.
32. `new_point` has two fields and displays `` `point` ``, so templates do not
    append fields. Then does a hole refer to a field at all, or only to type
    parameters? And what does an empty template render?
33. `point` displays as `point` at both the type and constructor level, i.e. it
    is opaque. Is that intentional as a way to seal a representation?
34. Which of `[var_1:]` and `(n:)` binds the argument? Both are `int` here, so
    the example is silent. `$var_1 = 1; $n = 2;` would distinguish them.
35. What is a block's value — its last statement, the last declared name, or a
    record of its declarations? `func_1` must return an `int`, which rules out
    the record reading unless a block of one name is special.
36. Is `=` inside a block a rebinding (shadowing) or an assignment to the
    already-declared slot? `222` only proves the *outer* name is untouched.
37. Resolved by the `$res = v.value` fix: every name or pattern target of `=`
    carries `$`, and only projections are bare. Open: may the projection target
    be an arbitrary path (`(f x).field = v`), and is `$V1.value = 1000` an
    error?
38. Does `\(name:type)` *declare* a field, or interpolate a variable that must
    already exist? `new_var` defines both, so either reading fits.
39. Is each `new_var` a fresh cell, or do instances share `value`? The two prints
    prove per-instance behaviour for one `V1` only.
40. Is `name: [in] out { body }` equivalent to `name: [in] out;` plus
    `$name = [x:] (res:) { body }`, or does the one-step form mean something
    else?
41. Constructor-as-value (`$V1 = new_var`) vs constructor-as-function
    (`new_point 10 20`): is a nullary constructor a record or a thunk?

## 11. Surface grammar (draft)

Derived only from the examples so far. `{ x }` = zero or more, `[ x ]` =
optional, `,` = concatenation. Where this sketch and the parser (§13) disagree,
the parser wins.

```
module      = "#!/bin/rhyme" , body ;
body        = expr | block ;

block       = "(" , [ param , { "," , param } ] , ")" ,
              "{" , { stmt } , "}" , ";" ;

stmt        = ascription | definition | expr , ";" ;
ascription  = name , ":" , signature , ";" ;
signature   = { param } , type                                (* function type *)
            | { param } , display , "=>" , "(" , { ctor } , ")" ;  (* type def *)
definition  = head , "=" , rhs , ";" ;
defn        = "$" , ( name | key , { key } ) , "=" , rhs ;  (* an expression too *)

head        = "$" , name                                       (* introduces name *)
            | name , key , { key } ;                           (* introduces one key *)

key         = "$" , "[" , [ pattern ] , "]"                    (* type-level *)
            | "$" , "(" , expr , ")" ;                         (* value-level *)

rhs         = { "[" , [ param ] , "]" } , expr ;               (* binders, then body *)

type        = typeAtom , { typeAtom } ;                        (* application *)
typeAtom    = "?" | name | "(" , type , ")" ;

param       = "[" , ( name , ":" , [ type ]                    (* named, maybe implied *)
                    | type ) , "]" ;                           (* anonymous, typed *)

ctor        = name , ":" , { param } , display , ";" ;
display     = "`" , { char } , "`" ;                           (* may be empty *)
```

Holes this makes explicit:

1. `signature` shares the prefix `name : { param }` between a function type and
   a type definition; they diverge on whether a display literal follows, so the
   grammar is LL(1) but the two are one production with two tails.
2. `[=> ?]` does **not** fit `param`: its content is a type containing `=>`, so
   `=>` has to be a type former (`t => v`), not just declaration punctuation.
   Same conclusion as Q9, now forced by the grammar.
3. `expr` is barely constrained: atoms, juxtaposition for application, infix
   `=>` for typed values, `.` projection and `+`. A `$... = ...` is an
   expression as well, so `print ($[int] = n)` parses.
4. `rhs` reads `[]` as one unit slot. Arity 0 is written with no brackets at
   all.

## 12. Answers from the author

1. Keys are always `$`-quoted, one per slot: `func $(1) $(2) = ...`.
2. Slot rule: a **type** slot (declared `?`) takes `$[typeExpr]`; a **value**
   slot takes `$[name:]` to bind or `$(expr)` to match a value.
3. ~~`$G = [] ""`~~ — superseded by the arity rule (answer 18). Against
   `G: [int] string` the body must be `$G = [x:] ""`; `[]` is a unit slot, not
   zero.
4. Specificity and source order both matter. `$F = body` assigns the whole
   object; `F $[int] = ...` assigns part of it.
5. A `$`-assignment target must already be declared (`x: T;` before `$x = v`).
   Declarations have no default value and must be assigned before they are read.
6. Every construction gets fresh state; `var_id` is a module-level counter.
7. `:` is ascription only; destructuring is `$(a:, b:, c:) = ...`.
8. `=>` has three shapes: labeled pair (non-literal LHS), definition (literal
   LHS), unary prefix (no LHS, as in `[=> ?]`).
9. An empty display renders no text.
10. Printing is a **directive**: `\print (e);` writes `e` to the screen (strings
    bare). `to_string` returns a display string. There is no `print` function.
11. A headless `$[T] = e` in expression position is a **cast**: it gives `e`
    the type `T` and yields the value.
12. Display holes: `\(name)` references a binder; `\(name:type)` declares one.
13. `[]` is one parameter of type **unit**, so `f: [];` is called `f ()`.
    Arity 0 (no brackets at all, as in `get_point: point`) is different. An
    elided result is **deduced** from the body; write `()` for unit. (Superseded
    by §17; the old “elided = unit” rule is retired.) Binders in a declaration
    (`[n:]`) are placeholders whose types are deduced from the definition.
14. A cast is **unification**: `$[T] = e` needs the static type of `e` to unify
    with `T`; an unknown `?` does not, so it is a compile error.
    `$(T => ?) = e` is the runtime-checked form — accepted, may fail at run
    time.
15. A definition in expression position yields `v`.
16. Constructors may have parameters *and* a body. Template holes declare
    fields; the body only assigns them.
17. A whole-object body is **required**: `$F = ...` must exist. It is the
    fallback at any depth, including after a partial match, so a miss never
    fails at run time. Keys only refine it; a definition with keys but no body
    is a compile error (`$H has not been assigned`). (`examples/18-miss.rhy`)
18. A body must bind the declared arity **exactly**, one bracket per slot. `[]`
    is one unit slot (arity 1), not zero; arity 0 is written with no brackets at
    all. To ignore an argument you still name it (`[m:]`) and leave it unused.
19. Keys are **full depth**: every key consumes all declared parameters. A slot
    you do not care about is bound as `$[X:]` and left unused; there is no
    `$(?)` wildcard (`?` is only the value side of a typed pair).
20. A declaration made only of placeholders must be resolved by a definition in
    the same module; it cannot stand alone.
21. `name: => value` declares the name *and* initialises it, with the type
    inferred. `:` still introduces the name and `$name = value` still requires
    it to exist already, so answer 7 stands: ascription is `name: type`,
    initialisation has its own arrow.
22. The display template is the **public interface**: a field declared in the
    body but omitted from the template is hidden (`num` in `new_counter`).
23. Overlapping keys are allowed only if their **overlap is itself a key**.
    `F $(1) $[Y:]` and `F $[X:] $(1)` overlap at `(1, 1)`, so `F $(1) $(1)` must
    exist; without it the compiler rejects the program as ambiguous. This
    supersedes "ties are errors": a tie is just a missing intersection key.
    (`examples/21-keys-disambiguate.rhy`)
24. There are **no arithmetic operators**. `+` and friends do not exist; a
    program using one is rejected. Arithmetic, if needed, is a table
    (`succ` in `examples/19`).
25. `to_string` is **not** the display. Display literals are not strings: they
    render. `to_string` produces a `string` value and is not total over `?`.
26. Escaping in a template: a backslash escapes the next character, so `\\` is a
    backslash, `` \` `` a backtick, and `\\(` literal text rather than a hole.
    (`examples/22-escapes.rhy`)
27. A bare `\(name)` must resolve to a declared binder — a type parameter, a
    constructor parameter, or a declaration in the constructor's body. Otherwise
    it is a compile error (`test/reject/unresolved-hole.rhy`).
28. Modules are single-file for now: no import syntax, and only the main module
    renders.
29. Patterns are syntax only; a pattern is never a value.

## 13. Parser

`src/rhyme.mjs` is the executable grammar (Node, no dependencies).
`examples/*.rhy` and `test/reject/*.rhy` are the corpus; `test/run.mjs` parses
them all:

```
node test/run.mjs                   # 18 cases: 16 valid, 2 must reject
node test/run.mjs --dump            # with ASTs
node test/run.mjs --only NAME --dump
node bin/rhyme.mjs --dump f.rhyme
```

Two rules the parser has to enforce, both settled by the answers:

1. **Keys are always `$`-quoted, one per slot.** `func $(1) $(2) = ...` parses;
   `func 1 2 = ...` is a syntax error, kept as a `test/reject` case so it cannot
   silently regress.
2. **A bare expression head must be a projection.** `V1.value = 1000` parses;
   any other non-`$` head is an error. So `=` assigns only to a `$`-name, a
   `$`-pattern, or a field path.

Also enforced: `:` is ascription only, so destructuring must be written
`$(a:, b:, c:) = ...`. Display holes are parsed into `{name, type}`; a bare
hole is not yet checked against the binders in scope.

## 14. Still open

None *in this list*. §14 only ever held questions this design pass collided with;
the gaps that were never asked are in §15, which supersedes the "none" above.

### Settled

* A cast is **unification**: `$[T] = e` needs the static type of `e` to unify
  with `T`, so an unknown `?` is a compile error. `$(T => ?) = e` is the
  runtime-checked form: accepted, may fail at run time.
  (`examples/17-cast-unification.rhy`)
* A definition in expression position yields `v`.
* Constructors may have parameters *and* a body. Template holes declare fields;
  the body only assigns them.
* **Miss behaviour.** A whole-object body is mandatory and is the fallback at any
  depth, including after a partial match. Keys only refine it; a definition with
  keys but no body is a compile error. (`examples/18-miss.rhy`)
* **Arity.** A body binds exactly the declared number of parameters, one bracket
  per slot. `[]` is one unit slot (called `f ()`); arity 0 is no brackets at all.
  (`examples/01`, `02`, `06` updated accordingly.)
* **Visibility.** The display template is the public interface; a field omitted
  from it is hidden. (`num` in `examples/19-counter.rhy`.)
* **Key depth.** Keys are full depth; ignore a slot with `$[X:]`. `$(?)` is
  rejected (`test/reject/wildcard-key.rhy`).
* **Placeholders.** A placeholder-only declaration cannot stand alone; a
  definition in the same module must resolve it.
* **Initialisation.** `name: => value` declares and initialises in one step, with
  the type inferred; `$name = value` still requires a prior declaration.
  (`examples/19-counter.rhy`)
* **Key conflicts.** Overlapping keys are allowed only if the overlap is itself a
  key; the compiler rejects the program otherwise. At run time the unique
  smallest matching key wins, and the body is the floor and exempt from the
  rule. Source order is irrelevant. (`examples/21-keys-disambiguate.rhy`)
* **`[=> ?]`** is one packed argument (arity 1), not sugar for two.
* **Result shapes** bind one field per component: `(x: y: z:)` against
  `(int, int, int)`.
* **Displays** are literal templates only; no computed table or function.
* **Operators.** Precedence, tightest first: `f x` (application), `!`,
  `< <= > >=`, `== !=`, `&&`, `||`. There is no arithmetic; `+` is rejected
  (`test/reject/no-arithmetic.rhy`). (`examples/20-operators.rhy`,
  `examples/22-escapes.rhy`)
* **`to_string` vs display.** They are different pipelines: `to_string` yields a
  `string` value, display renders a template. Display literals are not strings.
* **Holes.** A bare `\(name)` must resolve to a declared binder; a typed
  `\(name:type)` declares one. Backslash escapes the next character.
* **Scope.** Modules are single-file; only the main module renders. Patterns are
  syntax and never values.

## 15. Open questions (second pass)

These were never asked, because the earlier list only covered things we had
already touched. Refer to them as O1, O2, … and take them one at a time; when one
is settled, record the answer in §12 and mark it closed here.

### Type system

**O1. `?` — unresolved placeholder: what resolves it, and what is it when
nothing does?** See the worked analysis in the reply: in `[T: ?]` the
placeholder is forced to a kind by T's use as a type; in `[=> ?]` it is solved by
the pair's first component; in `F: [int] ?` nothing resolves it. Is the
unresolved case `Type` (types are values), a dynamic value type (`any`), or a
separate token? Note that `F: [int] ?;` with no definition is rejected twice
over — by answer 20 (placeholders resolve in-module) and answer 17 (a body is
required) — so the cast example is a fragment, not a module.

**Evidence (example 23).** `F: [string] ?` returns `bool`/`int`/`void` — *types* —
and `F "bool"` is used *as a type*, so there `?` is unambiguously `Type`. But
`H: => [string] ?` returns `0`/`""`/`false` — *values* of different types. The
`=>` on H is the only syntactic difference. So either `?` is `Type` and `=>`
marks a packed result (recommended), or `?` is context-dependent.

**O2. Equality.** `== != < >` — which types? Structural or identity for
constructors and records? Records hold closures, so structural equality needs a
rule. Is equality builtin, or a table per type?

**O3. `bool` and the logical operators.** `bool` is user-defined, yet `&&`, `||`,
`!` must know it. Builtins over a primitive bool, tables, or special forms? Do
`&&`/`||` short-circuit? (Expressions can have side effects.)

**O4. Implicit type arguments.** `count: [rec [T:]] int` infers T from its
argument. What is `count new_rec`, where T is unconstrained — default, `?`, or an
error? Can `id: [T: ?] [T] T` be written?

**O5. Existential unpacking.** Can `$(t => v) = pair` bind a *type* `t` into
scope, and can that `t` then be used as a type?

**O6. Pair types.** Is `(int => 1)`'s type `int => int` (a specific labeled
pair), or always the existential `∃T.T`? Can `[int => string]` be a parameter
type?

### Objects and values

**O7. Displaying functions.** `new_var` exposes `assign_value`; `new_counter`
exposes `increment`. If the template renders, printing either needs a function
display. What happens: `<fn>`, a compile error, or may templates omit
non-renderable members?

**O8. The type of a standalone object.** `new_counter ()` produces a record whose
type has no written name, so it cannot be a parameter. Is that type anonymous and
structural, or does `new_counter` also name a type? This decides whether objects
can be passed around.

**O9. Reference vs value.** Is a record passed by reference? Does `$V2 = V1`
alias? `replace_and_return_old V1` mutates through `v`, but a shallow copy that
shares the cell would look identical.

**O10. Nullary constructors.** Is `new_var` re-run on every reference (fresh
instance, as your old `var_id` counter showed) or evaluated once? Can a nullary
constructor be referred to without constructing?

**O11. Visibility enforcement.** The template is the interface. Are hidden fields
(`num`) inaccessible for both read and write, and is a violation a compile error?

### Output

**O12. `print` vs display.** `print (F int)` is commented `# int` and
`print (G 2)` `# two` — no quotes — while a module returning `"abc"` renders it
*with* quotes (answer: strings get double quotes). Does `print` write raw string
contents while boundary display adds quotes, or are those comments wrong? Same
question for unit, tuples and functions.

**O13. Builtin displays.** Exact text for int, unit and products. Can builtin
displays be overridden? `bool` redefining `F`/`T` suggests user types can; can
`int`?

**O14. `to_string`.** Which types does it accept? For a user type, does it yield
the type name, the constructor name, or something else? Is it fixed or extensible
per type (a table)?

**O15. Module boundary.** A statement-bodied module ends in unit — does it render
`()` after its prints? What does a multi-field module shape `(a: b:)` render?

**O16. `print` shape.** One argument only? Does it return unit? Is it
newline-terminated?

### Mechanics

**O17. Negative literals.** There is no `-`, so `-1` cannot be written. Intended,
or are negative literals (a sign, not an operator) needed?

**O18. Evaluation order and failure.** Left-to-right for arguments and tuples?
Is a runtime failure fatal with no recovery? (`$(int => ?)` can fail.)

### Known corpus gaps

* `02` needs `rec`; `18` needs `bool`. With single-file modules neither runs as
  written — either inline the dependency or stop calling every file a module.
* `19`'s `succ` saturates past its keys. Arithmetic is gone (answer 24), so a
  general counter is not expressible; confirm that is acceptable.

### Raised by example 23

`examples/23-questionmark.rhy` shows types and values in one language:

* `?` is used both as a kind (`F` returns types) and as a packed payload (`H`
  returns values) — see O1.
* `func_1: [F "bool"] string;` computes a parameter type by *running* `F`, and
  `F "bool"` is `bool`.

**O19. Type positions evaluate terms.** If a type is computed by a table, then
checking a parameter type may run arbitrary code. Is type-level evaluation
unrestricted (undecidable, possibly effectful), or restricted to a pure,
terminating subset? This is the difference between a dependently typed language
and a checker that can diverge on a type annotation.

**O20. Builtin inventory.** Example 23 uses, without declaring them: types
`int float bool string void array dict`; the value `false`; functions
`print_int print_float print_bool`; and float literals (`23.4`). Which are
builtin? In particular:
* Is `bool` builtin, making `bool: … => (false: …; true: …)` a *display
  override* rather than a new type?
* Is `void` both a type and its sole value? (`$H = [n:] void` returns `void` as
  a default result.)

**O21. Higher-kinded type values.** `key: [[?]?]?;` accepts a `Type -> Type`
constructor, and `array`/`dict` are used that way. Is the type language
higher-kinded, and how is a kind other than `?` written?

**O22. Type binders in keys.** `key $[dict $[k:]] = k;` binds a *type* `k` in a
pattern and returns it from the body. `examples/26` shows the same for `fmap`:
`$[T:] $[U:]` bind the caller's type arguments and the recursive call passes them
on. Does that unpack an existential (see O5), and may a body return a type as an
ordinary value?

**O23. `: =>` has two readings.** `C1: => new_counter ();` (19) initialises a
value; `H: => [string] ?;` (23) reads like a *packed-result signature*. One
syntax, two meanings. Is `=>` a mode marker ("packed") that prefixes a slot or a
signature, with initialisation a separate production?

### Raised while auditing (O24–O38)

**O24. Namespaces and local types.** Types are values, so `bool` is both a type
*and* a value. Is there one namespace? Does `X: … => …` bind `X` as a value (the
type itself)? Can a table be named `int`? And can a type declared inside a block
(15's `bool:`) escape that block?

**O25. The universe.** `?` is used as a type. What is `?`'s own type: `? : ?`
(impredicative), or a hierarchy with kind syntax? With type-level evaluation,
`? : ?` puts the checker on a path to divergence; a hierarchy needs a way to
*write* kinds (O21).

**O26. Type equality.** Is `F "bool"` the *same type* as `bool`? Compared by
evaluation (normalisation) or syntactically? If evaluation is effectful (O19),
type equality could change between two checks.

**O27. Runtime type tags.** `$(int => n:)` tests a value's type at run time. Is
every value tagged, or is packing done only at `=>` boundaries — `G 123` becoming
`(int => 123)` at the call?

**O28. Where packing happens.** Which boundaries auto-pack: arguments to a
`[=> ?]` parameter, returns from a `=>` signature, casts (`$[T] = e`)? And does
a `?`-returning function return a *type* or a packed value (O1)?

**O29. Overlap checking.** What exactly is verified for disambiguation, and is it
decidable when a key contains a computed type (e.g. `$[F "bool"]`)? Are computed
types allowed in keys at all?

**O30. Key binder scope.** Are `$[X:]` binders visible only in the body? Can a
key shadow a field, a parameter, or another key's binder?

**O31. Initialisation order.** Are top-level definitions hoisted (so mutual
recursion works) or evaluated top-to-bottom (so order matters for side effects,
as in `$counter_id = succ counter_id`)? Can a definition use a name declared
later?

**O32. Module head: input or result?** `(n:int) { $n = 123; }` reads equally as
an input supplied by the runtime or a result declaration filled by the body.
Which is it? If input, where do the values come from?

**O33. Statement separators.** Is `;` a required separator, optional at the end,
or can a newline separate statements? Newlines are currently ignored entirely.

**O34. Floats.** IEEE? Comparable with `<`? How is a float formatted by the
builtin display — precision, exponent, `NaN`?

**O35. `void` vs `()`.** `void` looks like both a type and its own value; `()` is
unit. Same type and value, or two different things?

**O36. Mutability.** Which bindings are assignable: globals, parameters, locals,
fields, pattern binders, type bindings? Can the same name be assigned twice?

**O37. The static error list.** Is every error a rejection, with no warnings? Is
there a fixed list the checker guarantees (type mismatch, arity, overlap, unbound
name, hidden field, unresolved hole, missing body, failed unification)?

**O38. Purity at type level.** Can a type-level table print or mutate? If types
are evaluated, is the order of evaluation during checking observable?

## 16. Evaluator

`src/eval.mjs` executes syntax v4 (§19) dynamically. There is no static checker;
type checks are runtime checks, and type variables are solved from the values
that actually arrive.

* Values, mutable environments, top-to-bottom initialisation.
* Types: `?` is the top/dynamic type; `@T`/`@?` are (named/anonymous) type
  variables; concrete and applied types are first-class values.
* Modules are bare statement lists with no `self`. Results go to output sinks
  (`$stdout`, shebang `--output name:path`), rendered at the end.
* Outputs default to `?`; an ascription (`sum: int;`) narrows a sink. Strings
  are quoted in display form.
* Declarations: values, values with defaults, functions, type/constructor
  constants. Display-literal names are immutable.
* Defaults: named braces fill omitted parameters; non-parameterised defaults are
  shared, parameterised defaults are fresh per omission.
* Bodies: `... expr` and `... r: { … }`; `=> rhs` without `...` is a default.
* Patterns: slots capture (`$[X: T]`, `$[X: @T]`, `$[X: ?]`), typed slots unpack
  only on `?` parameters (`$[X: T => ?]`), expression patterns match value
  shapes (`$(1)`, `$(ctor …)`, `$(type_1)`). `$(T => v)` is gone.
* Tables: keys and `${…}` groups; highest specificity wins; the whole-object body
  is the fallback. Generic dispatch uses value shapes; dynamic dispatch uses `?`.
* Records are by reference; display templates define the public fields.
* Builtins: `to_string`, `print_int`/`print_float`/`print_bool` (return strings),
  `add_int`/`add` (curried).

Not implemented: a static checker, full type inference (holes are solved from
runtime values), and all existential/type-level machinery. Removed forms are
parse or runtime errors (`test/reject/`, examples 33–37).

## 17. Syntax v2 (superseded)

Proposal locked. When it lands, every "removed" form is a parse error.

### Modules

A module is a bare statement list; the paren head is gone. A module has an
implicit `self`, and a directive may rename it.

```
#!/bin/rhyme
$self = 123;
```

### Bodies and `{ }`

`{ }` has three roles, chosen by position:

| position | role | rules |
| --- | --- | --- |
| after `=>`, after `=`, after `[x:]` | **body** | params in scope by name; `self` pre-bound; result is the final `self` |
| after an expression | **application** | `$param = expr` entries, evaluated in order, each seeing earlier ones; binds all remaining parameters; fires at `}`; may follow a partial; at most one brace |
| `${ … }` in a clause head | **key group** | `pattern = parameterName`; order-free; omitted = unconstrained |

### `self` and directives

* `self` is an ordinary variable, pre-bound in every body and module:

  * `self` reads it; `$self = e` replaces it; `$self.f = e` sets a field;
  * record result: pre-created with declared fields, unset until assigned;
    scalar result: unset; unit result: `()`;
  * rebinding within one brace is allowed, last write wins.

A directive renames the current body's `self`:

```
new_var: [] var => {
    \self (inst);
    $inst.value = 0;
    $inst.assign_value = [x:] { $self = (); $inst.value = x };
};
```

After `\self (inst)`, `$inst` is this body's result variable and `self` refers
outward. Valid in modules too.

### Directives

* `\self (name);` — rename this body’s `self` (once per body, first statement).
* `\print (expr);` — write `expr` to the screen; a statement, not a function.

### Declarations

```
f: [a: int] [b: int] R => { … };   # declare + body
f: [a: int] [b: int] R;            # declare only
```

### Calls

```
f 1 2                          # positional, still valid
add_int 1000                   # partial, still valid
add_int 1000 { $b = 2 }       # partial, finished by a brace
f { $a = 1; $b = 2 }         # named
point { $first = 1; $second = 2 }
```

No chained braces.

### Keys

```
f $[int] $(1) = v                    # positional, kept
f ${ $[int] = A; $(1) = B } = v    # group; names are parameter names
```

Positional keys and groups may be mixed in one clause. A clause containing any
group entry is matched **by parameter name**: plain keys fill parameters in
order, named keys by name, and unmentioned parameters are unconstrained (but
still bound for the body).

### Types

```
counter: [id: int] [increment: []] `\(id)\(increment)`;      # record type
point: `point` => ( new_point: [first: int] [second: int] `\(first)\(second)` );  # variant
```

A record type gets an implicit constructor named after the type; its display
template is the public interface.

### Deduction

Omitted **type** parameters in an application brace are solved by unifying the
supplied arguments' types with the declared parameter types. Value parameters
are never deduced; unsolved or ambiguous is an error.

```
fmap { $arg = R; $func = add_int 1000 }      # C=rec, T=int, U=int
```

Implemented: the evaluator unifies each declared parameter type against the
runtime type of the supplied argument, binds the type parameters, and fills the
omitted ones. `add_int 1000` contributes `[int] int`, which pins `T` and `U`;
`R`’s type contributes `C`.

### Defaults

* A declaration’s result may be omitted: `f: [a: int];` means the result is
  **deduced** from the body. `()` is explicit unit, and `?` is still a type
  value. (This supersedes answer 13.)
* Modules take **no inputs** in v2; CLI arguments are a later feature.
* `\self` is allowed **once per body, as the first statement**.

### Removed

1. result shapes `(res:)` / `(n:)`;
2. declaration bodies without `=>`;
3. constructor-with-body;
4. `name: => value` — the `=>` tail now parses only as a packed signature
   (`H: => [string] ?;`); the initialiser meaning is gone;
5. full-depth group keys (omitted = unconstrained).

All but (4) are parser errors; (4) is accepted only as a packed signature.

### Implemented

v2 is recorded here only for history; `src/` now implements v4 (§19). `test/reject/` keeps one case per removed form.

### Migration of the corpus

| examples | change |
| --- | --- |
| 01–06, 13, 17, 18, 20–23, 25, 26 | unchanged |
| 07 | `$func_1 = [var_1:] (n:) { … }` → `func_1: [var_1: int] int => { $var_1 = 123; $self = 123; }` |
| 08 | drop `()` shapes, add `=>`: `$assign_value = [n:] { $value = n }`, `apply_123: [F: [int]()] () => { F 123; }` |
| 09 | `var` becomes a record type plus `new_var` with `\self (inst)`; `(res:)` → `$self = v.value` |
| 10, 11 | `123` / `"abc"` → `$self = 123;` / `$self = "abc";` |
| 12 | `(n:int) { $n = 123; }` → `$self = 123;` |
| 14 | head removed; `n` needs a declaration or an input mechanism (**open**) |
| 15 | head removed; rest unchanged |
| 16 | `(m:)` result placeholder is gone; needs a “deduced result” spelling (**open**) |
| 19, 24 | constructor-with-body → record type + `new_counter`; `C1: => …` → `$C1 = …`; `get_num` shape → `int => { $self = num; }` |
| 24 | also drop the module head |

Both former open items are settled by the defaults above: `f: [a: int];`
deduces the result, and modules have no inputs (example 14 declares and assigns
`n` locally).

## 18. Syntax v3 (superseded)

v3 removes the v2 statement forms and makes the corpus depend only on the
declaration and `=` machinery. Everything below is implemented and covered by
`examples/` and `test/reject/`.

### Modules

A module is a bare statement list. There is **no `self`**, and the module has no
implicit result. Results are written to named **outputs**:

```
#!/bin/rhyme --output sum:out/sum.txt --output count:out/count.txt
$stdout = 123;
$sum = add_int 1 2;
```

* `stdout` is predefined; shebang `--output name:path` declares more (repeatable,
  split at the first `:`).
* Every write to an output appends to its log. When the module finishes, each
  log is rendered in **display form** and written in order: stdout to the
  terminal, a file sink to its path. Strings therefore keep their quotes.
* An output never assigned writes nothing.
* Outputs are ordinary readable names: `sum` can be read back in the module;
  `$sum = …` writes it.

### Declarations

```
value: int;                             # declare a value, no parameters
func: [];                               # one unit parameter, deduced result
assign_value: [n: int] ();              # typed parameter, unit result
auto_function: [n: ?] int;              # `?` is the type of types
stdout: => ?;                           # the one dynamic declaration
```

* Every parameter specifies its type. `[m:]` is gone; `[]` is one unit parameter,
  and arity 0 is written with no brackets at all (`get_point: point`).
* A bare `name: T;` declares a value. A bracket list makes it a function, and
  the optional result may be elided (deduced from the body).
* `name: => ?;` declares a dynamic value (used for `stdout`); no other top-level
  `=> T` ascription exists. (A parameter `[=> T]` is the separate unary-pair form.)

### Bodies

A body is one of two shapes, and a bare `{ }` is never one of them:

```
f: [n: int] int => ... n;               # expression body
f: [n: int] int => ... r: {             # named-result body
    $r = n;
};
```

* `... expr` returns `expr`; the declaration supplies the parameters.
* `... r: { … }` names the result. `r` is pre-initialised from the declared
  result type: a fresh record (fields unset), a single-constructor value, or
  `()`. The body must assign it; the last value wins.
* Inside a named-result body, `$name = v` assigns the nearest binding, and
  `expr.field = v` mutates through a projection.
* `$f = g` where `f` is a declared function and `g` is callable makes `g` the
  **fallback** for `f`; later `f $key = …` clauses shadow it for matching keys,
  and `g` itself is untouched. `$f = ... body` is the ordinary fallback body.
* A clause body `f $keys = ... body` sees the parameters the clause did not
  match, and nothing else.

### Contextual `...` lambdas

The only lambda form in expression position is `...`:

```
G: [F: [arg_1: int] [arg_2: int] string] bool => ... true;
G (... to_string (add_int arg_1 arg_2));
```

* It is legal **only as a direct call argument**.
* The expected type comes from the callee's declared parameter (a direct call
  argument's type only; results never propagate).
* The parameter names of that type are bound in the lambda's body; anonymous
  parameters are silently unbound.

### Tables and keys

Unchanged from v2: keys are `$`-quoted (`$[int]`, `$(1)`), groups are
`${ pattern = name; }`, dispatch prefers specificity and reports ties, and the
whole-object body is the fallback. Keys may use a bare binder in pattern space
(`$[X:]`); declaration parameters may not.

### Removed in v3

| removed | replacement | reject case |
| --- | --- | --- |
| `\self (x);` | `... x: { … }` | `directive-self` |
| `\print (e);` | `$stdout = e;` | `directive-print` |
| `=> { }` bare body | `... r: { }` | `bare-block-body` |
| `$f = [m:] body` | name parameters in the declaration, then `... body` | `body-binders` |
| `f: [m:] T;` | `f: [m: ?] T;` | `untyped-param` |
| `f: => [T] R;` packed | `f: [T] R;` | `packed-signature` |
| `f: [a] R { … }` without `=>` | `f: [a: A] R => ... r: { }` | `no-arrow-body` |
| `self` / `$self` | outputs (§18) | run-time: not declared |

### Migration of the corpus

All 28 examples are v3. The mechanical changes were: replace `\print (e)` with
`$stdout = (e)`; turn `$f = [names] body` into `$f = ... body` (parameters
come from the declaration); turn `=> { … }` into `... r: { … $r = … }`; replace
`\self (inst)` / `$self` with a named result (`... inst: { … }`) and the declared
result type; replace `[m:]`/`[n:]` declarations with typed named parameters; and
rewrite packed signatures as ordinary function declarations. Examples 10–12 now
use `$stdout` instead of `self`; 09/19/24 build methods from ordinary functions
(partial application captures the instance) because bare block lambdas are gone.

## 19. Syntax v4 (current)

v4 replaces the `?`-universe and packed pairs with a **top type**, **inference
variables**, **typed slots**, and **shape patterns**. `src/` implements the
runtime approximation of this section; there is still no static checker.

### Types

| form | meaning |
| --- | --- |
| `?` | top / dynamic type: any value, no static type |
| `@T` | named type variable (inferred, or an explicit type argument) |
| `@?` | anonymous type variable (fresh per occurrence) |
| `int`, `string`, … | builtin types |
| `rec int`, `@C @T` | type application (juxtaposition) |
| `[T] U`, `[@T] @U` | function type |
| `()` | unit type; `[]` is a unit *parameter* in a declaration |

* `?` is a value type, not the universe. It can hold any value, including a type
  value; a `?` value is never usable in a type position (dependent types are
  gone).
* `@T` is solved from the value that arrives. For a **module value** the first
  assignment fixes it, later writes must match; for a **function parameter** it
  is fresh per call and opaque in the body. `@?` is the anonymous form.
* Repeated `@T` in one declaration is the same variable; `@?` never links.
* Type positions are syntactic: `[F "bool"]` is not a type; `F "bool"` is a
  runtime value. A plain name in type position must be a type, a type alias, or
  a type constructor.

### Declarations

```
v: int;                         # value, assigned later with $v =
v: int => 0;                    # value with a default
f: [x: int] int;                # function
f: [x: int] int => ... x;       # function with a body
na: [@T] array @T => new_array; # parameterised default (type params only)
g: [@T] [X: @T] @T;             # explicit type parameter + inferred value type
p: [@T] `point-of-\(T)`;        # type constructor (display literal)
```

* A declaration with a **display literal** is a constant: a type or a
  constructor. Constants cannot be `=`-assigned. The constructor-list scope
  decides “constructor”; module/block scope decides “type”. A variant with one
  constructor may omit the parentheses: ``point: `point` => new_point: …``.
* `name: => T` is gone. A dynamic value is `name: ?;`.
* A **bodyless clause** `name $keys;` is `name $keys = ();` and requires a unit
  result.
* Parameter forms: `[X: T]` value of type `T`; `[X: @T]` value whose type is
  inferred; `[X: ?]` dynamic value; `[@T]` a type argument; `[@?]` an anonymous
  type argument.
* A default is used by named braces only. Non-parameterised defaults are
  evaluated once and shared; parameterised defaults are fresh per omission. A
  parameterised default (`=> d` without `...`) may have type parameters only; a
  value-parameter function needs a body (`=> ...`).
* `name: T => d` is also a transparent type alias in type position, carrying the
  default `d` (e.g. `nullable_type_1: type_1 => ctor_1_A`).

### Bodies and definitions

* `$name = e` assigns a declared value; a bare `name = e` is illegal. `<-` is
  gone; `=` is the only binding/assignment token.
* `name $keys = e` defines a clause. `$type_1 = …` / `$ctor = …` are illegal
  because display-literal names are constants.
* Bodies are `... expr` and `... r: { … }`; `=> rhs` without `...` is a default.
* A clause `...` body receives only the parameters its keys did not match.

### Slots and shapes

```
$[T]                 # type argument (matches a type value)
$[@T]                # type argument, bind T
$[@?]                # type argument, discard

$[X: T]              # value slot of concrete T
$[X: @T]             # value slot; bind the value and its type
$[X: ?]              # dynamic value slot, no unpacking
$[X: @?]  /  $[X:]   # anonymous inferred value slot

$[T => ?]            # unpack a ? value as concrete T, no binder
$[X: T => ?]         # unpack a ? value as concrete T, bind X
```

* Unpacking is only legal on a **`?` parameter**, and `T` must be concrete (no
  `@` and no `?`).
* On a `?` parameter a concrete slot without `=>` is illegal; write `$[X: ?]`
  or `$[X: T => ?]`. `$[X: @?]` / `$[X:]` are also illegal on `?`.
* `$[ ]` is invalid.
* `$[point]` is a **type key**: it matches a type value (`shape point`).
  `$[point => ?]` is a **value key**: it unpacks a value whose runtime type is
  `point` (`shape (new_point 1 2)`). They are different registrations.
* Expression patterns are **value shapes**: `$(1)`, `$(ctor $[a:] …)`, and
  `$(type_1)` (a type test). `$(T => v)` is gone.
* Headless narrowing uses a slot: `$[X: int => ?] = G;`.

### Dispatch

* Type-directed dispatch uses a `?` parameter and an unpacking pattern:
  `to_string: [X: ?] string; to_string $[n: int => ?] = …;`
* Shape-directed dispatch uses generic types and value constructors:
  `fmap: [data: @C @T] [func: [@T] @U] (@C @U);` with
  `fmap $(new_rec) …` / `fmap $(unshift_rec …) …`.
* Named braces fill value and type parameters; omitted `@` holes are inferred
  from the supplied values, and a parameter with a default may be omitted.

### Outputs

* `stdout` and shebang `--output name:path` sinks default to `?`; an ascription
  (`sum: int;`, `stdout: ?;`) narrows a sink.
* Writes are a log rendered at the end in display form; strings keep quotes; an
  unassigned output writes nothing.

### Removed in v4

| removed | replacement |
| --- | --- |
| `[=> T]` packed parameter | `[X: ?]` (dynamic) or `[X: @T]` (inferred) |
| `$(T => v)` typed pattern | `$[X: T]` / `$[X: T => ?]` / `$(shape)` |
| `name: => T` dynamic declaration | `name: ?;` |
| `$[T] = e` cast | typed slot / unpacking pattern |
| `F "bool"` in a type position | syntactic types only |
| `(T => v)` packed value, `(=>)` | gone |
| `unit` type name | `()` |
| `?` as the universe / type pattern | `?` is the top; type args use `[@T]` |

### Tests and corpus

`test/run.mjs` parses `examples/` and `test/reject/`; `test/eval.mjs` executes
the runnable examples. Examples 01–16, 19–32, 39–41 run; 17/18, 33–38 and 42 are
deliberate runtime errors; the old dependent-type part of example 23 and the
packed-pair experiments are legacy. `test/reject/` now also locks packed
parameters, typed patterns, dynamic declarations, empty slots, non-concrete
unpacking, and unpack shapes.

Migration from v3: `[T: ?]` → `[@T]`; `[n: ?]` used as a type → `[@T]`;
`[=> ?]` → `[X: ?]`; `$(int => n:)` → `$[n: int => ?]` (on `?`) or
`$[n: int]` (on a concrete parameter); `stdout: => ?` → `stdout: ?`; `unit` →
`()`; fmap-style explicit type arguments become inferred `@C/@T/@U`.
