// Rhyme2 — lexer + parser for the surface grammar in SPEC.md.
// This is deliberately syntax-only: it proves the grammar, not the semantics.

const PUNCT2 = new Set(["=>", "&&", "||", "==", "!=", "<=", ">="]);
const PUNCT1 = new Set("()[]{}:;,.$?!<>@=".split(""));

export function lex(src) {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // tolerate a UTF-8 BOM
  const out = [];
  let i = 0, line = 1, col = 1;
  const n = src.length;

  const adv = (k = 1) => {
    for (let j = 0; j < k; j++) {
      if (src[i] === "\n") { line++; col = 1; } else col++;
      i++;
    }
  };
  const push = (t, v, l = line, c = col) => out.push({ t, v, line: l, col: c });

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(); continue; }
    // line comment, which also swallows the #!/bin/rhyme shebang
    if (c === "#") { while (i < n && src[i] !== "\n") adv(); continue; }

    if (c === '"') {
      const l = line, cc = col; adv();
      let v = "";
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) { v += src[i + 1]; adv(2); }
        else { v += src[i]; adv(); }
      }
      if (i >= n) throw new Error(`unterminated string at ${l}:${cc}`);
      adv();
      push("str", v, l, cc);
      continue;
    }

    if (c === "`") {
      const l = line, cc = col; adv();
      let v = "";
      while (i < n) {
        // backslash escapes the next character inside a template
        if (src[i] === "\\" && i + 1 < n) { v += src[i] + src[i + 1]; adv(2); continue; }
        if (src[i] === "`") break;
        v += src[i]; adv();
      }
      if (i >= n) throw new Error(`unterminated literal at ${l}:${cc}`);
      adv();
      push("lit", v, l, cc);
      continue;
    }

    if (/[0-9]/.test(c)) {
      let v = "";
      while (i < n && /[0-9]/.test(src[i])) { v += src[i]; adv(); }
      if (i < n && src[i] === "." && /[0-9]/.test(src[i + 1] ?? "")) {
        v += "."; adv();
        while (i < n && /[0-9]/.test(src[i])) { v += src[i]; adv(); }
      }
      push("num", v);
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let v = "";
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) { v += src[i]; adv(); }
      push("id", v);
      continue;
    }

    if (src.slice(i, i + 3) === "...") { push("sym", "..."); adv(3); continue; }
    const two = src.slice(i, i + 2);
    if (PUNCT2.has(two)) { push("sym", two); adv(2); continue; }
    if (PUNCT1.has(c)) { push("sym", c); adv(); continue; }

    throw new Error(`unexpected character ${JSON.stringify(c)} at ${line}:${col}`);
  }
  out.push({ t: "eof", v: "<eof>", line, col });
  return out;
}

class Parser {
  constructor(toks) { this.t = toks; this.i = 0; }

  peek(k = 0) { return this.t[this.i + k] ?? this.t[this.t.length - 1]; }
  at(v) { const x = this.peek(); return x.t === "sym" && x.v === v; }
  atAny(...vs) { return vs.some((v) => this.at(v)); }
  atId() { return this.peek().t === "id"; }
  eat(v) { if (this.at(v)) { this.i++; return true; } return false; }

  expect(v) {
    if (!this.eat(v)) this.err(`expected ${JSON.stringify(v)}`);
  }
  expectId() {
    if (!this.atId()) this.err("expected identifier");
    return this.t[this.i++].v;
  }
  expectKind(t, what) {
    if (this.peek().t !== t) this.err(`expected ${what}`);
    return this.t[this.i++].v;
  }
  err(msg) {
    const x = this.peek();
    throw new Error(`${msg} at ${x.line}:${x.col} (got ${x.t} ${JSON.stringify(x.v)})`);
  }

  // ---- top level -------------------------------------------------------

  parseModule() {
    const body = [];
    while (this.peek().t !== "eof") body.push(this.parseStmt());
    return { k: "module", body };
  }

  parseStmt() {
    if (this.at("$")) return this.parseDef();
    if (this.atId() && this.peek(1).t === "sym" && this.peek(1).v === ":") {
      return this.parseAscription();
    }
    if (this.atId() && this.peek(1).t === "sym" && this.peek(1).v === "$") {
      return this.parseDef();
    }

    const e = this.parseExpr(false);
    if (this.at("=")) {
      if (e.k !== "proj") {
        this.err("a definition head must be `$...` keys or a projection path");
      }
      this.nextSym();
      const rhs = this.parseRhs();
      this.eat(";");
      return { k: "defPath", target: e, rhs };
    }
    this.eat(";");
    return { k: "expr", e };
  }

  nextSym() { this.i++; }

  parseShapeBlock() {
    const shape = this.parseShape();
    const body = this.parseBlock();
    this.eat(";");
    return { k: "moduleBlock", shape, body };
  }

  parseAscription() {
    const name = this.expectId();
    this.expect(":");

    if (this.at("=>")) this.err('dynamic declarations are gone; write "name: ?;"');

    const params = [];
    while (this.at("[")) {
      const p = this.parseParam();
      if (p) params.push(p);
    }

    // name: params `display`;                record type
    // name: params `display` => (ctors);     variant type
    if (this.peek().t === "lit") {
      const display = this.t[this.i++].v;
      const holes = parseDisplayHoles(display);
      let ctors = null;
      if (this.at("=>")) {
        this.nextSym();
        if (this.at("(")) {
          this.nextSym();
          ctors = [];
          while (!this.at(")")) {
            ctors.push(this.parseCtor());
            this.eat(";");
          }
          this.expect(")");
        } else {
          // parentheses may be omitted for a single constructor
          ctors = [this.parseCtor()];
        }
        checkHoles(holes, paramNames(params), `type ${name}`);
      } else if (this.at("{")) {
        this.err("constructor-with-body is removed: declare a record type and a function");
      }
      this.eat(";");
      return { k: "ascribe", name, params, display, holes, ctors };
    }

    // value: name: type [=> default];   (no parameter list)
    if (params.length === 0) {
      const result = this.at(";") || this.peek().t === "eof" ? { k: "unit" } : this.parseType();
      let def = null;
      if (this.at("=>")) {
        this.nextSym();
        def = this.parseExpr(false);
      }
      this.eat(";");
      return def
        ? { k: "ascribe", name, params, result, value: true, default: def }
        : { k: "ascribe", name, params, result, value: true };
    }

    // function: name: {params} [result] [=> ... body | => default];
    const result = this.at(";") || this.at("=>") ? { k: "unit" } : this.parseType();
    let body = null;
    let def = null;
    if (this.at("=>")) {
      this.nextSym();
      if (this.at("...")) body = this.parseBody();
      else {
        def = this.parseExpr(false);
        if (params.some((p) => p.k !== "typeParam")) {
          this.err("a default requires type parameters only; use '=> ...' for a body");
        }
      }
    }
    this.eat(";");
    const node = { k: "ascribe", name, params, result };
    if (body) node.body = body;
    if (def) node.default = def;
    return node;
  }

  parseBody() {
    if (this.at("...")) {
      this.nextSym();
      if (this.atId() && this.peek(1).t === "sym" && this.peek(1).v === ":") {
        const result = this.t[this.i++].v;
        this.expect(":");
        if (!this.at("{")) this.err('a named result requires a block: "... r: { ... }"');
        const body = this.parseBlock();
        return { k: "splat", result, body };
      }
      const body = this.parseExpr(false);
      return { k: "splat", result: null, body };
    }
    if (this.at("{")) this.err('a block must be headed, e.g. "... r: { ... }"');
    return { k: "alias", body: this.parseExpr(false) };
  }

  parseCtors() {
    if (!this.at("(")) return [this.parseCtor()];
    this.nextSym();
    const cs = [];
    while (!this.at(")")) {
      cs.push(this.parseCtor());
      this.eat(";");
    }
    this.expect(")");
    return cs;
  }

  parseCtor() {
    const name = this.expectId();
    this.expect(":");
    const params = [];
    while (this.at("[")) {
      const p = this.parseParam();
      if (p) params.push(p);
    }
    const display = this.expectKind("lit", "display literal");
    const holes = parseDisplayHoles(display);
    if (this.at("{")) {
      this.err("constructor bodies are removed: use a record type and a function");
    }
    checkHoles(holes, paramNames(params), `constructor ${name}`);
    return { k: "ctor", name, params, display, holes };
  }

  // ---- definitions -----------------------------------------------------

  parseDef() {
    if (this.eat("$")) {
      if (this.atId()) {
        const name = this.t[this.i++].v;
        if (this.at(".")) {
          // $name.field = value
          let target = { k: "name", v: name };
          while (this.eat(".")) target = { k: "proj", base: target, field: this.expectId() };
          this.expect("=");
          const rhs = this.parseRhs();
          this.eat(";");
          return { k: "defPath", target, rhs };
        }
        const keys = this.parseKeys();
        if (this.at("=")) {
          this.nextSym();
          const rhs = this.parseRhs();
          this.eat(";");
          return { k: "def", name, keys, rhs };
        }
        if (keys.length > 0 && (this.at(";") || this.peek().t === "eof")) {
          this.eat(";");
          return { k: "def", name, keys, rhs: { k: "alias", body: { k: "unit" } }, implicit: true };
        }
        this.err('expected "=" in a definition');
      }
      const keys = [this.parseKeyBody()];
      while (this.at("$")) {
        this.nextSym();
        keys.push(this.parseKeyBody());
      }
      this.expect("=");
      const rhs = this.parseRhs();
      this.eat(";");
      return { k: "def", name: null, keys, rhs };
    }

    const name = this.expectId();
    const keys = this.parseKeys(); // at least one; caller checked '$'
    if (this.at("=")) {
      this.nextSym();
      const rhs = this.parseRhs();
      this.eat(";");
      return { k: "def", name, keys, rhs };
    }
    if (keys.length > 0 && (this.at(";") || this.peek().t === "eof")) {
      this.eat(";");
      return { k: "def", name, keys, rhs: { k: "alias", body: { k: "unit" } }, implicit: true };
    }
    this.err('expected "=" in a definition');
  }

  parseKeys() {
    const keys = [];
    while (this.at("$")) {
      this.nextSym();
      if (this.at("{")) {
        // ${ pattern = name; ... } — a key list with a binder per argument
        this.nextSym();
        while (!this.at("}")) {
          const key = this.parseKey();
          this.expect("=");
          const name = this.expectId();
          this.eat(";");
          keys.push({ k: "keyBound", key, name });
        }
        this.expect("}");
        continue;
      }
      keys.push(this.parseKeyBody());
    }
    return keys;
  }

  parseKey() {
    this.expect("$");
    return this.parseKeyBody();
  }

  parseKeyBody() {
    if (this.at("[")) {
      const p = this.parseParam(true);
      if (p.k === "typeParam") return { k: "keyTypeArg", name: p.name };
      if (p.k === "unpack") return { k: "keyUnpack", name: p.name, type: p.type };
      if (!p.name && p.type && p.type.k === "kType") {
        this.err('use $[@?] for any type argument; "?" is a value type');
      }
      return { k: "keySlot", name: p.name, type: p.type };
    }
    if (this.at("(")) {
      const p = this.parseAtom(true);
      checkWild(p);
      return { k: "keyExpr", p };
    }
    this.err("expected [ or ( after $ in a key");
  }

  parseRhs() {
    return this.parseBody();
  }

  parseShape() {
    this.expect("(");
    const fields = [];
    if (!this.at(")")) {
      for (;;) {
        const name = this.expectId();
        this.expect(":");
        let type = null;
        if (!this.at(")") && !this.at(",")) type = this.parseType();
        fields.push({ name, type });
        if (!this.eat(",")) break;
      }
    }
    this.expect(")");
    return { k: "shape", fields };
  }

  parseBlock() {
    this.expect("{");
    const stmts = [];
    while (!this.at("}")) {
      if (this.peek().t === "eof") this.err("unterminated block");
      stmts.push(this.parseStmt());
    }
    this.expect("}");
    return { k: "block", stmts };
  }

  // ---- parameters / types ---------------------------------------------

  parseParam(pattern = false) {
    this.expect("[");
    // An empty bracket is one unit value in a declaration. In a pattern it is
    // meaningless: use $[X:] or $[@?].
    if (this.at("]")) {
      if (pattern) this.err("an empty pattern slot is invalid; use $[X:] or $[@?]");
      this.nextSym();
      return { k: "param", name: null, type: { k: "unit" }, unit: true };
    }
    if (this.at("=>")) this.err('the packed-pair parameter "[=> T]" is gone; write [X: ?]');

    // [@T] / [@?] — a type argument
    if (this.at("@")) {
      this.nextSym();
      let name = null;
      if (this.atId()) name = this.t[this.i++].v;
      else if (this.eat("?")) name = null;
      else this.err('expected a name or "?" after "@"');
      this.expect("]");
      return { k: "typeParam", name };
    }

    if (this.atId() && this.peek(1).t === "sym" && this.peek(1).v === ":") {
      const name = this.t[this.i++].v;
      this.nextSym();
      // In pattern space a bare binder needs no type: `$[X:]` (anonymous type).
      if (this.at("]")) {
        if (!pattern) this.err("a parameter type must be specified");
        this.nextSym();
        return { k: "param", name, type: null };
      }
      const type = this.parseType();
      if (pattern && this.at("=>")) {
        this.nextSym();
        if (!this.at("?")) this.err('unpacking is written "=> ?"');
        this.nextSym();
        if (!isConcreteTypeAst(type)) this.err("unpacking requires a concrete type (no @, no ?)");
        this.expect("]");
        return { k: "unpack", name, type };
      }
      this.expect("]");
      return { k: "param", name, type };
    }

    const type = this.parseType();
    if (pattern && this.at("=>")) {
      this.nextSym();
      if (!this.at("?")) this.err('unpacking is written "=> ?"');
      this.nextSym();
      if (!isConcreteTypeAst(type)) this.err("unpacking requires a concrete type (no @, no ?)");
      this.expect("]");
      return { k: "unpack", name: null, type };
    }
    this.expect("]");
    return { k: "param", name: null, type };
  }

  parseType() {
    if (this.at("[") && this.peek(1).t === "sym" && this.peek(1).v === "]") {
      // `[]` in a type position is the empty product, unit
      this.nextSym();
      this.nextSym();
      return { k: "unit" };
    }
    if (this.at("[")) {
      const params = [];
      while (this.at("[")) {
        this.nextSym();
        if (this.atId() && this.peek(1).t === "sym" && this.peek(1).v === ":") {
          const name = this.t[this.i++].v;
          this.nextSym();
          params.push({ k: "namedType", name, type: this.parseType() });
        } else {
          params.push(this.parseType());
        }
        this.expect("]");
      }
      const result = this.parseTypeApp();
      return { k: "fnType", params, result };
    }
    return this.parseTypeApp();
  }

  parseTypeApp() {
    const head = this.parseTypeAtom();
    const args = [];
    while (this.typeAtomStart()) args.push(this.parseTypeArg());
    return args.length ? { k: "typeApp", head, args } : head;
  }

  typeAtomStart() {
    const x = this.peek();
    if (x.t === "id" || x.t === "str" || x.t === "num") return true;
    if (x.t === "sym" && ["?", "(", "[", "@"].includes(x.v)) return true;
    // a quoted sub-pattern inside a type, e.g. dict $[k:]
    if (x.t === "sym" && x.v === "$") {
      const n = this.peek(1);
      return n.t === "sym" && n.v === "[";
    }
    return false;
  }

  parseTypeArg() {
    if (this.at("$") && this.peek(1).t === "sym" && this.peek(1).v === "[") {
      this.nextSym();
      const p = this.parseParam(true);
      return { k: "typePattern", name: p ? p.name : null, type: p ? p.type : null };
    }
    if (this.at("[")) {
      this.nextSym();
      if (this.atId() && this.peek(1).t === "sym" && this.peek(1).v === ":") {
        const name = this.t[this.i++].v;
        this.nextSym();
        let type = null;
        if (!this.at("]")) type = this.parseType();
        this.expect("]");
        return { k: "typeArgBinder", name, type };
      }
      const type = this.parseType();
      this.expect("]");
      return { k: "typeArg", type };
    }
    return this.parseTypeAtom();
  }

  parseTypeAtom() {
    if (this.eat("?")) return { k: "kType" };
    if (this.at("@")) {
      this.nextSym();
      if (this.atId()) return { k: "typeVar", name: this.t[this.i++].v };
      if (this.eat("?")) return { k: "typeVar", name: null };
      this.err('expected a name or "?" after "@"');
    }
    if (this.atId()) return { k: "typeName", name: this.t[this.i++].v };
    // a type position may contain a term, e.g. F "bool" (legacy; rejected at run time)
    if (this.peek().t === "str") return { k: "typeStr", v: this.t[this.i++].v };
    if (this.peek().t === "num") return { k: "typeNum", v: Number(this.t[this.i++].v) };
    if (this.at("(")) {
      this.nextSym();
      const items = [];
      if (!this.at(")")) {
        items.push(this.parseType());
        while (this.eat(",")) items.push(this.parseType());
      }
      this.expect(")");
      return items.length ? { k: "product", items } : { k: "unit" };
    }
    this.err("expected a type");
  }

  // ---- expressions -----------------------------------------------------

  parseExpr(pattern) { return this.parseOr(pattern); }

  parseOr(pattern) {
    let l = this.parseAnd(pattern);
    while (this.at("||")) {
      this.nextSym();
      l = { k: "bin", op: "||", l, r: this.parseAnd(pattern) };
    }
    return l;
  }

  parseAnd(pattern) {
    let l = this.parseEquality(pattern);
    while (this.at("&&")) {
      this.nextSym();
      l = { k: "bin", op: "&&", l, r: this.parseEquality(pattern) };
    }
    return l;
  }

  parseEquality(pattern) {
    let l = this.parseRelational(pattern);
    while (this.atAny("==", "!=")) {
      const op = this.t[this.i++].v;
      l = { k: "bin", op, l, r: this.parseRelational(pattern) };
    }
    return l;
  }

  parseRelational(pattern) {
    let l = this.parseUnary(pattern);
    while (this.atAny("<", ">", "<=", ">=")) {
      const op = this.t[this.i++].v;
      l = { k: "bin", op, l, r: this.parseUnary(pattern) };
    }
    return l;
  }

  parseUnary(pattern) {
    if (this.eat("!")) return { k: "un", op: "!", e: this.parseUnary(pattern) };
    return this.parseApp(pattern);
  }

  parseApp(pattern) {
    const head = this.parsePostfix(pattern, false);
    const args = [];
    while (this.atomStart(pattern)) args.push(this.parsePostfix(pattern, true));
    let e = args.length ? { k: "app", head, args } : head;
    if (this.at("{")) e = this.parseNamedApp(e);
    return e;
  }

  parsePostfix(pattern, noBrace = false) {
    let e = this.parseAtom(pattern);
    let braced = false;
    for (;;) {
      if (this.eat(".")) { e = { k: "proj", base: e, field: this.expectId() }; continue; }
      if (!braced && !noBrace && this.at("{")) { e = this.parseNamedApp(e); braced = true; continue; }
      break;
    }
    return e;
  }

  parseNamedApp(callee) {
    this.expect("{");
    const args = [];
    while (!this.at("}")) {
      if (this.peek().t === "eof") this.err("unterminated {");
      this.expect("$");
      const name = this.expectId();
      this.expect("=");
      const value = this.parseExpr(false);
      this.eat(";");
      args.push({ name, value });
    }
    this.expect("}");
    return { k: "namedApp", callee, args };
  }

  atomStart(pattern) {
    const x = this.peek();
    if (x.t === "sym" && x.v === "...") return true;
    if (x.t === "num" || x.t === "str" || x.t === "lit" || x.t === "id") return true;
    if (x.t === "sym" && x.v === "(") return true;
    if (!pattern && x.t === "sym" && (x.v === "?" || x.v === "@")) return true;
    if (pattern && x.t === "sym" && x.v === "$") return true;
    return false;
  }

  parseAtom(pattern) {
    const x = this.peek();
    if (!pattern && this.at("...")) {
      this.nextSym();
      const body = this.parseExpr(false);
      return { k: "splatExpr", body };
    }
    if (pattern && this.at("?")) { this.nextSym(); return { k: "wild" }; }
    if (!pattern && this.at("?")) { this.nextSym(); return { k: "top" }; }
    if (!pattern && this.at("@")) {
      this.nextSym();
      if (this.atId()) return { k: "typeVarValue", name: this.t[this.i++].v };
      if (this.eat("?")) return { k: "typeVarValue", name: null };
      this.err('expected a name or "?" after "@"');
    }
    if (x.t === "num") { this.nextSym(); return { k: "num", v: Number(x.v) }; }
    if (x.t === "str") { this.nextSym(); return { k: "str", v: x.v }; }
    if (x.t === "lit") { this.nextSym(); return { k: "lit", v: x.v }; }
    if (x.t === "id") {
      this.nextSym();
      if (pattern && this.at(":")) {
        this.nextSym();
        let type = null;
        if (!this.atAny(",", ")")) type = this.parseType();
        return { k: "binder", name: x.v, type };
      }
      return { k: "name", v: x.v };
    }
    if (!pattern && this.at("$")) {
      // a definition in expression position, e.g. print ($[int] = n)
      this.nextSym();
      let name = null;
      const keys = [];
      if (this.atId()) {
        name = this.t[this.i++].v;
      } else {
        keys.push(this.parseKeyBody());
        while (this.at("$")) {
          this.nextSym();
          keys.push(this.parseKeyBody());
        }
      }
      if (!this.at("=")) this.err("expected = in a $-definition");
      this.nextSym();
      const rhs = this.parseRhs();
      return { k: "define", name, keys, rhs };
    }
    if (pattern && this.at("$")) {
      this.nextSym();
      if (this.at("[")) {
        const p = this.parseParam(true);
        if (p.k === "typeParam") return { k: "holeType", name: p.name };
        if (p.k === "unpack") return { k: "holeUnpack", name: p.name, type: p.type };
        return { k: "hole", name: p.name, type: p.type };
      }
      if (this.at("(")) return this.parseAtom(true);
      this.err("expected [ or ( after $ in a pattern");
    }
    if (this.at("(")) {
      this.nextSym();
      if (this.at(")")) { this.nextSym(); return { k: "unit" }; }
      const first = this.parseAtomOrExpr(pattern);
      if (this.at("=>")) {
        this.err("typed expression patterns are gone; use $[T => ?] or $(shape)");
      }
      const items = [first];
      while (this.eat(",")) items.push(this.parseAtomOrExpr(pattern));
      this.expect(")");
      return items.length === 1 ? items[0] : { k: "tuple", items };
    }
    this.err("expected an expression");
  }

  parseAtomOrExpr(pattern) {
    // inside ( ... ) an element is a full expression
    return this.parseExpr(pattern);
  }

  // ---- lookahead helpers ------------------------------------------------

  matchingParen(idx) {
    let d = 0;
    for (let j = idx; j < this.t.length; j++) {
      const x = this.t[j];
      if (x.t !== "sym") continue;
      if (x.v === "(") d++;
      else if (x.v === ")") { d--; if (d === 0) return j; }
    }
    return -1;
  }

  shapeThenBlock() {
    if (!this.at("(")) return false;
    const end = this.matchingParen(this.i);
    const after = end >= 0 ? this.t[end + 1] : null;
    return !!after && after.t === "sym" && after.v === "{";
  }

  shapeAhead() {
    if (!this.at("(")) return false;
    const a = this.peek(1), b = this.peek(2);
    if (a.t === "sym" && a.v === ")") return true;
    return a.t === "id" && b.t === "sym" && b.v === ":";
  }
}

export function parse(src) {
  return new Parser(lex(src)).parseModule();
}

// `?` is only the value side of a typed pair, as in $(int => ?).
// Padding a key slot you do not care about is written $[X:].
function checkWild(node, allowHere = false) {  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) checkWild(n, false);
    return;
  }
  if (node.k === "wild") {
    if (!allowHere) {
      throw new Error("`?` is only allowed as the value side of a typed pair; use $[X:] to ignore a slot");
    }
    return;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === "k") continue;
    checkWild(val, node.k === "pair" && key === "r");
  }
}

function paramNames(params) {
  return new Set(params.map((p) => p && p.name).filter(Boolean));
}

// Only a concrete type may be the left side of an unpacking slot.
function isConcreteTypeAst(t) {
  if (!t) return false;
  if (t.k === "typeName") return true;
  if (t.k === "unit") return true;
  if (t.k === "product") return t.items.every(isConcreteTypeAst);
  if (t.k === "typeApp") {
    if (!isConcreteTypeAst(t.head)) return false;
    return t.args.every((a) => a.k === "typeArg" && isConcreteTypeAst(a.type));
  }
  if (t.k === "fnType") {
    return t.params.every((p) => isConcreteTypeAst(p.k === "namedType" ? p.type : p)) && isConcreteTypeAst(t.result);
  }
  return false;
}

function bodyNames(block) {
  const names = new Set();
  if (!block) return names;
  for (const s of block.stmts) if (s.k === "ascribe") names.add(s.name);
  return names;
}

// A bare \(name) must name a binder in scope; \(name:type) declares one.
function checkHoles(holes, scope, where) {
  for (const h of holes) {
    if (h.type) continue;
    if (!scope.has(h.name)) {
      throw new Error(`display hole \\(${h.name}) in ${where} does not name a declared binder`);
    }
  }
}

// A display template is text with \(name) and \(name:type) holes.
// The typed form declares a field; the bare form references one.
export function parseDisplayHoles(text) {
  const holes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      const next = text[i + 1];
      if (next === "(") {
        let depth = 0;
        let j = i + 1;
        for (; j < text.length; j++) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (j >= text.length) {
          throw new Error(`unterminated display hole in \`${text}\``);
        }
        const inner = text.slice(i + 2, j).trim();
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([\s\S]*))?$/.exec(inner);
        if (!m) throw new Error(`bad display hole \\(${inner}) in \`${text}\``);
        holes.push({ name: m[1], type: m[2] && m[2].trim() ? parseTypeText(m[2].trim()) : null });
        i = j;
        continue;
      }
      // \\ or \` or any other escape: literal text, skip both characters
      i++;
      continue;
    }
  }
  return holes;
}

export function parseTypeText(src) {
  const p = new Parser(lex(src));
  const t = p.parseType();
  if (p.peek().t !== "eof") p.err("trailing tokens in type");
  return t;
}

// ---- AST dump ----------------------------------------------------------

function typeText(t) {
  switch (t.k) {
    case "typeName": return t.name;
    case "typeVar": return t.name ? "@" + t.name : "@?";
    case "kType": return "?";
    case "unit": return "()";
    case "product": return "(" + t.items.map(typeText).join(", ") + ")";
    case "fnType": return t.params.map((p) => `[${typeText(p)}]`).join(" ") + " " + typeText(t.result);
    case "typeApp": return typeText(t.head) + " " + t.args.map((a) => {
      if (a.k === "typeArg") return typeText(a.type);
      if (a.k === "typeArgBinder") return `[${a.name}${a.type ? ":" + typeText(a.type) : ":"}]`;
      if (a.k === "typePattern") return `$[${a.name ?? ""}${a.type ? ":" + typeText(a.type) : ":"}]`;
      if (a.k === "typeStr") return JSON.stringify(a.v);
      if (a.k === "typeNum") return String(a.v);
      return typeText(a);
    }).join(" ");
    case "typeStr": return JSON.stringify(t.v);
    case "typeNum": return String(t.v);
    default: return "?";
  }
}

function holeText(holes) {
  return holes.map((h) => h.name + (h.type ? ":" + typeText(h.type) : "")).join(", ");
}

export function dump(node, depth = 0) {
  const pad = "  ".repeat(depth);
  const go = (n, d = depth + 1) => dump(n, d);
  if (node == null) return pad + "null";
  if (Array.isArray(node)) return node.map((n) => go(n)).join("\n");

  const one = (label, n) => `${pad}${label}\n${go(n)}`;
  switch (node.k) {
    case "module": return one("module", node.body);
    case "ascribe": {
      const bits = [`${pad}ascribe ${node.name}`];
      if (node.dynamic) bits.push(`${pad}  dynamic`);
      if (node.params && node.params.length) bits.push(one("params", node.params));
      if (node.display !== undefined) {
        bits.push(`${pad}  display \`${node.display}\``);
        if (node.holes.length) bits.push(`${pad}  holes ${holeText(node.holes)}`);
        if (node.ctors) bits.push(one("ctors", node.ctors));
        else bits.push(`${pad}  record type`);
      } else if (node.result) {
        if (node.value) bits.push(`${pad}  value`);
        bits.push(one("result", node.result));
      }
      if (node.body) bits.push(one("body", node.body));
      if (node.default) bits.push(one("default", node.default));
      return bits.join("\n");
    }
    case "ctor": {
      const bits = [`${pad}ctor ${node.name} \`${node.display}\``];
      if (node.holes && node.holes.length) bits.push(`${pad}  holes ${holeText(node.holes)}`);
      if (node.params.length) bits.push(one("params", node.params));
      if (node.body) bits.push(one("body", node.body));
      return bits.join("\n");
    }
    case "def": {
      const bits = [`${pad}def${node.name ? " " + node.name : " (no name)"}`];
      if (node.keys.length) bits.push(one("keys", node.keys));
      bits.push(one("rhs", node.rhs));
      return bits.join("\n");
    }
    case "define": {
      const bits = [`${pad}define${node.name ? " " + node.name : ""}`];
      if (node.keys.length) bits.push(go(node.keys));
      bits.push(go(node.rhs));
      return bits.join("\n");
    }
    case "defPath": return `${pad}def-path\n${go(node.target)}\n${go(node.rhs)}`;
    case "keySlot": {
      const t = node.type ? dump(node.type, 0) : "null";
      return `${pad}key-slot${node.name ? " " + node.name : ""}: ${t}`;
    }
    case "keyExpr": return one("key-expr", node.p);
    case "keyTypeArg": return `${pad}key-type${node.name ? " " + node.name : " ?"}`;
    case "keyUnpack": return `${pad}key-unpack${node.name ? " " + node.name : ""}: ${node.type ? typeText(node.type) : "?"}`;
    case "splat": {
      const bits = [`${pad}splat`];
      if (node.result) bits.push(`${pad}  result ${node.result}`);
      bits.push(one("body", node.body));
      return bits.join("\n");
    }
    case "alias": return one("alias", node.body);
    case "splatExpr": return one("...", node.body);
    case "directive": {
      const bits = [`${pad}\\${node.what}`];
      if (node.arg) bits.push(dump(node.arg, depth + 1));
      return bits.join("\n");
    }
    case "namedApp": {
      const bits = [`${pad}named-app`];
      bits.push(dump(node.callee, depth + 1));
      for (const a of node.args) {
        bits.push(`${"  ".repeat(depth + 1)}$${a.name} =`);
        bits.push(dump(a.value, depth + 2));
      }
      return bits.join("\n");
    }
    case "shape": {
      const fs = node.fields.map(
        (f) => `${"  ".repeat(depth + 1)}${f.name}: ${f.type ? dump(f.type, 0) : "<implied>"}`
      );
      return [`${pad}shape`, ...fs].join("\n");
    }
    case "shapeType": {
      const fs = node.shape.fields.map(
        (f) => `${"  ".repeat(depth + 1)}${f.name}: ${f.type ? typeText(f.type) : "<inferred>"}`
      );
      return [`${pad}result-shape`, ...fs].join("\n");
    }
    case "param": {
      const bits = [`${pad}param${node.name ? " " + node.name : ""}`];
      if (node.type) bits.push(go(node.type));
      else bits.push(`${pad}  <inferred>`);
      return bits.join("\n");
    }
    case "typeParam": return `${pad}type-param ${node.name ? "@" + node.name : "@?"}`;
    case "unpack": return `${pad}unpack${node.name ? " " + node.name : ""}: ${node.type ? typeText(node.type) : "?"}`;
    case "block": return one("block", node.stmts);
    case "expr": return one("expr", node.e);
    case "moduleBlock": return `${pad}module-block\n${go(node.shape)}\n${go(node.body)}`;
    case "fnType": return `${pad}fn-type\n${go(node.params)}\n${go(node.result)}`;
    case "typeApp": return `${pad}type-app ${dump(node.head, 0)}\n${go(node.args)}`;
    case "typeArg": return `${pad}type-arg\n${go(node.type)}`;
    case "typeArgBinder": {
      const t = node.type ? dump(node.type, 0) : "<implied>";
      return `${pad}type-arg ${node.name}: ${t}`;
    }
    case "typeName": return `${pad}type ${node.name}`;
    case "typeVar": return `${pad}type-var ${node.name ? "@" + node.name : "@?"}`;
    case "typeStr": return `${pad}type ${JSON.stringify(node.v)}`;
    case "typeNum": return `${pad}type ${node.v}`;
    case "typePattern": return `${pad}type-pattern ${node.name}: ${node.type ? typeText(node.type) : "<inferred>"}`;
    case "infer": return `${pad}type <inferred>`;
    case "kType": return `${pad}type ?`;
    case "product": return one("product", node.items);
    case "unit": return `${pad}unit`;
    case "unaryPair": return `${pad}unary-pair\n${go(node.t)}`;
    case "name": return `${pad}name ${node.v}`;
    case "top": return `${pad}?`;
    case "typeVarValue": return `${pad}@${node.name || "?"}`;
    case "num": return `${pad}num ${node.v}`;
    case "str": return `${pad}str ${JSON.stringify(node.v)}`;
    case "lit": return `${pad}lit \`${node.v}\``;
    case "app": return `${pad}app\n${pad}  head\n${dump(node.head, depth + 2)}\n${pad}  args\n${dump(node.args, depth + 2)}`;
    case "bin": return `${pad}${node.op}\n${dump(node.l, depth + 1)}\n${dump(node.r, depth + 1)}`;
    case "un": return `${pad}${node.op} (prefix)\n${dump(node.e, depth + 1)}`;
    case "proj": return `${pad}.${node.field}\n${dump(node.base, depth + 1)}`;
    case "tuple": return one("tuple", node.items);
    case "pair": return `${pad}=>\n${go(node.l)}\n${go(node.r)}`;
    case "binder": {
      const t = node.type ? dump(node.type, 0) : "<implied>";
      return `${pad}binder ${node.name}: ${t}`;
    }
    case "hole": {
      const t = node.type ? dump(node.type, 0) : "<implied>";
      return `${pad}hole${node.name ? " " + node.name : ""}: ${t}`;
    }
    case "holeType": return `${pad}hole-type ${node.name ? "@" + node.name : "@?"}`;
    case "holeUnpack": return `${pad}hole-unpack${node.name ? " " + node.name : ""}: ${node.type ? typeText(node.type) : "?"}`;
    case "pat": return one("pattern", node.p);
    case "wild": return `${pad}?`;
    default: return `${pad}${JSON.stringify(node)}`;
  }
}

