// Rhyme2 — evaluator for syntax v3.
// No static checker; types are values, output happens at the end of a module.

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
const T_TOP = mkType("?", { builtin: true, top: true });
const T_KIND = T_TOP; // legacy name: `?` is the top type in v4
const T_FN = mkType("fn", { builtin: true });

let typeVarSeq = 0;
const vTypeVar = (name = null) => ({
  k: "type", name: name ? "@" + name : "@?", args: [], var: true,
  id: ++typeVarSeq, solved: false, bound: null, anon: name == null,
});

const vNum = (n) => ({ k: "num", v: Number(n) });
const vStr = (s) => ({ k: "str", v: s });
const vBool = (b) => ({ k: "bool", v: !!b });
const vTuple = (items, names = null) => ({ k: "tuple", items, names });
const vPacked = (type, value) => ({ k: "packed", type, value });
const vType = (name, args, def) => ({ k: "type", name, args, def, builtin: false });
const vRecord = (o) => ({ k: "record", ...o });
const builtin = (name, arity, apply, params = null) => ({ k: "builtin", name, arity, apply, params });

class Cell {
  constructor(sig = null) {
    this.value = undefined;
    this.set = false;
    this.sig = sig;
    this.output = null;
    this.type = null;        // declared type AST (v4)
    this.typeValue = null;   // resolved type, if any
    this.default = null;     // default value (shared)
    this.defaultThunk = null;// default thunk (fresh)
    this.typeAlias = null;   // { type, default } for typed constants
    this.constant = false;   // display-literal names are constants
    this.kind = null;        // "type" | "ctor"
  }
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
    if (!c) fail(`'${name}' is not declared`);
    if (c.constant) fail(`'${name}' is a constant (type/constructor); it cannot be assigned`);
    c.value = value;
    c.set = true;
    if (c.output && c.log) c.log.push(value);
    return c;
  }
  sigOf(name) { const c = this.find(name); return c ? c.sig : null; }
}

function typeOf(v) {
  switch (v.k) {
    case "num": return Number.isInteger(v.v) ? T_INT : T_FLOAT;
    case "str": return T_STRING;
    case "bool": return T_BOOL;
    case "unit": return T_UNIT;
    case "type": return T_TOP;
    case "record": return v.type || mkType("record");
    case "tuple": return mkType("(,)", { args: v.items.map(typeOf) });
    case "packed": return v.type;
    case "fn": case "builtin": return T_FN;
    case "partial": {
      const t = v.target && v.target.type;
      if (t) return { k: "type", name: "->", params: t.params.slice(v.args.length), result: t.result };
      return T_FN;
    }
    default: return T_TOP;
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
    return t.params.every((p) => (p.k === "namedType" ? p.type.k === "kType" : p.k === "kType"))
      && t.result.k === "kType";
  }
  return false;
}

// `#!/bin/rhyme --output name:path ...`
export function parseShebang(source) {
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const first = source.split(/\r?\n/, 1)[0] || "";
  const outputs = [];
  if (!first.startsWith("#!")) return { outputs };
  const parts = first.slice(2).trim().split(/\s+/).slice(1);
  for (let i = 0; i < parts.length; i++) {
    let spec = null;
    if (parts[i] === "--output") spec = parts[++i];
    else if (parts[i].startsWith("--output=")) spec = parts[i].slice("--output=".length);
    if (!spec) continue;
    const c = spec.indexOf(":");
    if (c <= 0) fail(`bad --output: ${spec}`);
    outputs.push({ name: spec.slice(0, c), path: spec.slice(c + 1) });
  }
  return { outputs };
}

export function run(source, opts = {}) {
  const { outputs } = parseShebang(source);
  const tree = parse(source);
  const ev = new Evaluator(outputs);
  try {
    ev.runModule(tree);
    return ev.finish();
  } catch (e) {
    const r = ev.renderOutputs();
    e.stdout = r.stdout;
    e.writes = r.writes;
    throw e;
  }
}

class Evaluator {
  constructor(outputs = []) {
    this.sinks = [];
    this.typeDefs = new Map();
    this.boolDisplay = null;
    this.outputSpecs = outputs;
  }

  // ---- display --------------------------------------------------------

  text(v) {
    if (v.k === "str") return v.v;
    return this.display(v);
  }

  display(v) {
    switch (v.k) {
      case "num": return String(v.v);
      case "str": return JSON.stringify(v.v);
      case "bool": return this.displayBool(v.v);
      case "unit": return "()";
      case "type": return this.displayType(v);
      case "fn": case "builtin": case "partial": case "table": return "<fn>";
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
    if (t.top || t.name === "?") return "?";
    if (t.var) return t.solved && t.bound ? this.displayType(t.bound) : t.name;
    const def = t.def || this.typeDefs.get(t.name);
    const display = t.display !== undefined ? t.display : (def && def.display);
    const params = t.typeParams || (def && def.params) || [];
    if (!t.args || t.args.length === 0) return t.name;
    if (display !== undefined) {
      const names = params.map((p) => p && p.name);
      const rendered = this.render(display, (name) => {
        const i = names.indexOf(name);
        if (i >= 0 && t.args[i]) return this.displayType(t.args[i]);
        return "";
      });
      if (rendered !== "") return rendered;
    }
    return t.name + " " + t.args.map((a) => this.displayType(a)).join(" ");
  }

  displayRecord(r) {
    if (r.template == null) return r.ctor || "<record>";
    const typeParams = (r.type && r.type.typeParams) || [];
    const typeArgs = (r.type && r.type.args) || [];
    const lookup = (name) => {
      const ti = typeParams.findIndex((p) => p && p.name === name);
      if (ti >= 0) return typeArgs[ti] ? this.displayType(typeArgs[ti]) : "";
      const cell = r.fields && r.fields.get(name);
      if (!cell || !cell.set) return "";
      return this.display(cell.value);
    };
    return this.render(r.template, lookup);
  }

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
        out += lookup(inner.split(":")[0].trim());
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
    this.declareOutput("stdout", null, env);
    for (const o of this.outputSpecs) this.declareOutput(o.name, o.path, env);
    for (const s of tree.body) this.evalStmt(s, env);
  }

  declareOutput(name, path, env) {
    if (env.vars.has(name)) return;
    const cell = env.declare(name);
    cell.output = { path };
    cell.log = [];
    cell.type = { k: "kType" };
    cell.typeValue = T_TOP;
    this.sinks.push({ name, cell });
  }

  finish() {
    const { stdout, writes } = this.renderOutputs();
    return { value: UNIT, stdout, writes };
  }

  renderOutputs() {
    const stdout = [];
    const writes = [];
    for (const { cell } of this.sinks) {
      for (const value of cell.log) {
        const line = this.display(value) + "\n";
        if (cell.output.path == null) stdout.push(line);
        else writes.push({ path: cell.output.path, text: line });
      }
    }
    return { stdout: stdout.join(""), writes };
  }

  installBuiltins(root) {
    const put = (name, value, opts = {}) => {
      const c = root.declare(name);
      c.value = value;
      c.set = true;
      c.builtin = true;
      if (opts.constant) c.constant = true;
      if (opts.kind) c.kind = opts.kind;
    };
    put("int", T_INT, { constant: true, kind: "type" });
    put("float", T_FLOAT, { constant: true, kind: "type" });
    put("string", T_STRING, { constant: true, kind: "type" });
    put("bool", T_BOOL, { constant: true, kind: "type" });
    put("void", T_VOID, { constant: true, kind: "type" });
    put("true", vBool(true), { constant: true, kind: "ctor" });
    put("false", vBool(false), { constant: true, kind: "ctor" });
    put("to_string", builtin("to_string", 1, (args) => vStr(this.text(args[0])), ["x"]));
    const printer = (name) => builtin(name, 1, (args) => vStr(this.text(args[0])), ["x"]);
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

  // ---- statements -----------------------------------------------------

  evalStmt(node, env) {
    switch (node.k) {
      case "ascribe": return this.evalAscribe(node, env);
      case "def": return this.evalDef(node, env);
      case "defPath": return this.evalDefPath(node, env);
      case "expr": return this.evalExpr(node.e, env);
      default: fail(`cannot evaluate statement ${node.k}`);
    }
  }

  evalAscribe(node, env) {
    if (node.dynamic) {
      if (!env.find(node.name)) env.declare(node.name);
      return UNIT;
    }
    if (node.display !== undefined) {
      return node.ctors ? this.evalVariantType(node, env) : this.evalRecordType(node, env);
    }

    const existing = env.find(node.name);
    const sig = { params: node.params, result: node.result, value: !!node.value };
    const typeValue = node.result ? this.evalTypeNode(node.result, env) : T_TOP;

    // An output sink is declared by the shebang / stdout; an ascription narrows it.
    if (existing && existing.output) {
      existing.type = node.result;
      existing.typeValue = typeValue;
      return UNIT;
    }

    const cell = env.declare(node.name, sig);
    cell.type = node.result;
    cell.typeValue = typeValue;
    if (existing && existing.builtin && existing.set) { cell.value = existing.value; cell.set = true; }

    if (node.value) {
      if (node.default) {
        const d = this.evalExpr(node.default, env);
        cell.default = d;
        cell.defaultThunk = () => this.evalExpr(node.default, env);
        this.checkCell(cell, d);
        cell.value = d; cell.set = true;
        cell.typeAlias = { type: typeValue, default: d, thunk: cell.defaultThunk };
      }
      return UNIT;
    }

    if (!node.value) {
      // validate the syntactic type expressions now (dependent type positions
      // and value names in type positions are rejected here)
      for (const p of node.params) {
        if (p.k !== "typeParam" && p.type) this.evalTypeNode(p.type, env);
      }
      if (node.result) this.evalTypeNode(node.result, env);
    }

    if (node.body) {
      const v = this.evalNamedBody(node.name, node.params, node.body, env, sig);
      cell.value = v; cell.set = true;
      return v;
    }
    if (node.default) {
      const typeParams = node.params.filter((p) => p.k === "typeParam");
      const valueParams = node.params.filter((p) => p.k !== "typeParam");
      if (valueParams.length === 0 && typeParams.length > 0) {
        const fn = {
          k: "typeAliasFn",
          name: node.name,
          typeParams,
          resultAst: node.result,
          defaultAst: node.default,
          env,
        };
        cell.value = fn; cell.set = true;
        cell.typeAliasFn = fn;
      } else {
        const d = this.evalExpr(node.default, env);
        cell.default = d;
        cell.defaultThunk = () => this.evalExpr(node.default, env);
        this.checkCell(cell, d);
        cell.value = d; cell.set = true;
        cell.typeAlias = { type: typeValue, default: d, thunk: cell.defaultThunk };
      }
    }
    return UNIT;
  }

  evalNamedBody(name, params, body, env, sig) {
    if (body.k === "alias") {
      const v = this.evalExpr(body.body, env);
      if (params.length > 0) {
        if (!this.isCallable(v)) fail(`'${name}' is a function; use '...' for a value body`);
        return this.makeTable(name, v, sig);
      }
      return v;
    }
    const fn = this.makeFn(name, params, body, env, sig);
    return this.makeTable(name, fn, sig);
  }

  evalRecordType(node, env) {
    const typeParams = node.params.filter((p) => p.k === "typeParam");
    const fields = node.params
      .filter((p) => p.k !== "typeParam" && p && p.name)
      .map((p) => ({ name: p.name, type: p.type }));
    const type = {
      k: "type", name: node.name, args: [], fields, typeParams,
      display: node.display, holes: node.holes,
    };
    const cell = env.declare(node.name);
    cell.value = type; cell.set = true;
    cell.constant = true; cell.kind = "type";
    return type;
  }

  evalVariantType(node, env) {
    const typeParams = node.params.filter((p) => p.k === "typeParam");
    const def = {
      name: node.name, params: typeParams, typeParams, display: node.display,
      holes: node.holes, ctors: node.ctors, user: true,
    };
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
    cell.value = type; cell.set = true; cell.constant = true; cell.kind = "type";
    for (const c of node.ctors) {
      const ctor = this.makeCtor(def, c, env);
      const cc = env.declare(c.name);
      cc.value = ctor; cc.set = true; cc.constant = true; cc.kind = "ctor";
      type.ctors.push(ctor);
    }
    if (type.ctors.length === 1) type.singleCtor = type.ctors[0];
    return type;
  }

  makeCtor(def, ctorNode, closureEnv) {
    return {
      k: "fn",
      name: ctorNode.name,
      arity: ctorNode.params.length,
      autoCall: ctorNode.params.length === 0,
      ctorOf: def.name,
      paramNames: ctorNode.params.map((p) => (p ? p.name : null)),
      params: ctorNode.params,
      sig: { params: ctorNode.params, result: null },
      template: ctorNode.display,
      holes: ctorNode.holes || [],
      call(args) {
        const fields = new Map();
        ctorNode.params.forEach((p, i) => {
          if (p && p.name) { const c = new Cell(); c.value = args[i]; c.set = true; fields.set(p.name, c); }
        });
        return vRecord({
          type: def.type, ctor: ctorNode.name, args, fields,
          public: new Set((ctorNode.holes || []).map((h) => h.name)),
          template: ctorNode.display,
        });
      },
    };
  }

  // ---- definitions ----------------------------------------------------

  evalDef(node, env) {
    if (!node.name) {
      const v = this.evalRhsAsValue(node.rhs, env);
      const binds = new Map();
      for (const key of node.keys) {
        const pt = key.k === "keyUnpack" ? { k: "kType" } : null;
        const s = this.matchKey(key, v, binds, env, pt);
        if (s < 0) fail("pattern binding did not match");
      }
      for (const [n, val] of binds) {
        const c = env.declare(n);
        c.value = val; c.set = true;
      }
      return v;
    }

    if (node.keys.length > 0) return this.addClause(node, env);

    const sig = env.sigOf(node.name);
    const rhs = node.rhs;
    const cell = env.find(node.name);

    if (rhs.k === "splat") {
      if (!sig || !sig.params || sig.params.length === 0) {
        fail(`'...' needs parameters; '${node.name}' is a value`);
      }
      const fn = this.makeFn(node.name, sig.params, rhs, env, sig);
      let table = cell && cell.set && cell.value && cell.value.k === "table" ? cell.value : null;
      if (!table) {
        table = this.makeTable(node.name, fn, sig);
        env.assign(node.name, table);
      } else {
        table.fallback = fn;
      }
      return table;
    }

    // alias / value
    const v = this.evalExpr(rhs.body, env);
    if (sig && sig.params && sig.params.length > 0) {
      if (!this.isCallable(v)) fail(`'${node.name}' is a function; use '...' for a value body`);
      let table = cell && cell.set && cell.value && cell.value.k === "table" ? cell.value : null;
      if (!table) {
        table = this.makeTable(node.name, null, sig);
        env.assign(node.name, table);
      }
      table.fallback = v;
      return table;
    }
    if (cell) this.checkCell(cell, v);
    env.assign(node.name, v);
    return v;
  }

  isCallable(v) {
    return v.k === "fn" || v.k === "table" || v.k === "builtin" || v.k === "partial";
  }

  makeFn(name, params, splat, closure, sig) {
    const arity = params.length;
    const self = this;
    return {
      k: "fn",
      name,
      arity,
      paramNames: params.map((p) => (p ? p.name : null)),
      params,
      sig,
      call(args) {
        const env = new Env(closure);
        const tenv = new Map();
        params.forEach((p, i) => {
          if (!p) return;
          if (p.k === "typeParam") {
            if (!args[i] || args[i].k !== "type") fail("expected a type argument");
            if (p.name) {
              tenv.set(p.name, args[i]);
              const c = env.declare(p.name); c.value = args[i]; c.set = true;
              const tc = env.declare("@" + p.name); tc.value = args[i]; tc.set = true;
            }
            return;
          }
          if (p.name) { const c = env.declare(p.name); c.value = args[i]; c.set = true; }
          if (p.type) {
            const t = self.evalTypeNode(p.type, closure, tenv);
            self.checkRuntimeType(t, args[i], p.name ? `parameter '${p.name}'` : "");
          }
        });
        const v = self.evalSplat(splat, env, sig, null, tenv);
        if (sig && sig.result) {
          const rt = self.evalTypeNode(sig.result, closure, tenv);
          self.checkRuntimeType(rt, v);
        }
        return v;
      },
    };
  }

  evalSplat(splat, env, sig, matched, tenv = new Map()) {
    if (!splat.result) return this.evalExpr(splat.body, env);
    const e = new Env(env);
    const cell = e.declare(splat.result);
    if (sig && sig.result) {
      const t = this.evalTypeNode(sig.result, env, tenv);
      if (t.k === "type" && t.fields) { cell.value = this.freshRecord(t); cell.set = true; }
      else if (t.k === "type" && t.singleCtor) { cell.value = this.freshRecordFromCtor(t, t.singleCtor); cell.set = true; }
      else if (t.k === "type" && t.name === "()") { cell.value = UNIT; cell.set = true; }
    }
    this.evalStmts(splat.body.stmts, e);
    if (!cell.set) fail(`'${splat.result}' has not been assigned`);
    return cell.value;
  }

  evalStmts(stmts, env) {
    let last = UNIT;
    for (const s of stmts) last = this.evalStmt(s, env);
    return last;
  }

  freshRecord(type) {
    const fields = new Map();
    for (const f of type.fields) fields.set(f.name, new Cell());
    return vRecord({
      type, ctor: type.name, args: [], fields,
      public: new Set((type.holes || []).map((h) => h.name)),
      template: type.display,
    });
  }

  freshRecordFromCtor(type, ctor) {
    const fields = new Map();
    for (const n of ctor.paramNames || []) if (n) fields.set(n, new Cell());
    return vRecord({
      type, ctor: ctor.name, args: [], fields,
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
    if (node.implicit) {
      const r = cell.sig && cell.sig.result;
      if (!r || r.k !== "unit") fail("a bodyless clause requires a unit result");
    }
    let table = cell.set && cell.value && cell.value.k === "table" ? cell.value : null;
    if (!table) {
      table = this.makeTable(node.name, null, cell.sig);
      cell.value = table; cell.set = true;
    }
    table.clauses.push({ keys: node.keys, rhs: node.rhs, env });
    return table;
  }

  evalDefPath(node, env) {
    const target = node.target;
    const chain = [];
    for (let n = target; n.k === "proj"; n = n.base) chain.unshift(n.field);
    let base = target;
    while (base.k === "proj") base = base.base;
    if (base.k !== "name") fail("assignment target must be a field path");
    let cur = env.get(base.v);
    for (let i = 0; i < chain.length - 1; i++) {
      cur = this.getField(cur, chain[i]);
      if (cur.k !== "record") fail("nested assignment on a non-record");
    }
    const value = this.evalRhsAsValue(node.rhs, env);
    this.setField(cur, chain[chain.length - 1], value);
    return value;
  }

  evalRhsValue(rhs, env) {
    if (rhs.k !== "alias") fail("expected a value");
    return this.evalExpr(rhs.body, env);
  }

  evalRhsAsValue(rhs, env) {
    if (rhs.k === "splat") return this.evalExpr(rhs.body, env);
    return this.evalExpr(rhs.body, env);
  }

  // ---- expressions ----------------------------------------------------

  evalExpr(node, env) {
    switch (node.k) {
      case "num": return vNum(node.v);
      case "str": return vStr(node.v);
      case "lit": return vStr(node.v);
      case "unit": return UNIT;
      case "top": return T_TOP;
      case "typeVarValue": {
        if (node.name) {
          const c = env.find("@" + node.name);
          if (c && c.set && c.value && c.value.k === "type") return c.value;
        }
        return vTypeVar(node.name || null);
      }
      case "name": {
        const v = env.get(node.v);
        return (v.k === "fn" && v.autoCall) ? this.applyValue(v, [], env) : v;
      }
      case "app": {
        const callee = this.evalExpr(node.head, env);
        const specs = this.paramSpecs(callee);
        const args = node.args.map((a, i) => {
          if (a.k === "splatExpr") return this.makeContextualFn(a, specs ? specs[i] : null, env);
          return this.evalExpr(a, env);
        });
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
      case "splatExpr": fail("'...' needs an expected type (pass it as a call argument)");
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

    // record construction: T { $field = value; ... }
    if (callee.k === "type" && callee.fields) {
      const tenv = new Map();
      (callee.typeParams || []).forEach((p, i) => {
        if (p && p.name && callee.args && callee.args[i]) tenv.set(p.name, callee.args[i]);
      });
      const rec = this.freshRecord(callee);
      for (const a of node.args) {
        const f = callee.fields.find((x) => x.name === a.name);
        const v = e.get(a.name);
        if (f && f.type) {
          const t = this.evalTypeNode(f.type, env, tenv);
          this.checkRuntimeType(t, v, `field '${a.name}'`);
        }
        this.setField(rec, a.name, v);
      }
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
    const params = sig ? sig.params : [];
    const tenv = new Map();

    // explicit type arguments
    params.forEach((p) => {
      if (p && p.k === "typeParam" && p.name && argEnv.has(p.name)) {
        const v = argEnv.get(p.name);
        if (!v || v.k !== "type") fail(`expected a type argument for '${p.name}'`);
        tenv.set(p.name, v);
      }
    });

    // infer @ holes from the supplied value arguments
    params.forEach((p) => {
      if (!p || p.k !== "param" || !p.name || !argEnv.has(p.name) || !p.type) return;
      const t = this.evalTypeNode(p.type, callEnv, tenv);
      this.checkRuntimeType(t, argEnv.get(p.name), p.name);
    });

    const values = params.map((p) => {
      if (!p) return undefined;
      if (p.name && argEnv.has(p.name)) return argEnv.get(p.name);
      if (p.k === "typeParam") {
        const v = p.name ? tenv.get(p.name) : null;
        const tv = v && v.var ? this.resolveVar(v) : v;
        if (!tv) fail(`cannot deduce '${p.name || "@?"}'`);
        return tv;
      }
      const info = this.paramTypeInfo(p, callEnv, tenv);
      if (info.defThunk) return info.defThunk();
      if (info.def !== null && info.def !== undefined) return info.def;
      fail(`missing named argument '${p.name || "?"}'`);
    });

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
        const p = ast.params[i];
        if (!this.solveType(p.k === "namedType" ? p.type : p, rt.params[i], subst, typeParams)) return false;
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
    if (v.k === "typeAliasFn") return v.typeParams.map((p) => p.name);
    return null;
  }

  paramSpecs(callee) {
    if (callee.k === "table" || callee.k === "fn") return callee.sig ? callee.sig.params : null;
    if (callee.k === "partial") return null;
    return null;
  }

  makeContextualFn(splat, spec, closure) {
    let t = spec;
    if (t && t.k === "param") t = t.type;
    if (t && t.k === "namedType") t = t.type;
    let params = [];
    if (t && t.k === "fnType") {
      params = t.params.map((p) => (p.k === "namedType" ? { name: p.name } : { name: null }));
    }
    const arity = params.length;
    const self = this;
    return {
      k: "fn",
      name: null,
      arity,
      paramNames: params.map((p) => p.name),
      params,
      sig: null,
      call(args) {
        const env = new Env(closure);
        params.forEach((p, i) => {
          if (p.name) { const c = env.declare(p.name); c.value = args[i]; c.set = true; }
        });
        return self.evalExpr(splat.body, env);
      },
    };
  }

  applyValue(callee, args, env, calleeNode) {
    if (callee.k === "partial") {
      return this.applyValue(callee.target, [...callee.args, ...args], env, callee.node || calleeNode);
    }
    const knownArity =
      callee.k === "builtin" || callee.k === "fn" || callee.k === "table" || callee.k === "typeAliasFn"
        ? callee.arity ?? (callee.typeParams ? callee.typeParams.length : null)
        : null;
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
    if (callee.k === "typeAliasFn") {
      if (args.length !== callee.typeParams.length) fail(`'${callee.name}' expects ${callee.typeParams.length} type argument(s)`);
      for (const a of args) if (!a || a.k !== "type") fail("expected a type argument");
      const e = new Env(callee.env);
      const t = new Map();
      callee.typeParams.forEach((p, i) => { if (p.name) { t.set(p.name, args[i]); const c = e.declare(p.name); c.value = args[i]; c.set = true; } });
      return this.evalExpr(callee.defaultAst, e);
    }
    if (callee.k === "fn") {
      if (args.length !== callee.arity) fail(`'${callee.name || "function"}' expects ${callee.arity} argument(s), got ${args.length}`);
      return callee.call(args, env);
    }
    if (callee.k === "type") return this.applyType(callee, args, env);
    fail(`not callable: ${this.display(callee)}`);
  }

  callTable(table, args, env) {
    const prepared = this.prepareArgs(table.sig, args);
    let best = null;
    for (const cl of table.clauses) {
      const m = this.matchClause(cl, prepared, table);
      if (!m.ok) continue;
      if (!best || m.score > best.score) best = { cl, binds: m.binds, score: m.score, matched: m.matched };
      else if (m.score === best.score) fail(`ambiguous keys for '${table.name}'`);
    }
    if (best) {
      const e = new Env(best.cl.env);
      for (const [n, v] of best.binds) { const c = e.declare(n); c.value = v; c.set = true; }
      const rhs = best.cl.rhs;
      if (rhs.k === "alias") return this.evalExpr(rhs.body, e);
      // splat: bind the unmatched named parameters
      if (table.sig) {
        table.sig.params.forEach((p, i) => {
          if (p && p.name && !best.matched.has(i) && !e.has(p.name)) {
            const c = e.declare(p.name); c.value = prepared[i]; c.set = true;
          }
        });
      }
      return this.evalSplat(rhs, e, table.sig, best.matched);
    }
    if (table.fallback) {
      if (this.isCallable(table.fallback)) return this.applyValue(table.fallback, prepared, env);
      fail(`'${table.name}' cannot be called`);
    }
    fail(`no key matches the call to '${table.name}' and it has no body`);
  }

  prepareArgs(sig, args) {
    return args;
  }

  matchClause(cl, args, table) {
    const binds = new Map();
    const matched = new Set();
    let score = 0;

    // Bind declaration-level type variables from the actual argument types.
    const tenv = new Map();
    if (table.sig && table.sig.params) {
      for (let i = 0; i < table.sig.params.length && i < args.length; i++) {
        const p = table.sig.params[i];
        if (!p) continue;
        if (p.k === "typeParam") {
          if (p.name && args[i] && args[i].k === "type") {
            binds.set(p.name, args[i]);
            binds.set("@" + p.name, args[i]);
          }
          continue;
        }
        if (p.k !== "param" || !p.type) continue;
        const t = this.evalTypeNode(p.type, cl.env, tenv);
        if (!this.typeAccepts(t, args[i])) return { ok: false };
      }
      for (const [n, v] of tenv) {
        const tv = this.resolveVar(v);
        if (tv) binds.set("@" + n, tv);
      }
    }

    const named = cl.keys.some((k) => k.k === "keyBound");

    if (!named) {
      if (cl.keys.length !== args.length) return { ok: false };
      for (let i = 0; i < cl.keys.length; i++) {
        const pt = table.sig && table.sig.params && table.sig.params[i] ? table.sig.params[i].type : null;
        const s = this.matchKey(cl.keys[i], args[i], binds, cl.env, pt);
        if (s < 0) return { ok: false };
        score += s;
        matched.add(i);
      }
      return { ok: true, score, binds, matched };
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
        matched.add(idx);
      } else {
        idx = pos++;
        matched.add(idx);
      }
      if (idx >= args.length) return { ok: false };
      const pat = key.k === "keyBound" ? key.key : key;
      const pt = table.sig && table.sig.params && table.sig.params[idx] ? table.sig.params[idx].type : null;
      const s = this.matchKey(pat, args[idx], binds, cl.env, pt);
      if (s < 0) return { ok: false };
      score += s;
    }
    return { ok: true, score, binds, matched };
  }

  applyType(type, args, env) {
    const params = type.typeParams || (type.def && type.def.typeParams) || [];
    if (params.length === 0) {
      if (!args.length) return type;
      if (type.open) return { ...type, args };
      fail(`type '${type.name}' does not take arguments`);
    }
    if (args.length !== params.length) {
      fail(`type '${type.name}' expects ${params.length} argument(s), got ${args.length}`);
    }
    return {
      k: "type", name: type.name, args, def: type.def || this.typeDefs.get(type.name),
      fields: type.fields, display: type.display, holes: type.holes, typeParams: params,
      open: type.open,
    };
  }

  // ---- patterns -------------------------------------------------------

  matchKey(key, value, binds, env, paramType = null) {
    switch (key.k) {
      case "keyTypeArg": {
        if (!value || value.k !== "type") return -1;
        if (key.name) { binds.set(key.name, value); binds.set("@" + key.name, value); }
        return 3;
      }
      case "keyUnpack": return this.matchUnpack(key, value, binds, env, paramType);
      case "keySlot": return this.matchSlot(key, value, binds, env, paramType);
      case "keyExpr": return this.matchPat(key.p, value, binds, env);
      case "keyBound": return this.matchKey(key.key, value, binds, env, paramType);
      default: return -1;
    }
  }

  isTopParam(paramType) { return !!paramType && paramType.k === "kType"; }

  matchUnpack(slot, value, binds, env, paramType) {
    if (!this.isTopParam(paramType)) {
      fail("unpacking with '=> ?' is only legal on a ? parameter");
    }
    const rt = this.evalTypeNode(slot.type, env);
    if (!this.typeAccepts(rt, value)) return -1;
    if (slot.name) binds.set(slot.name, value);
    return 4;
  }

  matchSlot(slot, value, binds, env, paramType) {
    const t = slot.type;
    if (!slot.name) {
      // a slot with no binder is a type argument
      if (!t) return -1;
      return this.matchTypePat(t, value, binds) ? 3 : -1;
    }

    if (this.isTopParam(paramType)) {
      if (!t || t.k !== "kType") {
        fail(`on a ? parameter use $[${slot.name}: ?] or $[${slot.name}: T => ?]`);
      }
      binds.set(slot.name, value);
      return 1;
    }

    binds.set(slot.name, value);
    if (!t) return 1;                 // $[X:] — anonymous generic
    if (t.k === "kType") return 1;    // $[X: ?]
    if (t.k === "typeVar") {
      const tv = this.evalTypeNode(t, env);
      this.typeAccepts(tv, value);
      if (t.name) binds.set("@" + t.name, this.resolveVar(tv));
      return 1;
    }
    const rt = this.evalTypeNode(t, env);
    if (!this.typeAccepts(rt, value)) return -1;
    return 2;
  }

  matchPat(node, value, binds, env) {
    switch (node.k) {
      case "num": return value.k === "num" && value.v === node.v ? 3 : -1;
      case "str": return value.k === "str" && value.v === node.v ? 3 : -1;
      case "lit": return value.k === "str" && value.v === node.v ? 3 : -1;
      case "wild": return 0;
      case "binder": {
        if (node.name) binds.set(node.name, value);
        if (node.type) {
          const t = this.evalTypeNode(node.type, env);
          if (!this.typeAccepts(t, value)) return -1;
        }
        return 1;
      }
      case "hole": {
        if (node.name) binds.set(node.name, value);
        if (!node.type) return 1;
        if (node.type.k === "kType") return 1;
        if (node.type.k === "typeVar") {
          const tv = this.evalTypeNode(node.type, env);
          this.typeAccepts(tv, value);
          if (node.type.name) binds.set("@" + node.type.name, this.resolveVar(tv));
          return 1;
        }
        const rt = this.evalTypeNode(node.type, env);
        if (!this.typeAccepts(rt, value)) return -1;
        return 2;
      }
      case "holeType": {
        if (!value || value.k !== "type") return -1;
        if (node.name) binds.set(node.name, value);
        return 3;
      }
      case "holeUnpack": {
        const rt = this.evalTypeNode(node.type, env);
        if (!this.typeAccepts(rt, value)) return -1;
        if (node.name) binds.set(node.name, value);
        return 4;
      }
      case "name": {
        if (value.k === "bool" && (node.v === "true" || node.v === "false")) {
          return value.v === (node.v === "true") ? 3 : -1;
        }
        const c = env.find(node.v);
        if (c && c.kind === "type") {
          if (value.k === "record" && value.type && value.type.name === node.v) return 3;
          if (value.k === "type" && value.name === node.v && value.args.length === 0) return 3;
          return -1;
        }
        if (c && c.kind === "ctor") {
          return value.k === "record" && value.ctor === node.v ? 3 : -1;
        }
        if (value.k === "type") return value.name === node.v && value.args.length === 0 ? 3 : -1;
        if (value.k === "record") {
          return value.ctor === node.v || (value.type && value.type.name === node.v) ? 2 : -1;
        }
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
          if (a.k === "typeArg") {
            if (!this.matchTypePat(a.type, typeVal.args[i], binds)) return false;
          } else if (a.k === "typeArgBinder" || a.k === "typePattern" || a.k === "typeVar") {
            if (a.name) binds.set(a.name, typeVal.args[i]);
          } else if (!this.matchTypePat(a, typeVal.args[i], binds)) {
            return false;
          }
        }
        return true;
      }
      default: return false;
    }
  }

  resolveVar(t) {
    const seen = new Set();
    while (t && t.var && t.solved && t.bound && !seen.has(t.id)) {
      seen.add(t.id);
      t = t.bound;
    }
    return t;
  }

  typeVarFor(tenv, name) {
    if (!name) return vTypeVar(null);
    if (!tenv.has(name)) tenv.set(name, vTypeVar(name));
    return tenv.get(name);
  }

  evalTypeNode(node, env, tenv = new Map()) {
    switch (node.k) {
      case "typeName": {
        const c = env.find(node.name);
        if (c) {
          if (c.typeAlias) return c.typeAlias.type;
          if (c.set && c.value && c.value.k === "type") return c.value;
          if (c.set && c.value && c.value.k === "typeAliasFn") return c.value;
          fail(`'${node.name}' is not a type`);
        }
        return mkType(node.name, { open: true });
      }
      case "kType": return T_TOP;
      case "typeVar": {
        if (node.name) {
          const c = env.find("@" + node.name);
          if (c && c.set && c.value && c.value.k === "type") return c.value;
        }
        return this.typeVarFor(tenv, node.name);
      }
      case "unit": return T_UNIT;
      case "product": return mkType("(,)", { args: node.items.map((x) => this.evalTypeNode(x, env, tenv)) });
      case "fnType": {
        const params = [];
        const paramNames = [];
        for (const p of node.params) {
          if (p.k === "namedType") { params.push(this.evalTypeNode(p.type, env, tenv)); paramNames.push(p.name); }
          else { params.push(this.evalTypeNode(p, env, tenv)); paramNames.push(null); }
        }
        return mkType("->", { params, paramNames, result: this.evalTypeNode(node.result, env, tenv) });
      }
      case "typeApp": {
        const head = this.evalTypeNode(node.head, env, tenv);
        const args = node.args.map((a) => {
          if (a.k === "typeArg") return this.evalTypeNode(a.type, env, tenv);
          if (a.k === "typeArgBinder") return this.typeVarFor(tenv, a.name);
          if (a.k === "typePattern") return this.typeVarFor(tenv, a.name);
          if (a.k === "typeVar") return this.typeVarFor(tenv, a.name);
          if (a.k === "typeStr" || a.k === "typeNum") fail("type positions are syntactic: a value cannot be used as a type");
          return this.evalTypeNode(a, env, tenv);
        });
        if (head.k === "typeAliasFn") return this.applyAliasFn(head, args, tenv);
        if (head.var) return { k: "type", name: head.name, args, varHead: head, open: true };
        if (head.k === "type") {
          if (head.name === "->") fail("cannot apply a function type");
          const tps = head.typeParams || (head.def && head.def.typeParams) || [];
          if (tps.length === 0 && args.length && !head.open) {
            fail(`type '${head.name}' does not take arguments`);
          }
          if (tps.length && tps.length !== args.length) {
            fail(`type '${head.name}' expects ${tps.length} argument(s), got ${args.length}`);
          }
          return {
            k: "type", name: head.name, args, def: head.def, fields: head.fields,
            display: head.display, holes: head.holes, open: head.open,
            aliasDefaultThunk: head.aliasDefaultThunk,
          };
        }
        fail(`not a type constructor: ${this.display(head)}`);
      }
      case "typeArg": return this.evalTypeNode(node.type, env, tenv);
      case "typeArgBinder": return this.typeVarFor(tenv, node.name);
      case "typePattern": return this.typeVarFor(tenv, node.name);
      case "typeStr": case "typeNum": fail("type positions are syntactic: a value cannot be used as a type");
      default: return T_TOP;
    }
  }

  applyAliasFn(fn, args, tenv) {
    const e = new Env(fn.env);
    const t = new Map(tenv);
    fn.typeParams.forEach((p, i) => {
      const n = p.name;
      if (n) {
        t.set(n, args[i]);
        const c = e.declare(n);
        c.value = args[i]; c.set = true;
      }
    });
    const type = this.evalTypeNode(fn.resultAst, e, t);
    const defaultThunk = fn.defaultAst ? () => this.evalExpr(fn.defaultAst, e) : null;
    return { ...type, aliasDefaultThunk: defaultThunk };
  }

  paramTypeInfo(p, env, tenv) {
    const type = p.type ? this.evalTypeNode(p.type, env, tenv) : null;
    let def = null;
    let defThunk = null;
    if (type && type.aliasDefaultThunk) defThunk = type.aliasDefaultThunk;
    if (!defThunk && p.type && p.type.k === "typeName") {
      const c = env.find(p.type.name);
      if (c && c.typeAlias && c.typeAlias.default !== undefined) def = c.typeAlias.default;
      else if (c && c.default !== null) def = c.default;
    }
    return { type, def, defThunk };
  }

  checkRuntimeType(t, v, where = "") {
    t = this.resolveVar(t);
    if (!t) return;
    if (t.top || t.name === "?") return;

    if (t.var) {
      if (!t.solved) { t.solved = true; t.bound = typeOf(v); return; }
      this.checkRuntimeType(t.bound || T_TOP, v, where);
      return;
    }

    if (t.name === "()") {
      if (v.k !== "unit") fail(`expected (), got ${this.display(v)}`);
      return;
    }
    if (t.name === "->" || t.name === "fn") {
      if (!this.isCallable(v)) fail(`expected a function, got ${this.display(v)}`);
      return;
    }
    if (t.name === "(,)") {
      if (v.k !== "tuple") fail(`expected a product, got ${this.display(v)}`);
      return;
    }

    const rt = typeOf(v);
    if (t.varHead) {
      if (!t.varHead.solved) { t.varHead.solved = true; t.varHead.bound = mkType(rt.name, { args: rt.args }); }
      for (let i = 0; i < (t.args || []).length; i++) {
        const at = t.args[i];
        if (at && at.var && !at.solved) { at.solved = true; at.bound = (rt.args && rt.args[i]) || null; }
      }
      return;
    }

    if (rt.name !== t.name) {
      fail(`expected ${this.displayType(t)}, got ${this.displayType(rt)}${where ? " in " + where : ""}`);
    }
    if (t.args && rt.args && t.args.length && rt.args.length) {
      if (t.args.length !== rt.args.length) fail(`expected ${this.displayType(t)}, got ${this.displayType(rt)}`);
      for (let i = 0; i < t.args.length; i++) {
        const a = this.resolveVar(t.args[i]);
        if (a && a.var && !a.solved) { a.solved = true; a.bound = rt.args[i]; }
      }
    }
  }

  typeAccepts(t, v) {
    t = this.resolveVar(t);
    if (!t) return true;
    if (t.top || t.name === "?") return true;
    if (t.var) {
      if (!t.solved) { t.solved = true; t.bound = typeOf(v); return true; }
      return this.typeAccepts(t.bound || T_TOP, v);
    }
    if (t.name === "()") return v.k === "unit";
    if (t.name === "->" || t.name === "fn") return this.isCallable(v);
    if (t.name === "(,)") return v.k === "tuple";
    const rt = typeOf(v);
    if (t.varHead) {
      if (!t.varHead.solved) { t.varHead.solved = true; t.varHead.bound = mkType(rt.name, { args: rt.args }); }
      for (let i = 0; i < (t.args || []).length; i++) {
        const at = t.args[i];
        if (at && at.var && !at.solved) { at.solved = true; at.bound = (rt.args && rt.args[i]) || null; }
      }
      return true;
    }
    if (rt.name !== t.name) return false;
    if (t.args && rt.args && t.args.length && rt.args.length) {
      if (t.args.length !== rt.args.length) return false;
      for (let i = 0; i < t.args.length; i++) {
        const a = this.resolveVar(t.args[i]);
        if (a && a.var && !a.solved) { a.solved = true; a.bound = rt.args[i]; }
      }
    }
    return true;
  }

  checkCell(cell, value) {
    if (!cell.typeValue) return;
    this.checkRuntimeType(cell.typeValue, value);
  }

  cast(type, value) { return value; }

  // ---- records --------------------------------------------------------

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
