import path from 'path';
import type { CallSite, FileAnalysis, LanguageParser, ParsedClass, ParsedFunction, ParsedImport } from '../types/parser.types.js';

/**
 * Java, read as a stream of tokens rather than matched line by line.
 *
 * The regex parser this replaced could not see most of what decides who calls
 * whom: a parameter annotation with arguments (`@PathVariable("id") int id`)
 * hid the whole method, `class Box<T> {` was not a class, a `}` inside a
 * string ended a method early, and every call was just a name, so
 * `builder.build()` was credited to every `build` method in the repository.
 *
 * Here the file is tokenized once (comments dropped; string, text-block and
 * char literals kept as single tokens), brackets are paired, and declarations
 * are read structurally: types and their members, nested, local and
 * anonymous classes, enum constants, records. Inside a method, the declared
 * types of parameters, locals and fields give each call a receiver type, so
 * the call graph can look the method up in that type and its hierarchy
 * (see TypedCallResolver) instead of matching the name alone.
 *
 * It is not a Java compiler. Types are known where they are written, and
 * what the parser cannot see within one file - a field inherited from a
 * class in another file, what `a()` returns in `a().b()` - it records for
 * the resolver to finish across files. An untyped lambda parameter or
 * `var x = foo()` leaves the receiver unknown; the call graph then links such
 * a call only where a single type declares the method.
 *
 * Measured against javac on seven repositories (18,152 methods): every
 * declaration found with no phantoms, complexity identical, 91 to 100% of
 * call edges right and 98 to 100% of javac's found.
 */

const ID = 0;
const LIT = 1;
const OP = 2;

interface Tokens {
  tx: string[];
  kd: number[];
  ln: number[];
}

function isIdentStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || (c > 127 && c !== 0xfeff && c !== 0xa0);
}

function isIdentPart(c: number): boolean {
  return isIdentStart(c) || (c >= 48 && c <= 57);
}

const TWO_CHAR_OPS = new Set(['::', '->', '&&', '||', '==', '!=', '++', '--', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=']);

/**
 * Comments are dropped; a string or text block becomes one `"` token, a char
 * literal one `'` token; a number keeps its text. `<` and `>` are always single
 * tokens so that `List<List<String>>` closes its type arguments one by one.
 */
function tokenize(src: string): Tokens {
  const tx: string[] = [];
  const kd: number[] = [];
  const ln: number[] = [];
  const n = src.length;
  let line = 1;
  let i = 0;
  const push = (t: string, k: number, l: number): void => {
    tx.push(t);
    kd.push(k);
    ln.push(l);
  };
  const newlinesIn = (from: number, to: number): number => {
    let count = 0;
    for (let k = from; k < to; k++) if (src.charCodeAt(k) === 10) count++;
    return count;
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      line++;
      i++;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 12 || c === 0xfeff || c === 0xa0) {
      i++;
      continue;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        const eol = src.indexOf('\n', i);
        i = eol === -1 ? n : eol;
        continue;
      }
      if (d === 42) {
        const close = src.indexOf('*/', i + 2);
        const end = close === -1 ? n : close + 2;
        line += newlinesIn(i, end);
        i = end;
        continue;
      }
    }
    if (c === 34) {
      if (src.charCodeAt(i + 1) === 34 && src.charCodeAt(i + 2) === 34) {
        let j = i + 3;
        while (j < n && !(src.charCodeAt(j) === 34 && src.charCodeAt(j + 1) === 34 && src.charCodeAt(j + 2) === 34)) {
          j += src.charCodeAt(j) === 92 ? 2 : 1;
        }
        const end = Math.min(n, j + 3);
        push('"', LIT, line);
        line += newlinesIn(i, end);
        i = end;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 92) j += 2;
        else if (d === 34 || d === 10) break;
        else j++;
      }
      push('"', LIT, line);
      i = j < n && src.charCodeAt(j) === 34 ? j + 1 : j;
      continue;
    }
    if (c === 39) {
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 92) j += 2;
        else if (d === 39 || d === 10) break;
        else j++;
      }
      push("'", LIT, line);
      i = j < n && src.charCodeAt(j) === 39 ? j + 1 : j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src.charCodeAt(j))) j++;
      push(src.slice(i, j), ID, line);
      i = j;
      continue;
    }
    if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      let j = i + 1;
      while (j < n && (isIdentPart(src.charCodeAt(j)) || src.charCodeAt(j) === 46)) j++;
      push(src.slice(i, j), LIT, line);
      i = j;
      continue;
    }
    if (c === 46 && src.charCodeAt(i + 1) === 46 && src.charCodeAt(i + 2) === 46) {
      push('...', OP, line);
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      push(two, OP, line);
      i += 2;
      continue;
    }
    push(src[i]!, OP, line);
    i++;
  }
  return { tx, kd, ln };
}

/** For each `(`, `[` and `{`, the index of its partner, and the other way round; -1 when unpaired. */
function pairBrackets(tx: string[]): Int32Array {
  const match = new Int32Array(tx.length).fill(-1);
  const stack: number[] = [];
  const opener: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < tx.length; i++) {
    const t = tx[i];
    if (t === '(' || t === '[' || t === '{') stack.push(i);
    else if (t === ')' || t === ']' || t === '}') {
      // An unbalanced file pops back to the nearest opener of the same kind.
      let s = stack.length - 1;
      while (s >= 0 && tx[stack[s]!] !== opener[t]) s--;
      if (s < 0) continue;
      const open = stack[s]!;
      stack.length = s;
      match[open] = i;
      match[i] = open;
    }
  }
  return match;
}

const KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue',
  'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'goto', 'if',
  'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private',
  'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null',
]);
const PRIMITIVES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void']);
const MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'native', 'synchronized', 'transient',
  'volatile', 'strictfp', 'default', 'sealed',
]);
/** Words that can precede `(` without being a call. */
const NOT_CALLS = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'throw', 'try', 'assert', 'yield', 'case', 'else', 'do', 'new']);
/** What may follow `Type name` for it to be a declaration rather than the end of an expression. */
const DECLARATION_FOLLOWERS = new Set(['=', ';', ',', ':', ')', '[', '->', 'when']);

interface Scope {
  /** Nested type path within the file: `Outer.Inner`, `Outer.$1`. */
  path: string;
  /** '' for an anonymous class. */
  simpleName: string;
  kind: NonNullable<ParsedClass['kind']>;
  /** Field name -> declared type (null when not known). */
  fields: Map<string, string | null>;
  /** Type parameter -> its bound, or null when it has none. */
  typeParams: Map<string, string | null>;
  superclass?: string | undefined;
  outer?: Scope | undefined;
  /** For a local or anonymous class: the variables of the method it is declared in. */
  enclosingVars?: Map<string, string | null>[] | undefined;
}

type Receiver = Pick<CallSite, 'kind' | 'receivers' | 'via' | 'field' | 'receiverCall'>;

interface Modifiers {
  end: number;
  line: number;
  isPublic: boolean;
  isPrivate: boolean;
  isStatic: boolean;
}

export const JavaParser: LanguageParser = {
  language: 'java',
  extensions: ['.java'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const { tx, kd, ln } = tokenize(content);
    const n = tx.length;
    const match = pairBrackets(tx);
    const lineCount = content.split('\n').length;

    const functions: ParsedFunction[] = [];
    const classes: ParsedClass[] = [];
    const anonymousClasses: ParsedClass[] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];
    const moduleLevelCalls = new Set<string>();
    /** Method name -> the types it is statically imported from. */
    const staticImports = new Map<string, string[]>();
    const staticWildcards: string[] = [];
    let packageName: string | undefined;
    let anonymousCount = 0;

    // Method bodies are read after the declarations around them, so that a
    // field declared below a method still types the calls made on it.
    const queue: Array<() => void> = [];

    const endOf = (open: number): number => (match[open]! >= 0 ? match[open]! : n - 1);

    /** A dotted name starting at `i`: [text, index after it]. */
    const qualifiedName = (i: number): [string, number] => {
      let text = tx[i] ?? '';
      let j = i + 1;
      while (tx[j] === '.' && kd[j + 1] === ID) {
        text += `.${tx[j + 1]}`;
        j += 2;
      }
      return [text, j];
    };

    const skipAnnotation = (i: number): number => {
      // `@` Name(.Name)* [( ... )]
      let j = qualifiedName(i + 1)[1];
      if (tx[j] === '(') j = endOf(j) + 1;
      return j;
    };

    const skipModifiers = (i: number): Modifiers => {
      let j = i;
      let line = -1;
      let isPublic = false;
      let isPrivate = false;
      let isStatic = false;
      while (j < n) {
        const t = tx[j]!;
        if (t === '@' && tx[j + 1] !== 'interface') {
          j = skipAnnotation(j);
          continue;
        }
        if (MODIFIERS.has(t) && kd[j] === ID) {
          if (line < 0) line = ln[j]!;
          if (t === 'public') isPublic = true;
          if (t === 'private') isPrivate = true;
          if (t === 'static') isStatic = true;
          j++;
          continue;
        }
        if (t === 'non' && tx[j + 1] === '-' && tx[j + 2] === 'sealed') {
          if (line < 0) line = ln[j]!;
          j += 3;
          continue;
        }
        break;
      }
      return { end: j, line: line < 0 ? (ln[j] ?? 1) : line, isPublic, isPrivate, isStatic };
    };

    /** Type arguments `<...>` starting at `i` (which is `<`): the index after `>`, or -1 if this is not a type argument list. */
    const skipTypeArgs = (i: number): number => {
      let j = i + 1;
      if (tx[j] === '>') return j + 1; // diamond
      for (;;) {
        while (tx[j] === '@') j = skipAnnotation(j);
        if (tx[j] === '?') {
          j++;
          if (tx[j] === 'extends' || tx[j] === 'super') {
            const t = parseType(j + 1);
            if (!t) return -1;
            j = t.end;
          }
        } else {
          const t = parseType(j);
          if (!t) return -1;
          j = t.end;
        }
        while (tx[j] === '&') {
          const t = parseType(j + 1);
          if (!t) return -1;
          j = t.end;
        }
        if (tx[j] === ',') {
          j++;
          continue;
        }
        return tx[j] === '>' ? j + 1 : -1;
      }
    };

    /**
     * A type starting at `i`: its text with type arguments dropped and array
     * dimensions kept (`Map.Entry`, `int[]`), and the index after it.
     */
    function parseType(i: number): { text: string; end: number } | null {
      let j = i;
      while (tx[j] === '@') j = skipAnnotation(j);
      if (kd[j] !== ID) return null;
      const first = tx[j]!;
      if (KEYWORDS.has(first) && !PRIMITIVES.has(first)) return null;
      let text = first;
      j++;
      if (!PRIMITIVES.has(first)) {
        if (tx[j] === '<') {
          const after = skipTypeArgs(j);
          if (after < 0) return null;
          j = after;
        }
        for (;;) {
          if (tx[j] !== '.') break;
          // A type-use annotation can sit inside a qualified type: `Map.@Nullable Entry` (JLS 9.7.4).
          let k = j + 1;
          while (tx[k] === '@' && tx[k + 1] !== 'interface') k = skipAnnotation(k);
          if (kd[k] !== ID || KEYWORDS.has(tx[k]!)) break;
          text += `.${tx[k]}`;
          j = k + 1;
          if (tx[j] === '<') {
            const after = skipTypeArgs(j);
            if (after < 0) return null;
            j = after;
          }
        }
      }
      for (;;) {
        while (tx[j] === '@') j = skipAnnotation(j);
        if (tx[j] === '[' && tx[j + 1] === ']') {
          text += '[]';
          j += 2;
          continue;
        }
        break;
      }
      return { text, end: j };
    }

    /** `<T extends Bound, U>` at `i`: each parameter's bound, and the index after `>`. */
    const parseTypeParams = (i: number): { params: Map<string, string | null>; end: number } | null => {
      const params = new Map<string, string | null>();
      let j = i + 1;
      while (j < n) {
        while (tx[j] === '@') j = skipAnnotation(j);
        if (kd[j] !== ID) return null;
        const name = tx[j]!;
        j++;
        let bound: string | null = null;
        if (tx[j] === 'extends') {
          const t = parseType(j + 1);
          if (!t) return null;
          bound = t.text;
          j = t.end;
          while (tx[j] === '&') {
            const more = parseType(j + 1);
            if (!more) return null;
            j = more.end;
          }
        }
        params.set(name, bound);
        if (tx[j] === ',') {
          j++;
          continue;
        }
        if (tx[j] === '>') return { params, end: j + 1 };
        return null;
      }
      return null;
    };

    const parseTypeList = (i: number, into: string[]): number => {
      let j = i;
      for (;;) {
        const t = parseType(j);
        if (!t) return j;
        into.push(t.text);
        j = t.end;
        if (tx[j] !== ',') return j;
        j++;
      }
    };

    /**
     * Replaces a type variable with its erasure - its bound, or Object - using
     * the scopes it is declared in. A `T` receiver has the members of its
     * bound and nothing else, and a `T[]` argument cannot be an `int[]`.
     */
    const resolveTypeVariable = (text: string, scope: Scope, methodTypeParams?: Map<string, string | null>): string => {
      const base = text.replace(/(\[\])+$/, '');
      if (methodTypeParams?.has(base)) return dimsOnto(methodTypeParams.get(base) ?? null, text, base);
      for (let s: Scope | undefined = scope; s; s = s.outer) {
        if (s.typeParams.has(base)) return dimsOnto(s.typeParams.get(base) ?? null, text, base);
      }
      return text;
    };

    /** See ParsedFunction.returnType. */
    const declaredReturnType = (written: string, scope: Scope, methodTypeParams?: Map<string, string | null>): string | null => {
      const base = written.replace(/(\[\])+$/, '');
      const dims = written.slice(base.length);
      if (methodTypeParams?.has(base)) {
        const bound = methodTypeParams.get(base);
        return bound ? bound + dims : null;
      }
      for (let s: Scope | undefined = scope; s; s = s.outer) {
        if (!s.typeParams.has(base)) continue;
        const bound = s.typeParams.get(base);
        if (!bound) return null;
        return !dims && lastSegment(bound) === s.simpleName ? '<self>' : bound + dims;
      }
      return written;
    };

    // ── Calls ───────────────────────────────────────────────────────────────

    interface Body {
      fn: ParsedFunction | null;
      scope: Scope;
      vars: Map<string, string | null>;
      typeParams?: Map<string, string | null> | undefined;
      sites: Map<string, CallSite>;
      names: Set<string>;
      complexity: number;
    }

    const lookupVar = (body: Body, name: string): { found: boolean; type: string | null } => {
      if (body.vars.has(name)) return { found: true, type: body.vars.get(name) ?? null };
      for (let s: Scope | undefined = body.scope; s; s = s.outer) {
        if (s.fields.has(name)) return { found: true, type: s.fields.get(name) ?? null };
        for (const vars of s.enclosingVars ?? []) {
          if (vars.has(name)) return { found: true, type: vars.get(name) ?? null };
        }
      }
      return { found: false, type: null };
    };

    const scopePaths = (scope: Scope): string[] => {
      const paths: string[] = [];
      for (let s: Scope | undefined = scope; s; s = s.outer) paths.push(s.path);
      return paths;
    };

    const addSite = (body: Body, site: CallSite): void => {
      body.names.add(site.name);
      if (!body.fn) return;
      const key = `${site.kind}\0${site.name}\0${site.receivers?.join(',') ?? ''}\0${site.argTypes?.join(',') ?? site.args}`;
      if (!body.sites.has(key)) body.sites.set(key, site);
    };

    /** The arguments between `(` at `open` and its partner, counted at the top level. */
    const countArgs = (open: number): number => {
      const close = endOf(open);
      if (close === open + 1) return 0;
      let args = 1;
      for (let j = open + 1; j < close; j++) {
        const t = tx[j];
        if (t === '(' || t === '[' || t === '{') j = endOf(j);
        else if (t === '<' && kd[j - 1] === ID) {
          const after = skipTypeArgs(j);
          if (after > 0) j = after - 1;
        } else if (t === ',') args++;
      }
      return args;
    };

    /**
     * The type of each argument between `(` at `open` and its partner, where
     * the expression shows it; for an argument that is a call, the call, so
     * that its declared return type can stand in.
     */
    const argumentsOf = (body: Body, open: number): Pick<CallSite, 'argTypes' | 'argCalls'> => {
      const close = endOf(open);
      const types: (string | null)[] = [];
      const calls: (CallSite | null)[] = [];
      if (close === open + 1) return { argTypes: types };
      let start = open + 1;
      for (let j = open + 1; j <= close; j++) {
        const t = tx[j];
        if (j === close || t === ',') {
          const type = expressionType(body, start, j);
          types.push(type);
          calls.push(type === null ? callExpression(body, start, j) : null);
          start = j + 1;
        } else if (t === '(' || t === '[' || t === '{') j = endOf(j);
        else if (t === '<' && kd[j - 1] === ID) {
          const after = skipTypeArgs(j);
          if (after > 0) j = after - 1;
        }
      }
      return calls.some((c) => c !== null) ? { argTypes: types, argCalls: calls } : { argTypes: types };
    };

    /** The expression in [from, to) when it is a single method call, `a.b(x)` or `b(x)`. */
    const callExpression = (body: Body, from: number, to: number): CallSite | null => {
      if (tx[to - 1] !== ')') return null;
      const open = match[to - 1]!;
      const nameAt = open - 1;
      const name = tx[nameAt];
      if (open <= from || kd[nameAt] !== ID || !name || KEYWORDS.has(name) || tx[nameAt - 1] === 'new') return null;
      for (let j = from; j < nameAt; j++) {
        const u = tx[j];
        if (u === '(' || u === '[') j = endOf(j);
        else if (kd[j] === OP && u !== '.' && u !== '<' && u !== '>' && u !== ',' && u !== '?') return null;
      }
      return { name, args: countArgs(open), ...argumentsOf(body, open), ...callReceiver(body, nameAt) };
    };

    /** The static type of the expression in [from, to), where it is evident. */
    const expressionType = (body: Body, from: number, to: number): string | null => {
      const t = tx[from];
      if (to - from === 1) {
        if (kd[from] === LIT) return t === '"' ? 'String' : t === "'" ? 'char' : numberType(t!);
        if (t === 'true' || t === 'false') return 'boolean';
        if (t === 'null') return 'null';
        if (t === 'this') return body.scope.path;
        if (kd[from] === ID) return lookupVar(body, t!).type;
        return null;
      }
      if (t === '-' && to - from === 2 && kd[from + 1] === LIT) return numberType(tx[from + 1]!);
      if (kd[from] === ID && tx[from + 1] === '[' && endOf(from + 1) === to - 1) {
        const array = lookupVar(body, t!).type;
        return array?.endsWith('[]') ? array.slice(0, -2) : null;
      }
      if (to - from === 3 && tx[from + 1] === '.' && kd[from + 2] === ID) {
        if (t === 'this') return receiverOfChain(body, ['this', tx[from + 2]!]).receivers?.[0] ?? null;
        if (tx[from + 2] === 'length' && lookupVar(body, t!).type?.endsWith('[]')) return 'int';
      }
      let operators = false;
      let strings = false;
      for (let j = from; j < to; j++) {
        const u = tx[j];
        if (u === '(' || u === '[' || u === '{') j = endOf(j);
        else if (u === '->' || u === '::') return '->';
        else if (u === '"' && kd[j] === LIT) strings = true;
        else if (kd[j] === OP && u !== '.' && u !== '<' && u !== '>') operators = true;
      }
      if (operators) return strings && tx.slice(from, to).includes('+') ? 'String' : null;
      if (t === 'new') {
        const type = parseType(from + 1);
        if (!type) return null;
        if (tx[type.end] === '(' && endOf(type.end) === to - 1) return type.text;
        if (tx[type.end] === '{') return type.text;
        if (tx[type.end] === '[') {
          let dims = '';
          for (let j = type.end; tx[j] === '['; j = endOf(j) + 1) dims += '[]';
          return type.text + dims;
        }
        return null;
      }
      if (t === '(') {
        const cast = parseType(from + 1);
        if (cast && tx[cast.end] === ')' && cast.end + 1 < to) return resolveTypeVariable(cast.text, body.scope, body.typeParams);
      }
      return null;
    };

    /** The receiver of the member access whose `.` is at `dot`. */
    /** The receiver of the call whose name is at `nameAt`: after a `.`, or the enclosing types for an unqualified call. */
    const callReceiver = (body: Body, nameAt: number): Receiver => {
      let dot = nameAt - 1;
      // `Collections.<String>emptyList()`
      if (tx[dot] === '>') dot = typeArgsStart(dot) - 1;
      if (tx[dot] === '.') return receiverOf(body, dot);
      const receivers = scopePaths(body.scope);
      // A single-static-import shadows any static import on demand (JLS 6.4.1).
      receivers.push(...(staticImports.get(tx[nameAt]!) ?? staticWildcards));
      return { kind: 'member', receivers };
    };

    const receiverOf = (body: Body, dot: number): Receiver => {
      const unknown = { kind: 'unknown' as const };
      const e = dot - 1;
      const t = tx[e];
      if (kd[e] === LIT) return t === '"' ? { kind: 'member', receivers: ['String'] } : unknown;
      if (t === ')') {
        const open = match[e]!;
        if (open < 0) return unknown;
        // `new Foo(...).bar()`
        const created = creationTypeBefore(open);
        if (created) return { kind: 'member', receivers: [created] };
        // `((Foo) x).bar()`
        if (tx[open + 1] === '(') {
          const cast = parseType(open + 2);
          if (cast && tx[cast.end] === ')') {
            const type = resolveTypeVariable(cast.text, body.scope, body.typeParams);
            return type ? { kind: 'member', receivers: [type] } : unknown;
          }
        }
        // `a.b().c()`: c is called on what b returns.
        const name = tx[open - 1];
        if (kd[open - 1] === ID && name && !KEYWORDS.has(name)) {
          return { kind: 'member', receiverCall: { name, args: countArgs(open), ...argumentsOf(body, open), ...callReceiver(body, open - 1) } };
        }
        return unknown;
      }
      if (t === ']') {
        const open = match[e]!;
        if (open > 0 && kd[open - 1] === ID && tx[open - 2] !== '.') {
          const v = lookupVar(body, tx[open - 1]!);
          if (v.type?.endsWith('[]')) return { kind: 'member', receivers: [v.type.slice(0, -2)] };
        }
        return unknown;
      }
      if (kd[e] !== ID) return unknown;
      let s = e;
      const chain = [tx[e]!];
      while (tx[s - 1] === '.' && kd[s - 2] === ID) {
        s -= 2;
        chain.unshift(tx[s]!);
      }
      if (tx[s - 1] === '.' || tx[s - 1] === '::') return unknown;
      return receiverOfChain(body, chain);
    };

    const receiverOfChain = (body: Body, chain: string[]): Receiver => {
      const unknown = { kind: 'unknown' as const };
      const [head, ...rest] = chain;
      if (!head) return unknown;
      if (head === 'this') {
        if (rest.length === 0) return { kind: 'member', receivers: [body.scope.path] };
        if (rest.length === 1) {
          for (let s: Scope | undefined = body.scope; s; s = s.outer) {
            if (s.fields.has(rest[0]!)) {
              const type = s.fields.get(rest[0]!) ?? null;
              return type ? { kind: 'member', receivers: [type] } : unknown;
            }
          }
          // Declared in a supertype, which may be in another file.
          return { kind: 'unknown', field: rest[0]! };
        }
        return unknown;
      }
      if (head === 'super') return rest.length === 0 ? { kind: 'super', receivers: [body.scope.path] } : unknown;
      if (rest.length > 0 && rest[rest.length - 1] === 'this') return { kind: 'member', receivers: [chain.slice(0, -1).join('.')] };
      if (rest.length > 0 && rest[rest.length - 1] === 'super') return { kind: 'super', receivers: [chain.slice(0, -1).join('.')] };

      const v = lookupVar(body, head);
      if (v.found) {
        if (rest.length === 0) return v.type ? { kind: 'member', receivers: [v.type] } : unknown;
        if (!v.type) return unknown;
        return rest.length === 1 ? { kind: 'unknown', via: v.type, field: rest[0]! } : { kind: 'unknown', via: v.type };
      }
      // Not a variable in sight and not a type: a field inherited from a supertype.
      if (/^[a-z_$]/.test(head)) return rest.length === 0 ? { kind: 'unknown', field: head } : unknown;

      // A type, possibly package-qualified (`java.util.Objects`) or nested
      // (`Outer.Inner`). A segment after it that is not a type is a static
      // field (`Foo.INSTANCE.bar()`), whose type is not known here.
      const firstType = chain.findIndex((seg) => /^[A-Z]/.test(seg));
      if (firstType < 0) return unknown;
      let last = firstType;
      while (last + 1 < chain.length && isTypeName(chain[last + 1]!)) last++;
      // `System.out.println()`: a static field of `System`.
      if (last === chain.length - 2) return { kind: 'unknown', via: chain.slice(0, last + 1).join('.'), field: chain[last + 1]! };
      if (last !== chain.length - 1) return { kind: 'unknown', via: chain.slice(0, last + 1).join('.') };
      if (chain.length > 1 && !isTypeName(chain[last]!)) return unknown;
      return { kind: 'static', receivers: [chain.join('.')] };
    };

    /** `new Foo<...>(` ending at the `(` at `open`: the type created. */
    function creationTypeBefore(open: number): string | null {
      let j = open - 1;
      if (tx[j] === '>') {
        let depth = 0;
        for (; j >= 0; j--) {
          if (tx[j] === '>') depth++;
          else if (tx[j] === '<' && --depth === 0) break;
        }
        j--;
      }
      const end = j;
      while (kd[j] === ID && tx[j - 1] === '.' && kd[j - 2] === ID) j -= 2;
      if (kd[j] !== ID || tx[j - 1] !== 'new') return null;
      const parts: string[] = [];
      for (let k = j; k <= end; k++) if (kd[k] === ID) parts.push(tx[k]!);
      return parts.join('.');
    }

    /** Collects parameter, local and lambda-parameter declarations in [from, to). */
    const collectDeclarations = (body: Body, from: number, to: number): void => {
      for (let k = from; k < to; k++) {
        const nested = nestedClassBodyAt(k);
        if (nested >= 0) {
          k = endOf(nested);
          continue;
        }
        const t = tx[k]!;
        if (t === '->') {
          if (kd[k - 1] === ID && !body.vars.has(tx[k - 1]!)) body.vars.set(tx[k - 1]!, null);
          else if (tx[k - 1] === ')') {
            const open = match[k - 1]!;
            for (let j = open + 1; j > 0 && j < k - 1; j++) {
              if (kd[j] === ID && (tx[j + 1] === ',' || tx[j + 1] === ')') && (tx[j - 1] === '(' || tx[j - 1] === ',') && !body.vars.has(tx[j]!)) {
                body.vars.set(tx[j]!, null);
              }
            }
          }
          continue;
        }
        if (kd[k] !== ID || tx[k - 1] === '.' || t === 'yield' || (KEYWORDS.has(t) && !PRIMITIVES.has(t))) continue;
        const type = parseType(k);
        if (!type) continue;
        const nameAt = type.end;
        if (kd[nameAt] !== ID || KEYWORDS.has(tx[nameAt]!)) continue;
        if (!DECLARATION_FOLLOWERS.has(tx[nameAt + 1]!) && tx[k - 1] !== 'instanceof') continue;
        if (tx[nameAt + 1] === '(' || type.text === 'yield') continue;
        const name = tx[nameAt]!;
        if (body.vars.has(name)) continue;
        let declared: string | null = type.text;
        if (declared === 'var') declared = initializerType(nameAt + 1);
        body.vars.set(name, declared === null ? null : resolveTypeVariable(declared, body.scope, body.typeParams));
        k = nameAt;
      }
    };

    /** `= new Foo(...)` or `= (Foo) x` after a `var` name: the type it gives the variable. */
    const initializerType = (at: number): string | null => {
      if (tx[at] !== '=') return null;
      if (tx[at + 1] === 'new') {
        const t = parseType(at + 2);
        return t && tx[t.end] === '(' ? t.text : null;
      }
      if (tx[at + 1] === '(') {
        const t = parseType(at + 2);
        return t && tx[t.end] === ')' ? t.text : null;
      }
      return null;
    };

    /**
     * The `{` of a class body that starts at `k`: an anonymous class
     * (`new Foo(...) {`) or a local type declaration. -1 otherwise.
     */
    function nestedClassBodyAt(k: number): number {
      const t = tx[k];
      if (t === 'new') {
        const type = parseType(k + 1);
        if (!type || tx[type.end] !== '(') return -1;
        const after = endOf(type.end) + 1;
        return tx[after] === '{' ? after : -1;
      }
      if (isTypeDeclarationAt(k)) {
        for (let j = k + 1; j < n; j++) {
          if (tx[j] === '{') return j;
          if (tx[j] === ';' || tx[j] === '}') return -1;
          if (tx[j] === '(') j = endOf(j);
        }
      }
      return -1;
    }

    function isTypeDeclarationAt(k: number): boolean {
      const t = tx[k];
      if (kd[k] !== ID || tx[k - 1] === '.' || tx[k - 1] === '::') return false;
      if (t === 'class' || t === 'interface' || t === 'enum') return kd[k + 1] === ID;
      // `record` is only a keyword where a record is declared.
      if (t === 'record') return kd[k + 1] === ID && (tx[k + 2] === '(' || tx[k + 2] === '<');
      return false;
    }

    /** Reads calls, complexity and nested classes in the code between `from` and `to`. */
    const scanCode = (body: Body, from: number, to: number): void => {
      const anonymousBodies = new Map<number, string>();
      for (let k = from; k < to; k++) {
        const t = tx[k]!;
        const superType = anonymousBodies.get(k);
        if (superType !== undefined) {
          k = parseAnonymousClass(k, superType, body);
          continue;
        }
        if (kd[k] === ID && isTypeDeclarationAt(k)) {
          const end = parseTypeDeclaration(k, { end: k, line: ln[k]!, isPublic: false, isPrivate: false, isStatic: false }, body.scope, [body.vars, ...(body.scope.enclosingVars ?? [])], true);
          k = end - 1;
          continue;
        }
        switch (t) {
          case 'if':
          case 'for':
          case 'while':
          case 'catch':
            if (kd[k] === ID) body.complexity++;
            break;
          case 'case':
            if (kd[k] === ID) body.complexity += caseLabels(k);
            break;
          case '&&':
          case '||':
            body.complexity++;
            break;
          case '?':
            // `<?` and `, ?` are wildcards; any other `?` is a conditional.
            if (tx[k - 1] !== '<' && tx[k - 1] !== ',') body.complexity++;
            break;
        }

        if (t === 'new' && kd[k] === ID) {
          let j = k + 1;
          while (tx[j] === '@') j = skipAnnotation(j);
          const type = parseType(j);
          if (!type || tx[type.end] !== '(') continue;
          const typeName = type.text;
          addSite(body, { name: lastSegment(typeName), args: countArgs(type.end), ...argumentsOf(body, type.end), kind: 'new', receivers: [typeName] });
          const after = endOf(type.end) + 1;
          if (tx[after] === '{') anonymousBodies.set(after, typeName);
          k = type.end - 1;
          continue;
        }

        if (t === '::') {
          const name = tx[k + 1];
          if (!name || kd[k + 1] !== ID) continue;
          let receiver: Receiver = { kind: 'unknown' };
          if (tx[k - 1] === ']' || tx[k - 1] === '>') {
            // `int[]::new`, `List<String>::size`: a type
            let j = k - 1;
            while (j > 0 && (tx[j] === ']' || tx[j] === '[' || tx[j] === '>')) j = tx[j] === '>' ? typeArgsStart(j) - 1 : j - 1;
            if (kd[j] === ID) receiver = { kind: 'static', receivers: [qualifiedBefore(j)] };
          } else {
            receiver = receiverOf(body, k);
          }
          if (name === 'new') {
            const typeName = receiver.receivers?.[0];
            if (typeName && !typeName.endsWith('[]')) addSite(body, { name: lastSegment(typeName), args: -1, kind: 'new', receivers: [typeName] });
          } else {
            addSite(body, { name, args: -1, ...receiver, kind: receiver.kind === 'static' ? 'member' : receiver.kind });
          }
          k++;
          continue;
        }

        if (kd[k] !== ID || tx[k + 1] !== '(' || tx[k - 1] === '@' || tx[k - 1] === '::') continue;
        if (NOT_CALLS.has(t) || (KEYWORDS.has(t) && t !== 'this' && t !== 'super')) continue;
        const args = countArgs(k + 1);
        const argTypes = argumentsOf(body, k + 1);

        if (t === 'this' || t === 'super') {
          if (tx[k - 1] === '.') continue; // `Outer.this(` is not Java
          if (t === 'this' && body.scope.simpleName) {
            addSite(body, { name: body.scope.simpleName, args, ...argTypes, kind: 'new', receivers: [body.scope.path] });
          } else if (t === 'super' && body.scope.superclass) {
            addSite(body, { name: lastSegment(body.scope.superclass), args, ...argTypes, kind: 'new', receivers: [body.scope.superclass] });
          }
          continue;
        }

        addSite(body, { name: t, args, ...argTypes, ...callReceiver(body, k) });
      }
    };

    /** The labels of the `case` at `k` that are not `default`: `case A, B ->` is two branches. */
    function caseLabels(k: number): number {
      let labels = 1;
      for (let j = k + 1; j < n && tx[j] !== '->' && tx[j] !== ':' && tx[j] !== '{' && tx[j] !== ';'; j++) {
        if (tx[j] === '(' || tx[j] === '[') j = endOf(j);
        else if (tx[j] === ',') labels++;
        else if (tx[j] === 'default') labels--;
      }
      return Math.max(labels, 0);
    }

    /** The `<` that opens the type arguments closed by the `>` at `gt`. */
    function typeArgsStart(gt: number): number {
      let depth = 0;
      for (let j = gt; j >= 0; j--) {
        if (tx[j] === '>') depth++;
        else if (tx[j] === '<' && --depth === 0) return j;
      }
      return gt;
    }

    /** The dotted name ending at identifier index `j`. */
    function qualifiedBefore(j: number): string {
      let s = j;
      while (tx[s - 1] === '.' && kd[s - 2] === ID) s -= 2;
      return qualifiedName(s)[0];
    }

    const finishBody = (body: Body): void => {
      if (!body.fn) {
        for (const name of body.names) moduleLevelCalls.add(name);
        return;
      }
      // A function's own name is never one of its calls: recursion does not keep it alive.
      body.fn.calls = [...body.names].filter((name) => name !== body.fn!.name);
      body.fn.callSites = [...body.sites.values()];
      body.fn.complexity = body.complexity;
    };

    // ── Declarations ────────────────────────────────────────────────────────

    /** A type declaration whose keyword (`class`, `interface`, `enum`, `record`, or `@` of `@interface`) is at `i`. */
    function parseTypeDeclaration(
      i: number,
      mods: Modifiers,
      outer: Scope | undefined,
      enclosingVars?: Map<string, string | null>[],
      isLocal = false,
    ): number {
      let kind: Scope['kind'];
      let j = i;
      if (tx[j] === '@') {
        kind = 'annotation';
        j += 2;
      } else {
        kind = tx[j] as Scope['kind'];
        j++;
      }
      if (kd[j] !== ID) return j;
      const name = tx[j]!;
      j++;
      const scope: Scope = {
        path: outer ? `${outer.path}.${name}` : name,
        simpleName: name,
        kind,
        fields: new Map(),
        typeParams: new Map(),
        outer,
        enclosingVars: isLocal ? enclosingVars : outer?.enclosingVars,
      };
      if (tx[j] === '<') {
        const tp = parseTypeParams(j);
        if (tp) {
          scope.typeParams = tp.params;
          j = tp.end;
        }
      }
      let components: Param[] = [];
      if (kind === 'record' && tx[j] === '(') {
        components = parseParams(j, scope);
        for (const c of components) scope.fields.set(c.name, c.type);
        j = endOf(j) + 1;
      }
      const extendsList: string[] = [];
      const implementsList: string[] = [];
      while (j < n && tx[j] !== '{' && tx[j] !== ';' && tx[j] !== '}') {
        if (tx[j] === 'extends') j = parseTypeList(j + 1, extendsList);
        else if (tx[j] === 'implements') j = parseTypeList(j + 1, implementsList);
        else if (tx[j] === 'permits') j = parseTypeList(j + 1, []);
        else j++;
      }
      if (tx[j] !== '{') return j + 1;
      const open = j;
      const close = endOf(open);
      if (kind === 'class') scope.superclass = extendsList[0];
      const supertypes = kind === 'interface' ? extendsList : implementsList;
      const record: ParsedClass = {
        name,
        filePath,
        startLine: mods.line,
        endLine: ln[close]!,
        methods: [],
        ...(kind === 'class' && extendsList[0] ? { extends: extendsList[0] } : {}),
        implements: supertypes,
        isExported: mods.isPublic,
        path: scope.path,
        kind,
      };
      classes.push(record);
      if (mods.isPublic) exports.push(name);
      parseClassBody(open, close, scope, components);
      setFieldTypes(record, scope);
      return close + 1;
    }

    function parseAnonymousClass(open: number, superType: string, body: Body): number {
      const close = endOf(open);
      const scope: Scope = {
        path: `${body.scope.path}.$${++anonymousCount}`,
        simpleName: '',
        kind: 'class',
        fields: new Map(),
        typeParams: new Map(),
        outer: body.scope,
        enclosingVars: [body.vars, ...(body.scope.enclosingVars ?? [])],
        superclass: superType,
      };
      const record: ParsedClass = {
        name: lastSegment(superType),
        filePath,
        startLine: ln[open]!,
        endLine: ln[close]!,
        methods: [],
        extends: superType,
        isExported: false,
        path: scope.path,
        kind: 'class',
      };
      anonymousClasses.push(record);
      parseClassBody(open, close, scope, [], body);
      setFieldTypes(record, scope);
      return close;
    }

    /**
     * Members between `{` at `open` and `}` at `close`. Code outside any
     * method - field initializers, initializer blocks - is credited to
     * `initializerOf` (the method an anonymous class is created in), or to
     * the file when the class is not inside a method.
     */
    function parseClassBody(open: number, close: number, scope: Scope, components: Param[], initializerOf?: Body): void {
      const initializerBody = (): Body =>
        initializerOf ?? { fn: null, scope, vars: new Map(), sites: new Map(), names: new Set(), complexity: 0 };
      let i = open + 1;
      if (scope.kind === 'enum') i = parseEnumConstants(i, close, scope, initializerBody);
      while (i < close) {
        if (tx[i] === ';') {
          i++;
          continue;
        }
        const mods = skipModifiers(i);
        let j = mods.end;
        if (tx[j] === '{') {
          const end = endOf(j);
          const from = j + 1;
          queue.push(() => {
            const b = initializerBody();
            const blockBody: Body = { ...b, scope, vars: new Map(b.vars) };
            collectDeclarations(blockBody, from, end);
            scanCode(blockBody, from, end);
            finishBody(b);
          });
          i = end + 1;
          continue;
        }
        if (isTypeDeclarationAt(j) || (tx[j] === '@' && tx[j + 1] === 'interface')) {
          i = parseTypeDeclaration(j, mods, scope);
          continue;
        }
        let typeParams: Map<string, string | null> | undefined;
        if (tx[j] === '<') {
          const tp = parseTypeParams(j);
          if (tp) {
            typeParams = tp.params;
            j = tp.end;
          }
        }
        if (kd[j] === ID && tx[j] === scope.simpleName && tx[j + 1] === '(') {
          i = parseMethod(j, mods, scope, typeParams, true);
          continue;
        }
        if (scope.kind === 'record' && tx[j] === scope.simpleName && tx[j + 1] === '{') {
          // Compact canonical constructor: its parameters are the record's components.
          i = parseMethodBody(j, j + 1, mods, scope, typeParams, true, components);
          continue;
        }
        const type = parseType(j);
        if (type && kd[type.end] === ID && !KEYWORDS.has(tx[type.end]!)) {
          if (tx[type.end + 1] === '(') {
            i = parseMethod(type.end, mods, scope, typeParams, false, type.text);
            continue;
          }
          i = parseFields(type.end, type.text, scope, close, initializerBody);
          continue;
        }
        i = skipMember(i, close);
      }
    }

    function parseEnumConstants(from: number, close: number, scope: Scope, initializerBody: () => Body): number {
      let i = from;
      while (i < close) {
        while (tx[i] === '@') i = skipAnnotation(i);
        if (tx[i] === ';') return i + 1;
        if (kd[i] !== ID || tx[i] === '}') return i;
        scope.fields.set(tx[i]!, scope.path);
        i++;
        if (tx[i] === '(') {
          const end = endOf(i);
          const from2 = i + 1;
          queue.push(() => {
            const b = initializerBody();
            scanCode(b, from2, end);
            finishBody(b);
          });
          i = end + 1;
        }
        if (tx[i] === '{') {
          const enumBody: Body = { fn: null, scope, vars: new Map(), sites: new Map(), names: new Set(), complexity: 0 };
          i = parseAnonymousClass(i, scope.path, enumBody) + 1;
          finishBody(enumBody);
        }
        if (tx[i] === ',') {
          i++;
          continue;
        }
        if (tx[i] === ';') return i + 1;
        return i;
      }
      return i;
    }

    function skipMember(i: number, close: number): number {
      for (let j = i; j < close; j++) {
        const t = tx[j];
        if (t === ';') return j + 1;
        if (t === '{') return endOf(j) + 1;
        if (t === '(' || t === '[') j = endOf(j);
      }
      return Math.max(i + 1, close);
    }

    function parseFields(nameAt: number, type: string, scope: Scope, close: number, initializerBody: () => Body): number {
      let j = nameAt;
      for (;;) {
        if (kd[j] !== ID) return skipMember(j, close);
        let declared = type;
        const name = tx[j]!;
        j++;
        while (tx[j] === '[' && tx[j + 1] === ']') {
          declared += '[]';
          j += 2;
        }
        scope.fields.set(name, resolveTypeVariable(declared, scope));
        if (tx[j] === '=') {
          const from = j + 1;
          let k = from;
          while (k < close && tx[k] !== ',' && tx[k] !== ';') k = tx[k] === '(' || tx[k] === '[' || tx[k] === '{' ? endOf(k) + 1 : k + 1;
          const to = k;
          queue.push(() => {
            const b = initializerBody();
            const fieldBody: Body = { ...b, scope };
            collectDeclarations(fieldBody, from, to);
            scanCode(fieldBody, from, to);
            finishBody(b);
          });
          j = to;
        }
        if (tx[j] === ',') {
          j++;
          continue;
        }
        return tx[j] === ';' ? j + 1 : skipMember(j, close);
      }
    }

    interface Param {
      name: string;
      type: string | null;
      variadic: boolean;
    }

    function parseParams(open: number, scope: Scope, typeParams?: Map<string, string | null>): Param[] {
      const close = endOf(open);
      const params: Param[] = [];
      let j = open + 1;
      while (j < close) {
        while (tx[j] === '@' || tx[j] === 'final') j = tx[j] === '@' ? skipAnnotation(j) : j + 1;
        const type = parseType(j);
        if (!type) break;
        j = type.end;
        let variadic = false;
        let text = type.text;
        if (tx[j] === '...') {
          variadic = true;
          text += '[]';
          j++;
        }
        if (kd[j] !== ID) break;
        const name = tx[j]!;
        j++;
        while (tx[j] === '[' && tx[j + 1] === ']') {
          text += '[]';
          j += 2;
        }
        // A receiver parameter (`Foo this`) is not a parameter.
        if (name !== 'this') params.push({ name, type: resolveTypeVariable(text, scope, typeParams), variadic });
        while (j < close && tx[j] !== ',') j = tx[j] === '(' || tx[j] === '[' || tx[j] === '{' ? endOf(j) + 1 : j + 1;
        j++;
      }
      return params;
    }

    function parseMethod(
      nameAt: number,
      mods: Modifiers,
      scope: Scope,
      typeParams: Map<string, string | null> | undefined,
      isConstructor: boolean,
      returnType?: string,
    ): number {
      const open = nameAt + 1;
      const params = parseParams(open, scope, typeParams);
      let j = endOf(open) + 1;
      while (tx[j] === '[' && tx[j + 1] === ']') j += 2;
      if (tx[j] === 'throws') {
        const thrown: string[] = [];
        j = parseTypeList(j + 1, thrown);
      }
      if (tx[j] === 'default') {
        // An annotation element's default value.
        while (j < n && tx[j] !== ';' && tx[j] !== '}') j = tx[j] === '(' || tx[j] === '{' || tx[j] === '[' ? endOf(j) + 1 : j + 1;
      }
      if (tx[j] === '{') return parseMethodBody(nameAt, j, mods, scope, typeParams, isConstructor, params, returnType);
      return tx[j] === ';' ? j + 1 : j;
    }

    function parseMethodBody(
      nameAt: number,
      open: number,
      mods: Modifiers,
      scope: Scope,
      typeParams: Map<string, string | null> | undefined,
      isConstructor: boolean,
      params: Param[],
      returnType?: string,
    ): number {
      const close = endOf(open);
      const startLine = Math.min(mods.line, ln[nameAt]!);
      const fn: ParsedFunction = {
        name: tx[nameAt]!,
        filePath,
        startLine,
        endLine: ln[close]!,
        parameters: params.map((p) => p.name),
        // Interface members are public unless declared private (JLS 9.4).
        isExported: mods.isPublic || ((scope.kind === 'interface' || scope.kind === 'annotation') && !mods.isPrivate),
        isAsync: false, // Java doesn't have async keyword (CompletableFuture etc. is different)
        calls: [],
        complexity: 1,
        lineCount: ln[close]! - startLine + 1,
        language: 'java',
        className: scope.path,
        isConstructor,
        isVariadic: params[params.length - 1]?.variadic ?? false,
        parameterTypes: params.map((p) => p.type),
        ...(returnType !== undefined ? { returnType: declaredReturnType(returnType, scope, typeParams) } : {}),
      };
      functions.push(fn);
      const vars = new Map<string, string | null>();
      for (const p of params) vars.set(p.name, p.type);
      queue.push(() => {
        const body: Body = { fn, scope, vars, typeParams, sites: new Map(), names: new Set(), complexity: 1 };
        collectDeclarations(body, open + 1, close);
        scanCode(body, open + 1, close);
        finishBody(body);
      });
      return close + 1;
    }

    // ── Compilation unit ────────────────────────────────────────────────────

    let i = 0;
    while (i < n) {
      const t = tx[i]!;
      if (t === 'package' && kd[i] === ID) {
        const [name, after] = qualifiedName(i + 1);
        packageName = name;
        i = after;
        continue;
      }
      if (t === 'import' && kd[i] === ID) {
        let j = i + 1;
        const isStatic = tx[j] === 'static';
        if (isStatic) j++;
        // `import module java.base;` names a module, not a type.
        if (tx[j] === 'module' && kd[j + 1] === ID) {
          i = j + 2;
          continue;
        }
        let [name, after] = qualifiedName(j);
        if (tx[after] === '.' && tx[after + 1] === '*') {
          if (isStatic) staticWildcards.push(name);
          name += '.*';
          after += 2;
        } else if (isStatic) {
          const dot = name.lastIndexOf('.');
          const member = name.slice(dot + 1);
          const list = staticImports.get(member) ?? [];
          list.push(name.slice(0, dot));
          staticImports.set(member, list);
        }
        imports.push({ source: name, symbols: [name.split('.').pop() ?? name], isRelative: false });
        i = after;
        continue;
      }
      if (t === ';') {
        i++;
        continue;
      }
      const mods = skipModifiers(i);
      const j = mods.end;
      if (isTypeDeclarationAt(j) || (tx[j] === '@' && tx[j + 1] === 'interface')) {
        i = parseTypeDeclaration(j, mods, undefined);
        continue;
      }
      i = Math.max(i + 1, j + 1);
    }

    for (let q = 0; q < queue.length; q++) queue[q]!();

    functions.sort((a, b) => a.startLine - b.startLine);
    classes.sort((a, b) => a.startLine - b.startLine);
    const avgComplexity =
      functions.length > 0 ? functions.reduce((s, f) => s + f.complexity, 0) / functions.length : 1;

    return {
      filePath,
      language: 'java',
      functions,
      classes,
      imports,
      exports,
      lineCount,
      complexity: Math.round(avgComplexity * 100) / 100,
      explanation: generateExplanation(filePath, classes, functions),
      ...(moduleLevelCalls.size > 0 ? { moduleLevelCalls: [...moduleLevelCalls] } : {}),
      ...(packageName ? { packageName } : {}),
      ...(anonymousClasses.length > 0 ? { anonymousClasses } : {}),
    };
  },
};

function setFieldTypes(record: ParsedClass, scope: Scope): void {
  const fields: Record<string, string> = {};
  for (const [name, type] of scope.fields) if (type) fields[name] = type;
  if (Object.keys(fields).length > 0) record.fields = fields;
}

/** A numeric literal's type: `1L` long, `1.5f` float, `1e3` double, otherwise int. */
function numberType(text: string): string {
  if (/^0[xXbB]/.test(text)) return /[lL]$/.test(text) ? 'long' : 'int';
  if (/[lL]$/.test(text)) return 'long';
  if (/[fF]$/.test(text)) return 'float';
  if (/[dD]$|[.eE]/.test(text)) return 'double';
  return 'int';
}

/** A type name rather than a constant: `Inner`, not `INSTANCE`. */
function isTypeName(segment: string): boolean {
  return /^[A-Z]/.test(segment) && !/^[A-Z0-9_]+$/.test(segment);
}

function lastSegment(typeName: string): string {
  return typeName.slice(typeName.lastIndexOf('.') + 1);
}

/** A type variable's erasure, carrying over the array dimensions written on the variable. */
function dimsOnto(bound: string | null, written: string, base: string): string {
  return (bound ?? 'Object') + written.slice(base.length);
}

function generateExplanation(filePath: string, classes: Array<{ name: string }>, functions: ParsedFunction[]): string {
  const base = path.basename(filePath, '.java');
  if (classes.length > 0) {
    return `${base} contains the ${classes[0]?.name ?? base} class with ${functions.length} method${functions.length === 1 ? '' : 's'}.`;
  }
  return `${base} defines ${functions.length} Java method${functions.length === 1 ? '' : 's'}.`;
}
