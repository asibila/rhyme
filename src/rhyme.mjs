// Rhyme2 — lexer + parser for the surface grammar in SPEC.md.
// This is deliberately syntax-only: it proves the grammar, not the semantics.

const PUNCT2 = new Set(["<-", "=>", "&&", "||", "==", "!=", "<=", ">="]);
const PUNCT1 = new Set("()[]{}:;,.$?!<>".split(""));

export function lex(src) {
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
    if (this.at("(") && this.shapeThenBlock()) return this.parseShapeBlock();

    const e = this.parseExpr(false);
    if (this.at("<-")) {
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
    const params = [];
    while (this.at("[")) {
      const p = this.parseParam();
      if (p) params.push(p);
    }

    const node = { k: "ascribe", name, params };
    if (this.at("=>")) {
      // `name: => ...`): either an initialised value, or a packed signature
      // (a type follows, e.g. `H: => [string] ?;`)
      this.nextSym();
      if (this.at("[") || this.at("?")) {
        node.packedType = this.parseType();
        this.eat(";");
        return node;
      }
      node.value = this.parseRhs();
      this.eat(";");
      return node;
    }
    if (this.peek().t === "lit") {
      node.display = this.t[this.i++].v;
      node.holes = parseDisplayHoles(node.display);
      if (this.at("=>")) {
        this.nextSym();
        node.ctors = this.parseCtors();
        checkHoles(node.holes, paramNames(node.params), `type ${name}`);
      } else if (this.at("{")) {
        // a displayed definition: name: {params} `template` { body }
        node.body = this.parseBlock();
        checkHoles(node.holes, bodyNames(node.body), `definition ${name}`);
      } else {
        this.err('expected "=>" or "{" after a display template');
      }
    } else if (this.at("(") && this.shapeAhead()) {
      // (m:) — a result record whose field types are deduced
      const shape = this.parseShape();
      node.result = shape.fields.length ? { k: "shapeType", shape } : { k: "unit" };
      if (this.at("{")) node.body = this.parseBlock();
    } else if (this.at(";") || this.at("{") || this.peek().t === "eof") {
      // Nothing written: unit.
      node.result = { k: "unit" };
      if (this.at("{")) node.body = this.parseBlock();
    } else {
      node.result = this.parseType();
      if (this.at("{")) node.body = this.parseBlock();
    }
    this.eat(";");
    return node;
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
    const body = this.at("{") ? this.parseBlock() : null;
    const scope = paramNames(params);
    for (const n of bodyNames(body)) scope.add(n);
    checkHoles(holes, scope, `constructor ${name}`);
    return { k: "ctor", name, params, display, holes, body };
  }

  // ---- definitions -----------------------------------------------------

  parseDef() {
    if (this.eat("$")) {
      if (this.atId()) {
        const name = this.t[this.i++].v;
        const keys = this.parseKeys();
        this.expect("<-");
        const rhs = this.parseRhs();
        this.eat(";");
        return { k: "def", name, keys, rhs };
      }
      const keys = [this.parseKeyBody()];
      while (this.at("$")) {
        this.nextSym();
        keys.push(this.parseKeyBody());
      }
      this.expect("<-");
      const rhs = this.parseRhs();
      this.eat(";");
      return { k: "def", name: null, keys, rhs };
    }

    const name = this.expectId();
    const keys = this.parseKeys(); // at least one; caller checked '$'
    this.expect("<-");
    const rhs = this.parseRhs();
    this.eat(";");
    return { k: "def", name, keys, rhs };
  }

  parseKeys() {
    const keys = [];
    while (this.at("$")) {
      this.nextSym();
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
      const p = this.parseParam();
      return { k: "keySlot", name: p ? p.name : null, type: p ? p.type : null };
    }
    if (this.at("(")) {
      const p = this.parseAtom(true);
      checkWild(p);
      return { k: "keyExpr", p };
    }
    this.err("expected [ or ( after $ in a key");
  }

  parseRhs() {
    const binders = [];
    while (this.at("[")) {
      const b = this.parseParam();
      if (b) binders.push(b);
    }
    let shape = null;
    if (this.at("(") && this.shapeAhead()) shape = this.parseShape();
    const body = this.at("{") ? this.parseBlock() : this.parseExpr(false);
    return { k: "rhs", binders, shape, body };
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

  parseParam() {
    this.expect("[");
    // An empty bracket is one slot whose type is the empty product, unit.
    // Arity 0 is written with no brackets at all.
    if (this.at("]")) {
      this.nextSym();
      return { k: "param", name: null, type: { k: "unit" }, unit: true };
    }
    if (this.at("=>")) {
      this.nextSym();
      const t = this.parseType();
      this.expect("]");
      return { k: "param", name: null, type: { k: "unaryPair", t } };
    }
    if (this.atId() && this.peek(1).t === "sym" && this.peek(1).v === ":") {
      const name = this.t[this.i++].v;
      this.nextSym();
      let type = null;
      if (!this.at("]")) type = this.parseType();
      this.expect("]");
      return { k: "param", name, type };
    }
    const type = this.parseType();
    this.expect("]");
    return { k: "param", name: null, type };
  }

  parseType() {
    if (this.at("[")) {
      const params = [];
      while (this.at("[")) {
        this.nextSym();
        params.push(this.parseType());
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
    if (x.t === "sym" && ["?", "(", "["].includes(x.v)) return true;
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
      const p = this.parseParam();
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
    if (this.atId()) return { k: "typeName", name: this.t[this.i++].v };
    // a type position may contain a term, e.g. F "bool"
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
    const head = this.parsePostfix(pattern);
    const args = [];
    while (this.atomStart(pattern)) args.push(this.parsePostfix(pattern));
    return args.length ? { k: "app", head, args } : head;
  }

  parsePostfix(pattern) {
    let e = this.parseAtom(pattern);
    while (this.eat(".")) e = { k: "proj", base: e, field: this.expectId() };
    return e;
  }

  atomStart(pattern) {
    const x = this.peek();
    if (x.t === "num" || x.t === "str" || x.t === "lit" || x.t === "id") return true;
    if (x.t === "sym" && x.v === "(") return true;
    if (pattern && x.t === "sym" && x.v === "$") return true;
    return false;
  }

  parseAtom(pattern) {
    const x = this.peek();
    if (pattern && this.at("?")) { this.nextSym(); return { k: "wild" }; }
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
      // a definition in expression position, e.g. print ($[int] <- n)
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
      if (!this.at("<-")) this.err("expected <- in a $-definition");
      this.nextSym();
      const rhs = this.parseRhs();
      return { k: "define", name, keys, rhs };
    }
    if (pattern && this.at("$")) {
      this.nextSym();
      if (this.at("[")) {
        const p = this.parseParam();
        return { k: "hole", name: p ? p.name : null, type: p ? p.type : null };
      }
      if (this.at("(")) return this.parseAtom(true);
      this.err("expected [ or ( after $ in a pattern");
    }
    if (this.at("(")) {
      this.nextSym();
      if (this.at(")")) { this.nextSym(); return { k: "unit" }; }
      const first = this.parseAtomOrExpr(pattern);
      if (this.eat("=>")) {
        const second = this.parseExpr(pattern);
        this.expect(")");
        return { k: "pair", l: first, r: second };
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
      if (node.params.length) bits.push(one("params", node.params));
      if (node.display !== undefined) {
        bits.push(`${pad}  display \`${node.display}\``);
        if (node.holes.length) bits.push(`${pad}  holes ${holeText(node.holes)}`);
        if (node.ctors) bits.push(one("ctors", node.ctors));
      } else if (node.value !== undefined) {
        bits.push(one("= value", node.value));
      } else if (node.packedType !== undefined) {
        bits.push(one("=> packed", node.packedType));
      } else {
        bits.push(one("result", node.result));
      }
      if (node.body) bits.push(one("body", node.body));
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
    case "rhs": {
      const bits = [`${pad}rhs`];
      if (node.binders.length) bits.push(one("binders", node.binders));
      if (node.shape) bits.push(one("shape", node.shape));
      bits.push(one("body", node.body));
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
    case "typeStr": return `${pad}type ${JSON.stringify(node.v)}`;
    case "typeNum": return `${pad}type ${node.v}`;
    case "typePattern": return `${pad}type-pattern ${node.name}: ${node.type ? typeText(node.type) : "<inferred>"}`;
    case "infer": return `${pad}type <inferred>`;
    case "kType": return `${pad}type ?`;
    case "product": return one("product", node.items);
    case "unit": return `${pad}unit`;
    case "unaryPair": return `${pad}unary-pair\n${go(node.t)}`;
    case "name": return `${pad}name ${node.v}`;
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
    case "pat": return one("pattern", node.p);
    case "wild": return `${pad}?`;
    default: return `${pad}${JSON.stringify(node)}`;
  }
}

