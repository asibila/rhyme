// Rhyme2 — evaluator on top of the parser.
// Dynamic: types are values, but there is no static checker yet.

import { parse } from "./rhyme.mjs";

export class EvalError extends Error {}
const fail = (msg) => { throw new EvalError(msg); };

const UNIT = Object.freeze({ k: "unit" });

const mkType = (name, extra = {}) => ({ k: "type", name, args: [], ...extra });
const T_INT = mkType("int", { builtin: true });
const T_FLOAT = mkType("float", { builtin: true });
const T_STRING = mkType("string", { builtin: true });
const T_BOOL = mkType("bool", { builtin: true });
const T_VOID = mkType("void", { builtin: true });
const T_UNIT = mkType("()", { builtin: true });
const T_KIND = mkType("?", { builtin: true, universe: true });
const T_FN = mkType("fn", { builtin: true });

const vNum = (n) => ({ k: "num", v: Number(n) });
const vStr = (s) => ({ k: "str", v: s });
const vBool = (b) => ({ k: "bool", v: !!b });
const vTuple = (items, names = null) => ({ k: "tuple", items, names });
const vPacked = (type, value) => ({ k: "packed", type, value });
const vType = (name, args, def) => ({ k: "type", name, args, def, builtin: false });
const vRecord = (o) => ({ k: "record", ...o });

const builtin = (name, arity, apply, params = null) => ({ k: "builtin", name, arity, apply, params });

class Cell {
  constructor(sig = null) { this.value = undefined; this.set = false; this.sig = sig; }
}

class Env {
  constructor(parent = null) { this.parent = parent; this.vars = new Map(); }
  declare(name, sig = null) {
    const c = new Cell(sig);
    this.vars.set(name, c);
    return c;
  }
  find(name) {
    for (let e = this; e; e = e.parent) if (e.vars.has(name)) return e.vars.get(name);
    return null;
  }
  has(name) { return !!this.find(name); }
  get(name) {
    const c = this.find(name);
    if (!c) fail(`'${name}' is not declared`);
    if (!c.set) fail(`'${name}' has not been assigned`);
    return c.value;
  }
  assign(name, value) {
    const c = this.find(name);
    if (!c) fail(`'${name}' is not declared (declare it with ${name}: ... first)`);
    c.value = value;
    c.set = true;
  }
  sigOf(name) { const c = this.find(name); return c ? c.sig : null; }
}

function typeOf(v) {
  switch (v.k) {
    case "num": return Number.isInteger(v.v) ? T_INT : T_FLOAT;
    case "str": return T_STRING;
    case "bool": return T_BOOL;
    case "unit": return T_UNIT;
    case "type": return T_KIND;
    case "record": return v.type || mkType("record");
    case "tuple": return mkType("(,)", { args: v.items.map(typeOf) });
    case "packed": return v.type;
    case "fn": case "builtin": return T_FN;
    case "partial": {
      const t = v.target && v.target.type;
      if (t) {
        return {
          k: "type", name: "->",
          params: t.params.slice(v.args.length),
          result: t.result,
        };
      }
      return T_FN;
    }
    default: return T_KIND;
  }
}

function typeEq(a, b) {
  if (!a || !b || a.k !== "type" || b.k !== "type") return false;
  if (a.name !== b.name || a.args.length !== b.args.length) return false;
  return a.args.every((x, i) => typeEq(x, b.args[i]));
}

function isTypeParamType(t) {
  if (!t) return false;
  if (t.k === "kType") return true;
  if (t.k === "fnType") {
    return t.params.every((p) => p.k === "kType") && t.result.k === "kType";
  }
  return false;
}

const isUnitType = (t) => t && t.k === "type" && t.name === "()";

export function run(source, opts = {}) {
  const tree = parse(source);
  const ev = new Evaluator(opts);
  try {
    const value = ev.runModule(tree);
    return { value, stdout: ev.out.join(""), display: ev.display(value), ev };
  } catch (e) {
    e.stdout = ev.out.join("");
    throw e;
  }
}

class Evaluator {
  constructor(opts = {}) {
    this.out = [];
    this.typeDefs = new Map();     // name -> display/template info for builtin overrides
    this.boolDisplay = null;       // { types: ..., ctors: Map(value -> template) }
    this.depth = 0;
  }

  // ---- display --------------------------------------------------------

  text(v) {
    if (v.k === "str") return v.v;             // print writes bare string contents
    return this.display(v);
  }

  display(v) {
    switch (v.k) {
      case "num": return String(v.v);
      case "str": return JSON.stringify(v.v);
      case "bool": return this.displayBool(v.v);
      case "unit": return "()";
      case "type": return this.displayType(v);
      case "fn": case "builtin": case "partial": return "<fn>";
      case "packed": return this.display(v.value);
      case "tuple": return "(" + v.items.map((x) => this.display(x)).join(", ") + ")";
      case "record": return this.displayRecord(v);
      default: return "<?>";
    }
  }

  displayBool(b) {
    if (this.boolDisplay) {
      const t = this.boolDisplay.ctors.get(b);
      if (t !== undefined) return t;
    }
    return b ? "true" : "false";
  }

  displayType(t) {
    const def = t.def || this.typeDefs.get(t.name);
    if (def && def.display !== undefined) {
      const names = (def.params || []).map((p) => p && p.name);
      return this.render(def.display, (name) => {
        const i = names.indexOf(name);
        if (i >= 0 && t.args[i]) return this.displayType(t.args[i]);
        return "";
      });
    }
    if (t.args.length) return t.name + " " + t.args.map((a) => this.displayType(a)).join(" ");
    return t.name;
  }

  displayRecord(r) {
    if (r.template == null) return r.ctor || "<record>";
    const lookup = (name) => {
      const cell = r.fields && r.fields.get(name);
      if (!cell || !cell.set) return "";
      return this.display(cell.value);
    };
    return this.render(r.template, lookup);
  }

  // Render a display template, honouring \(hole) and backslash escapes.
  render(raw, lookup) {
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c !== "\\") { out += c; continue; }
      const next = raw[i + 1];
      if (next === "(") {
        let depth = 0;
        let j = i + 1;
        for (; j < raw.length; j++) {
          if (raw[j] === "(") depth++;
          else if (raw[j] === ")" && --depth === 0) break;
        }
        const inner = raw.slice(i + 2, j).trim();
        const name = inner.split(":")[0].trim();
        out += lookup(name);
        i = j;
        continue;
      }
      if (next === "\\") { out += "\\"; i++; continue; }
      if (next === "`") { out += "`"; i++; continue; }
      out += next;
      i++;
    }
    return out;
  }

  // ---- module ---------------------------------------------------------

  runModule(tree) {
    const root = this.installBuiltins(new Env());
    const env = new Env(root);
    const selfCell = env.declare("self");
    let stmts = tree.body;
    if (stmts[0] && stmts[0].k === "directive" && stmts[0].what === "self") {
      const arg = stmts[0].arg;
      const name = arg && arg.k === "name" ? arg.v : "self";
      env.vars.delete("self");
      env.vars.set(name, selfCell);
      stmts = stmts.slice(1);
    }
    this.evalStmts(stmts, env);
    return selfCell.set ? selfCell.value : UNIT;
  }

  installBuiltins(root) {
    const put = (name, value) => {
      const c = root.declare(name);
      c.value = value;
      c.set = true;
      c.builtin = true;
    };
    put("int", T_INT);
    put("float", T_FLOAT);
    put("string", T_STRING);
    put("bool", T_BOOL);
    put("void", T_VOID);
    put("true", vBool(true));
    put("false", vBool(false));
    put("to_string", builtin("to_string", 1, (args) => vStr(this.text(args[0])), ["x"]));
    const printer = (name) => builtin(name, 1, (args) => {
      const s = this.text(args[0]);
      this.out.push(s + "\n");
      return vStr(s);
    }, ["x"]);
    put("print_int", printer("print_int"));
    put("print_float", printer("print_float"));
    put("print_bool", printer("print_bool"));
    const intAdd = (name) => {
      const b = builtin(name, 2, (args) => {
        const [a, c] = args;
        if (a.k !== "num" || c.k !== "num" || !Number.isInteger(a.v) || !Number.isInteger(c.v)) {
          fail(`${name} expects two ints, got ${this.display(a)} and ${this.display(c)}`);
        }
        return vNum(a.v + c.v);
      }, ["a", "b"]);
      b.type = { params: [T_INT, T_INT], result: T_INT };
      return b;
    };
    put("add_int", intAdd("add_int"));
    put("add", intAdd("add"));
    return root;
  }

  evalModuleBlock(node, env) {
    const e = new Env(env);
    this.declareShape(node.shape, e);
    // The paren head declares names in scope. The module's value is what its
    // body evaluates to (see O32: input vs result declaration is still open).
    return this.evalStmts(node.body.stmts, e);
  }

  declareShape(shape, env) {
    for (const f of shape.fields) env.declare(f.name, { type: f.type });
  }

  shapeValue(shape, env) {
    const fields = shape.fields;
    if (fields.length === 0) return UNIT;
    if (fields.length === 1) return env.get(fields[0].name);
    return vTuple(fields.map((f) => env.get(f.name)), fields.map((f) => f.name));
  }

  evalStmts(stmts, env) {
    let last = UNIT;
    for (const s of stmts) last = this.evalStmt(s, env);
    return last;
  }

  // ---- statements -----------------------------------------------------

  evalStmt(node, env) {
    switch (node.k) {
      case "ascribe": return this.evalAscribe(node, env);
      case "def": return this.evalDef(node, env);
      case "defPath": return this.evalDefPath(node, env);
      case "expr": return this.evalExpr(node.e, env);
      case "directive": return this.evalDirective(node, env);
      default: fail(`cannot evaluate statement ${node.k}`);
    }
  }

  evalDirective(node, env) {
    if (node.what === "self") {
      const name = node.arg && node.arg.k === "name" ? node.arg.v : null;
      if (!name) fail("\\self expects a name");
      const cell = env.vars.get("self");
      if (cell) { env.vars.delete("self"); env.vars.set(name, cell); }
      return UNIT;
    }
    if (node.what === "print") {
      const v = node.arg ? this.evalExpr(node.arg, env) : vStr("");
      this.out.push(this.text(v) + "\n");
      return UNIT;
    }
    fail(`unknown directive \\${node.what}`);
  }

  evalAscribe(node, env) {
    if (node.display !== undefined) {
      return node.ctors ? this.evalVariantType(node, env) : this.evalRecordType(node, env);
    }

    const sig = { params: node.params, result: node.result, packed: !!node.packed };
    const existing = env.find(node.name);
    const cell = env.declare(node.name, sig);
    // re-declaring a builtin (e.g. `add_int: [int] [int] int;`) keeps its value
    if (existing && existing.builtin && existing.set) { cell.value = existing.value; cell.set = true; }

    if (node.body) {
      const fn = this.makeFunction(node.name, null, node.body, env, sig);
      const table = this.makeTable(node.name, fn, sig);
      cell.value = table; cell.set = true;
      return table;
    }
    return UNIT;
  }

  evalRecordType(node, env) {
    const fields = node.params
      .filter((p) => p && p.name)
      .map((p) => ({ name: p.name, type: p.type }));
    const type = {
      k: "type", name: node.name, args: [], fields,
      display: node.display, holes: node.holes,
    };
    const cell = env.declare(node.name);
    cell.value = type; cell.set = true;
    return type;
  }

  evalVariantType(node, env) {
    const def = {
      name: node.name,
      params: node.params,
      display: node.display,
      holes: node.holes,
      ctors: node.ctors,
      user: true,
    };

    // builtin display override (e.g. bool: ... => (false: `F`; true: `T`))
    if (["int", "float", "string", "bool", "void"].includes(node.name)) {
      this.typeDefs.set(node.name, def);
      if (node.name === "bool") {
        const ctors = new Map();
        for (const c of node.ctors) {
          if (c.name === "true") ctors.set(true, c.display);
          if (c.name === "false") ctors.set(false, c.display);
        }
        this.boolDisplay = { def, ctors };
      }
      return env.get(node.name);
    }

    const type = vType(node.name, [], def);
    def.type = type;
    type.ctors = [];
    const cell = env.declare(node.name);
    cell.value = type; cell.set = true;

    for (const c of node.ctors) {
      const ctor = this.makeCtor(def, c, env);
      const cc = env.declare(c.name);
      cc.value = ctor; cc.set = true;
      type.ctors.push(ctor);
    }
    if (type.ctors.length === 1) type.singleCtor = type.ctors[0];
    return type;
  }

  makeCtor(def, ctorNode, closureEnv) {
    const arity = ctorNode.params.length;
    return {
      k: "fn",
      name: ctorNode.name,
      arity,
      autoCall: arity === 0,
      ctorOf: def.name,
      paramNames: ctorNode.params.map((p) => (p ? p.name : null)),
      template: ctorNode.display,
      holes: ctorNode.holes || [],
      call(args) {
        const fields = new Map();
        ctorNode.params.forEach((p, i) => {
          if (p && p.name) {
            const c = new Cell();
            c.value = args[i]; c.set = true;
            fields.set(p.name, c);
          }
        });
        return vRecord({
          type: def.type,
          ctor: ctorNode.name,
          args,
          fields,
          public: new Set((ctorNode.holes || []).map((h) => h.name)),
          template: ctorNode.display,
        });
      },
    };
  }

  evalDisplayed(node, env) {                 // name: params `template` { body }
    const arity = node.params.length;
    const self = this;
    const type = mkType(node.name, { builtin: true, anonymous: true });
    const fn = {
      k: "fn",
      name: node.name,
      arity,
      autoCall: arity === 0,
      call(args) {
        const e = new Env(env);
        node.params.forEach((p, i) => {
          if (p.name) { const c = e.declare(p.name); c.value = args[i]; c.set = true; }
        });
        for (const h of node.holes || []) if (h.type && !e.has(h.name)) e.declare(h.name);
        self.evalStmts(node.body.stmts, e);
        const fields = new Map(e.vars);
        return vRecord({
          type,
          ctor: node.name,
          args,
          fields,
          public: new Set((node.holes || []).map((h) => h.name)),
          template: node.display,
        });
      },
    };
    const cell = env.declare(node.name);
    cell.value = fn; cell.set = true;
    return fn;
  }

  evalDef(node, env) {
    // headless: cast ($[T] <- e) or pattern binding ($(p) <- e)
    if (!node.name) {
      if (node.keys.length === 1 && node.keys[0].k === "keySlot") {
        const v = this.evalRhsValue(node.rhs, env);
        const t = node.keys[0].type ? this.evalTypeNode(node.keys[0].type, env) : null;
        return this.cast(t, v);
      }
      const v = this.evalRhsValue(node.rhs, env);
      const binds = new Map();
      for (const key of node.keys) {
        const s = this.matchKey(key, v, binds, env);
        if (s < 0) fail("pattern binding did not match");
      }
      for (const [n, val] of binds) {
        const c = env.declare(n);
        c.value = val; c.set = true;
      }
      return v;
    }

    if (node.keys.length > 0) return this.addClause(node, env);

    // $name <- rhs
    const sig = env.sigOf(node.name) || null;
    const rhs = node.rhs;
    const isFn = rhs.binders.length > 0 || rhs.body.k === "block";
    if (!isFn) {
      const v = this.evalExpr(rhs.body, env);
      env.assign(node.name, v);
      return v;
    }

    const binders = rhs.binders.length > 0 ? rhs.binders : null;
    const fn = this.makeFunction(node.name, binders, rhs.body, env, sig);
    const table = this.makeTable(node.name, fn, sig);
    env.assign(node.name, table);
    return table;
  }

  makeFunction(name, binders, body, closure, sig) {
    const params = binders || (sig ? sig.params : []);
    const arity = params.length;
    const self = this;
    return {
      k: "fn",
      name,
      arity,
      paramNames: params.map((p) => (p ? p.name : null)),
      call(args) {
        const env = new Env(closure);
        params.forEach((p, i) => {
          if (p && p.name) { const c = env.declare(p.name); c.value = args[i]; c.set = true; }
        });
        let result;
        if (body.k === "block") result = self.evalBody(body, env, sig);
        else result = self.evalExpr(body, env);
        if (sig && sig.packed) result = vPacked(typeOf(result), result);
        return result;
      },
    };
  }

  // A body brace: bind `self`, honour a leading \self directive, return its value.
  evalBody(block, env, sig) {
    const resultNode = sig ? sig.result : null;
    const cell = this.bindSelf(env, resultNode);
    let stmts = block.stmts;
    let selfName = "self";
    if (stmts[0] && stmts[0].k === "directive" && stmts[0].what === "self") {
      const arg = stmts[0].arg;
      if (arg && arg.k === "name") selfName = arg.v;
      env.vars.delete("self");
      env.vars.set(selfName, cell);
      stmts = stmts.slice(1);
    }
    this.evalStmts(stmts, env);
    if (cell.set) return cell.value;
    if (!resultNode || resultNode.k === "unit" || resultNode.k === "infer") return UNIT;
    fail(`'${selfName}' has not been assigned`);
  }

  bindSelf(env, resultNode) {
    const cell = env.declare("self");
    if (!resultNode) return cell;

    if (resultNode.k === "unit" || resultNode.k === "infer") {
      cell.value = UNIT; cell.set = true;
      return cell;
    }

    const t = this.evalTypeNode(resultNode, env);
    if (t.k === "type" && t.fields) {
      cell.value = this.freshRecord(t);
      cell.set = true;
      return cell;
    }
    if (t.k === "type" && t.singleCtor) {
      cell.value = this.freshRecordFromCtor(t, t.singleCtor);
      cell.set = true;
      return cell;
    }
    return cell;              // scalar: unset until assigned
  }

  freshRecord(type) {
    const fields = new Map();
    for (const f of type.fields) fields.set(f.name, new Cell());
    return vRecord({
      type,
      ctor: type.name,
      args: [],
      fields,
      public: new Set((type.holes || []).map((h) => h.name)),
      template: type.display,
    });
  }

  freshRecordFromCtor(type, ctor) {
    const fields = new Map();
    for (const n of ctor.paramNames || []) if (n) fields.set(n, new Cell());
    return vRecord({
      type,
      ctor: ctor.name,
      args: [],
      fields,
      public: new Set(ctor.holes || []),
      template: ctor.template,
    });
  }

  makeTable(name, fallback, sig) {
    const params = sig ? sig.params : [];
    return {
      k: "table",
      name,
      arity: params.length,
      paramNames: params.map((p) => (p ? p.name : null)),
      clauses: [],
      fallback,
      sig,
    };
  }

  addClause(node, env) {
    const cell = env.find(node.name);
    if (!cell) fail(`'${node.name}' is not declared`);
    let table = cell.set ? cell.value : null;
    if (!table) {
      const sig = cell.sig;
      const fn = { k: "fn", name: node.name, arity: sig ? sig.params.length : node.keys.length, call() { fail(`'${node.name}' has no body`); } };
      table = this.makeTable(node.name, fn, sig);
      cell.value = table; cell.set = true;
    }
    if (table.k !== "table") fail(`'${node.name}' cannot take keys`);
    table.clauses.push({ keys: node.keys, rhs: node.rhs, env });
    return table;
  }

  evalDefPath(node, env) {
    const target = node.target;
    let base = target;
    while (base.k === "proj") base = base.base;
    if (base.k !== "name") fail("assignment target must be a field path");
    const obj = env.get(base.v);
    if (obj.k !== "record") fail("field assignment on a non-record");
    let rec = obj;
    for (let n = target; n.k === "proj" && n !== target.base; n = n.base) { /* noop */ }
    // walk the projections except the last
    const chain = [];
    for (let n = target; n.k === "proj"; n = n.base) chain.unshift(n.field);
    let cur = obj;
    for (let i = 0; i < chain.length - 1; i++) {
      cur = this.getField(cur, chain[i]);
      if (cur.k !== "record") fail("nested assignment on a non-record");
    }
    const value = this.evalRhsAsValue(node.rhs, env);
    this.setField(cur, chain[chain.length - 1], value);
    return value;
  }

  // ---- right-hand sides ----------------------------------------------

  evalRhsValue(rhs, env) {
    if (rhs.binders.length) fail("expected a value, got a function");
    return this.evalExpr(rhs.body, env);
  }

  // A value or a lambda, for field assignment and similar.
  evalRhsAsValue(rhs, env) {
    const isFn = rhs.binders.length > 0 || rhs.body.k === "block";
    if (!isFn) return this.evalExpr(rhs.body, env);
    const binders = rhs.binders.length > 0 ? rhs.binders : null;
    return this.makeFunction(null, binders, rhs.body, env, null);
  }

  // ---- expressions ----------------------------------------------------

  evalExpr(node, env) {
    switch (node.k) {
      case "num": return vNum(node.v);
      case "str": return vStr(node.v);
      case "lit": return vStr(node.v);
      case "unit": return UNIT;
      case "name": {
        const v = env.get(node.v);
        return (v.k === "fn" && v.autoCall) ? this.applyValue(v, [], env) : v;
      }
      case "app": {
        const callee = this.evalExpr(node.head, env);
        const args = node.args.map((a) => this.evalExpr(a, env));
        return this.applyValue(callee, args, env, node.head);
      }
      case "proj": {
        const base = this.evalExpr(node.base, env);
        return this.getField(base, node.field);
      }
      case "tuple": return vTuple(node.items.map((x) => this.evalExpr(x, env)));
      case "pair": return vPacked(this.evalExpr(node.l, env), this.evalExpr(node.r, env));
      case "bin": return this.evalBin(node, env);
      case "un": return this.evalUn(node, env);
      case "define": return this.evalDef(node, env);
      case "namedApp": return this.evalNamedApp(node, env);
      default: fail(`cannot evaluate expression ${node.k}`);
    }
  }

  evalNamedApp(node, env) {
    const callee = this.evalExpr(node.callee, env);
    const e = new Env(env);
    for (const a of node.args) {
      const v = this.evalExpr(a.value, e);
      const c = e.declare(a.name); c.value = v; c.set = true;
    }

    // record construction: T { $field <- value; ... }
    if (callee.k === "type" && callee.fields) {
      const rec = this.freshRecord(callee);
      for (const a of node.args) this.setField(rec, a.name, e.get(a.name));
      return rec;
    }
    if (callee.k === "type" && callee.singleCtor) {
      return this.applyNamed(callee.singleCtor, node.args, e, env);
    }
    return this.applyNamed(callee, node.args, e, env);
  }

  applyNamed(callee, args, argEnv, callEnv) {
    const names = this.paramNamesOf(callee);
    if (!names) fail(`this value does not take named arguments: ${this.display(callee)}`);
    const sig = callee.sig;

    const missing = [];
    names.forEach((n, i) => { if (!(n && argEnv.has(n))) missing.push(i); });

    let values;
    if (missing.length === 0) {
      values = names.map((n) => argEnv.get(n));
    } else {
      if (!sig) fail(`missing named argument for '${callee.name || "call"}'`);
      const typeParams = new Set();
      for (const p of sig.params) if (p && p.name && isTypeParamType(p.type)) typeParams.add(p.name);

      const subst = new Map();
      // unify the supplied value arguments' types against the declared types
      sig.params.forEach((p) => {
        if (!p || !p.name || !argEnv.has(p.name) || !p.type) return;
        this.solveType(p.type, typeOf(argEnv.get(p.name)), subst, typeParams);
      });

      values = names.map((n, i) => {
        if (n && argEnv.has(n)) return argEnv.get(n);
        if (!sig.params[i] || !typeParams.has(n)) fail(`missing named argument '${n}'`);
        if (!subst.has(n)) fail(`cannot deduce '${n}'`);
        return subst.get(n);
      });
    }
    return this.applyValue(callee, values, callEnv);
  }

  // Unify a declared parameter type (an AST with type variables) against a
  // runtime type, filling `subst` for the type parameters.
  solveType(ast, rt, subst, typeParams) {
    if (!ast) return true;
    if (ast.k === "kType") return true;

    if (ast.k === "typeName") {
      if (typeParams.has(ast.name)) {
        if (!subst.has(ast.name)) { subst.set(ast.name, rt); return true; }
        return typeEq(subst.get(ast.name), rt);
      }
      return rt.k === "type" && rt.name === ast.name;
    }

    if (ast.k === "typeApp") {
      if (rt.k !== "type") return false;
      const head = ast.head;
      if (head.k === "typeName" && typeParams.has(head.name)) {
        if (!subst.has(head.name)) subst.set(head.name, mkType(rt.name));
        else if (subst.get(head.name).name !== rt.name) return false;
      } else if (head.k === "typeName") {
        if (rt.name !== head.name) return false;
      }
      if (rt.args.length !== ast.args.length) return true; // partial information
      for (let i = 0; i < ast.args.length; i++) {
        const a = ast.args[i];
        const inner = a.k === "typeArg" ? a.type : a;
        if (!this.solveType(inner, rt.args[i], subst, typeParams)) return false;
      }
      return true;
    }

    if (ast.k === "fnType") {
      if (rt.k !== "type" || !rt.params || !rt.result) return false;
      if (rt.params.length !== ast.params.length) return false;
      for (let i = 0; i < ast.params.length; i++) {
        if (!this.solveType(ast.params[i], rt.params[i], subst, typeParams)) return false;
      }
      return this.solveType(ast.result, rt.result, subst, typeParams);
    }

    if (ast.k === "unit") return rt.k === "type" && rt.name === "()";
    return true;
  }

  paramNamesOf(v) {
    if (v.k === "partial") {
      const all = this.paramNamesOf(v.target);
      return all ? all.slice(v.args.length) : null;
    }
    if (v.k === "builtin") return v.params;
    if (v.k === "fn") return v.paramNames || null;
    if (v.k === "table") return v.paramNames || (v.sig ? v.sig.params.map((p) => p && p.name) : null);
    return null;
  }

  applyValue(callee, args, env, calleeNode) {
    // partial application / oversaturation
    if (callee.k === "partial") {
      return this.applyValue(callee.target, [...callee.args, ...args], env, callee.node || calleeNode);
    }
    const knownArity =
      callee.k === "builtin" || callee.k === "fn" || callee.k === "table" ? callee.arity : null;
    if (knownArity != null && args.length < knownArity) {
      return { k: "partial", target: callee, args, node: calleeNode };
    }
    if (knownArity != null && args.length > knownArity) {
      const head = this.applyValue(callee, args.slice(0, knownArity), env, calleeNode);
      return this.applyValue(head, args.slice(knownArity), env);
    }

    if (callee.k === "builtin") {
      if (callee.arity >= 0 && args.length !== callee.arity) fail(`${callee.name} expects ${callee.arity} argument(s)`);
      return callee.apply(args, env);
    }
    if (callee.k === "table") return this.callTable(callee, args, env);
    if (callee.k === "fn") {
      if (args.length !== callee.arity) fail(`'${callee.name || "function"}' expects ${callee.arity} argument(s), got ${args.length}`);
      return callee.call(args, env);
    }
    if (callee.k === "type") {
      const prepared = this.prepareArgs(env.sigOf(calleeNode && calleeNode.v), args);
      return this.applyType(callee, prepared, env);
    }
    fail(`not callable: ${this.display(callee)}`);
  }

  prepareArgs(sig, args) {
    if (!sig || !sig.params) return args;
    return args.map((a, i) => {
      const p = sig.params[i];
      const t = p && p.type;
      if (t && t.k === "unaryPair") return vPacked(typeOf(a), a);
      return a;
    });
  }

  // Match one clause against the prepared argument list.
  // Positional clauses need one key per argument. A clause containing
  // `$name <- pattern` group entries is matched by parameter name instead:
  // plain keys fill parameters in order, named keys by name, and unmentioned
  // parameters are unconstrained (but still bound for the body).
  matchClause(cl, args, table) {
    const binds = new Map();
    let score = 0;
    const named = cl.keys.some((k) => k.k === "keyBound");

    if (!named) {
      if (cl.keys.length !== args.length) return { ok: false };
      for (let i = 0; i < cl.keys.length; i++) {
        const s = this.matchKey(cl.keys[i], args[i], binds, cl.env);
        if (s < 0) return { ok: false };
        score += s;
      }
      return { ok: true, score, binds };
    }

    for (let i = 0; i < table.paramNames.length && i < args.length; i++) {
      const n = table.paramNames[i];
      if (n) binds.set(n, args[i]);
    }

    let pos = 0;
    for (const key of cl.keys) {
      let idx;
      if (key.k === "keyBound") {
        idx = table.paramNames.indexOf(key.name);
        if (idx < 0) return { ok: false };
      } else {
        idx = pos++;
      }
      if (idx >= args.length) return { ok: false };
      const pat = key.k === "keyBound" ? key.key : key;
      const s = this.matchKey(pat, args[idx], binds, cl.env);
      if (s < 0) return { ok: false };
      score += s;
    }
    return { ok: true, score, binds };
  }

  callTable(table, args, env) {
    const prepared = this.prepareArgs(table.sig, args);
    let best = null;
    for (const cl of table.clauses) {
      const m = this.matchClause(cl, prepared, table);
      if (!m.ok) continue;
      if (!best || m.score > best.score) best = { cl, binds: m.binds, score: m.score };
      else if (m.score === best.score) fail(`ambiguous keys for '${table.name}'`);
    }
    if (best) {
      const e = new Env(best.cl.env);
      for (const [n, v] of best.binds) { const c = e.declare(n); c.value = v; c.set = true; }
      const rhs = best.cl.rhs;
      let result;
      if (rhs.body.k === "block") result = this.evalBody(rhs.body, e, table.sig);
      else result = this.evalExpr(rhs.body, e);
      if (table.sig && table.sig.packed) result = vPacked(typeOf(result), result);
      return result;
    }
    if (table.fallback) return table.fallback.call(prepared, env);
    fail(`no key matches the call to '${table.name}' and it has no body`);
  }

  applyType(type, args, env) {
    const def = type.def || this.typeDefs.get(type.name);
    if (def && def.params && def.params.length) return vType(type.name, args, def);
    if (args.length === 0) return type;
    fail(`type '${type.name}' does not take arguments`);
  }

  // ---- patterns -------------------------------------------------------

  matchKey(key, value, binds, env) {
    if (key.k === "keySlot") return this.matchSlot(key, value, binds, env);
    return this.matchPat(key.p, value, binds, env);
  }

  matchSlot(slot, value, binds, env) {
    const t = slot.type;
    if (slot.name) { binds.set(slot.name, value); return 1; }
    if (!t) return 1;
    if (t.k === "kType") return value.k === "type" ? 1 : -1;
    if (t.k === "typeArgBinder") return 1;
    return this.matchTypePat(t, value, binds) ? 3 : -1;
  }

  matchPat(node, value, binds, env) {
    switch (node.k) {
      case "num": return value.k === "num" && value.v === node.v ? 3 : -1;
      case "str": return value.k === "str" && value.v === node.v ? 3 : -1;
      case "lit": return value.k === "str" && value.v === node.v ? 3 : -1;
      case "wild": return 0;
      case "binder": {
        if (node.name) binds.set(node.name, value);
        return 1;
      }
      case "hole": {
        const t = node.type;
        if (node.name) { binds.set(node.name, value); return 1; }
        if (!t) return 1;
        if (t.k === "kType") return value.k === "type" ? 1 : -1;
        return this.matchTypePat(t, value, binds) ? 3 : -1;
      }
      case "name": {
        if (value.k === "bool" && (node.v === "true" || node.v === "false")) {
          return value.v === (node.v === "true") ? 3 : -1;
        }
        if (value.k === "type") return value.name === node.v && value.args.length === 0 ? 3 : -1;
        if (value.k === "record") return value.ctor === node.v && value.args.length === 0 ? 2 : -1;
        return -1;
      }
      case "app": {
        if (node.head.k !== "name" || value.k !== "record") return -1;
        if (value.ctor !== node.head.v || value.args.length !== node.args.length) return -1;
        let score = 2;
        for (let i = 0; i < node.args.length; i++) {
          const s = this.matchPat(node.args[i], value.args[i], binds, env);
          if (s < 0) return -1;
          score += s;
        }
        return score;
      }
      case "pair": {
        if (value.k !== "packed") return -1;
        const tagOk = node.l.k === "wild"
          ? true
          : (node.l.k === "name" ? typeEq(value.type, this.typeByName(node.l.v, env)) : this.matchTypePat(node.l, value.type, binds));
        if (!tagOk) return -1;
        const s = this.matchPat(node.r, value.value, binds, env);
        return s < 0 ? -1 : 3 + s;
      }
      case "tuple": {
        if (value.k !== "tuple" || value.items.length !== node.items.length) return -1;
        let score = 2;
        for (let i = 0; i < node.items.length; i++) {
          const s = this.matchPat(node.items[i], value.items[i], binds, env);
          if (s < 0) return -1;
          score += s;
        }
        return score;
      }
      default: return -1;
    }
  }

  typeByName(name, env) {
    const c = env.find(name);
    if (!c || !c.set) return mkType(name);
    return c.value;
  }

  matchTypePat(node, typeVal, binds) {
    if (typeVal.k !== "type") return false;
    switch (node.k) {
      case "kType": return true;
      case "typeName": return typeVal.name === node.name && typeVal.args.length === 0;
      case "typeApp": {
        if (node.head.k !== "typeName" || typeVal.name !== node.head.name) return false;
        if (typeVal.args.length !== node.args.length) return false;
        for (let i = 0; i < node.args.length; i++) {
          const a = node.args[i];
          if (a.k === "typeArgBinder" || a.k === "typePattern") {
            if (a.name) binds.set(a.name, typeVal.args[i]);
          } else if (a.k === "typeArg") {
            if (!this.matchTypePat(a.type, typeVal.args[i], binds)) return false;
          } else return false;
        }
        return true;
      }
      default: return false;
    }
  }

  evalTypeNode(node, env) {
    switch (node.k) {
      case "typeName": {
        const c = env.find(node.name);
        if (c && c.set && c.value.k === "type") return c.value;
        return mkType(node.name);
      }
      case "kType": return T_KIND;
      case "unit": return T_UNIT;
      case "product": return mkType("(,)", { args: node.items.map((x) => this.evalTypeNode(x, env)) });
      case "fnType": return mkType("->", { args: [...node.params.map((p) => this.evalTypeNode(p, env)), this.evalTypeNode(node.result, env)] });
      case "typeApp": {
        const head = this.evalTypeNode(node.head, env);
        const args = node.args.map((a) => {
          if (a.k === "typeArg") return this.evalTypeNode(a.type, env);
          if (a.k === "typeStr") return vStr(a.v);
          if (a.k === "typeNum") return vNum(a.v);
          return T_KIND;
        });
        if (head.k === "type") return this.applyType(head, args, env);
        return this.applyValue(head, args, env);
      }
      case "typeArg": return this.evalTypeNode(node.type, env);
      default: return T_KIND;
    }
  }

  cast(type, value) {
    return value;
  }

  // ---- records and fields --------------------------------------------

  getField(rec, name) {
    if (rec.k !== "record") fail(`cannot select .${name} on ${this.display(rec)}`);
    if (rec.public && rec.public.size && !rec.public.has(name)) fail(`.'${name}' is not public`);
    const cell = rec.fields && rec.fields.get(name);
    if (!cell) fail(`record has no field '${name}'`);
    if (!cell.set) fail(`field '${name}' has not been assigned`);
    const v = cell.value;
    return (v.k === "fn" && v.autoCall) ? this.applyValue(v, []) : v;
  }

  setField(rec, name, value) {
    if (rec.k !== "record") fail(`cannot assign .${name} on ${this.display(rec)}`);
    if (rec.public && rec.public.size && !rec.public.has(name)) fail(`.'${name}' is not public`);
    let cell = rec.fields && rec.fields.get(name);
    if (!cell) { cell = new Cell(); rec.fields.set(name, cell); }
    cell.value = value; cell.set = true;
  }

  // ---- operators ------------------------------------------------------

  evalBin(node, env) {
    if (node.op === "&&") {
      const l = this.asBool(this.evalExpr(node.l, env));
      return l ? this.evalExpr(node.r, env) : vBool(false);
    }
    if (node.op === "||") {
      const l = this.asBool(this.evalExpr(node.l, env));
      return l ? vBool(true) : this.evalExpr(node.r, env);
    }
    const l = this.evalExpr(node.l, env);
    const r = this.evalExpr(node.r, env);
    switch (node.op) {
      case "==": return vBool(this.equal(l, r));
      case "!=": return vBool(!this.equal(l, r));
      case "<": case ">": case "<=": case ">=": {
        const a = this.comparable(l), b = this.comparable(r);
        if (node.op === "<") return vBool(a < b);
        if (node.op === ">") return vBool(a > b);
        if (node.op === "<=") return vBool(a <= b);
        return vBool(a >= b);
      }
      default: fail(`unknown operator ${node.op}`);
    }
  }

  asBool(v) {
    if (v.k !== "bool") fail(`expected a bool, got ${this.display(v)}`);
    return v.v;
  }

  comparable(v) {
    if (v.k === "num" || v.k === "str") return v.v;
    fail(`cannot compare ${this.display(v)}`);
  }

  equal(a, b) {
    if (a.k !== b.k) return false;
    switch (a.k) {
      case "num": case "str": case "bool": return a.v === b.v;
      case "unit": return true;
      case "type": return typeEq(a, b);
      default: return a === b;
    }
  }

  evalUn(node, env) {
    if (node.op === "!") return vBool(!this.asBool(this.evalExpr(node.e, env)));
    fail(`unknown prefix operator ${node.op}`);
  }
}
