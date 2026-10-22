import type { CallSite, FileAnalysis, ParsedFunction } from '../types/parser.types.js';
import { jdkType } from './JdkTypes.js';

/**
 * Resolves call sites that carry a receiver type (see ParsedFunction.callSites)
 * to the functions they can reach, the way the language looks them up: in the
 * receiver's type, then its supertypes, plus the overrides in its subtypes
 * that dynamic dispatch can land on.
 *
 * Matching by name alone, `builder.build()` reached every `build` method in a
 * repository and `list.add(x)` reached the repository's own `add`. Typed, the
 * first reaches the builder's type and its subtypes only, and the second
 * nothing at all: `List` is not declared in the repository.
 *
 * Type names are resolved as Java resolves them: nested types visible from
 * the caller's class, then single-type imports, the caller's package, and
 * on-demand imports. A name none of those finds in the repository is taken to
 * be a library type, whose methods are not in the call graph; for the Java
 * standard library, jdkModel.ts says what those methods return, so that a
 * chain like `list.stream().filter(f).anyMatch(p)` is known to stay in it.
 */

interface TypeInfo {
  file: FileAnalysis;
  /** Nested path within the file: `Outer.Inner`, `Outer.$1`. */
  path: string;
  qualifiedName: string;
  supertypeNames: string[];
  supertypes: TypeInfo[];
  subtypes: TypeInfo[];
  methods: Map<string, ParsedFunction[]>;
  constructors: ParsedFunction[];
  /** Field name -> declared type, as written in this type's file. */
  fields: Map<string, string>;
  isInterface: boolean;
}

interface Lookup {
  targets: ParsedFunction[];
  declared: ParsedFunction[];
  receiverTypes: TypeInfo[];
  /** Standard library types the method was found in, by name. */
  libraryTypes: string[];
}

/** An argument's type, with the file and class it is written in, so that it can be resolved. */
type Argument = { type: string; file: FileAnalysis; context: string | undefined } | null;

const PRIMITIVES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'void']);

/** ParsedFunction.returnType of a method returning its receiver's own type (see there). */
export const SELF_TYPE = '<self>';

type Verdict = 'exact' | 'yes' | 'maybe' | 'no';
const VERDICT_SCORE: Record<Verdict, number> = { exact: 3, yes: 1, maybe: 0, no: -1 };

/** Widening primitive conversions (JLS 5.1.2). */
const WIDENING: Record<string, string[]> = {
  byte: ['short', 'int', 'long', 'float', 'double'],
  short: ['int', 'long', 'float', 'double'],
  char: ['int', 'long', 'float', 'double'],
  int: ['long', 'float', 'double'],
  long: ['float', 'double'],
  float: ['double'],
};
const BOXES: Record<string, string> = {
  boolean: 'Boolean', byte: 'Byte', char: 'Character', short: 'Short', int: 'Integer', long: 'Long', float: 'Float', double: 'Double',
};
const UNBOXED: Record<string, string> = Object.fromEntries(Object.entries(BOXES).map(([p, b]) => [b, p]));

export class TypedCallResolver {
  private readonly byQualifiedName = new Map<string, TypeInfo>();
  private readonly byFile = new Map<FileAnalysis, Map<string, TypeInfo>>();
  private readonly typeOfFunction = new Map<ParsedFunction, TypeInfo>();
  private readonly fileOfFunction = new Map<ParsedFunction, FileAnalysis>();
  /** file -> context -> name as written -> type: resolution repeats for every call site, and building a string key cost more than the lookup. */
  private readonly resolvedNames = new Map<FileAnalysis, Map<string, Map<string, TypeInfo | null>>>();
  /** Method name -> the types that declare a method of that name. */
  private readonly declaringTypes = new Map<string, TypeInfo[]>();
  // Memoized per type, by `name/args`: the same lookups repeat across every call site.
  private readonly above = new Map<TypeInfo, Map<string, ParsedFunction[]>>();
  private readonly below = new Map<TypeInfo, Map<string, ParsedFunction[]>>();
  private readonly sole = new Map<string, ParsedFunction[]>();

  constructor(fileAnalyses: readonly FileAnalysis[]) {
    for (const file of fileAnalyses) {
      const hasTypedCalls = file.functions.some((fn) => fn.callSites !== undefined);
      if (!hasTypedCalls && file.packageName === undefined) continue;
      const types = new Map<string, TypeInfo>();
      this.byFile.set(file, types);
      for (const cls of [...file.classes, ...(file.anonymousClasses ?? [])]) {
        if (!cls.path) continue;
        const info: TypeInfo = {
          file,
          path: cls.path,
          qualifiedName: file.packageName ? `${file.packageName}.${cls.path}` : cls.path,
          supertypeNames: [...(cls.extends ? [cls.extends] : []), ...(cls.implements ?? [])],
          supertypes: [],
          subtypes: [],
          methods: new Map(),
          constructors: [],
          fields: new Map(Object.entries(cls.fields ?? {})),
          isInterface: cls.kind === 'interface' || cls.kind === 'annotation',
        };
        types.set(cls.path, info);
        // Anonymous classes have no name to be found by.
        if (!cls.path.includes('$')) this.byQualifiedName.set(info.qualifiedName, info);
      }
      for (const fn of file.functions) {
        this.fileOfFunction.set(fn, file);
        const type = fn.className === undefined ? undefined : types.get(fn.className);
        if (!type) continue;
        this.typeOfFunction.set(fn, type);
        if (fn.isConstructor) type.constructors.push(fn);
        else {
          const list = type.methods.get(fn.name);
          if (list) list.push(fn);
          else {
            type.methods.set(fn.name, [fn]);
            const declaring = this.declaringTypes.get(fn.name);
            if (declaring) declaring.push(type);
            else this.declaringTypes.set(fn.name, [type]);
          }
        }
      }
    }

    for (const types of this.byFile.values()) {
      for (const type of types.values()) {
        // A supertype is named from the scope that declares the type: for an
        // anonymous class `Outer.$1`, that is `Outer`.
        const context = type.path.includes('.') ? type.path.slice(0, type.path.lastIndexOf('.')) : undefined;
        for (const name of type.supertypeNames) {
          const supertype = this.resolveType(name, type.file, context);
          if (supertype && supertype !== type && !type.supertypes.includes(supertype)) {
            type.supertypes.push(supertype);
            supertype.subtypes.push(type);
          }
        }
      }
    }
    // Names resolved while the hierarchy was still being linked may have
    // missed a member type inherited from a supertype linked later.
    this.resolvedNames.clear();
  }

  /**
   * For a call whose receiver's type is not known: the methods of that name
   * and arity when a single type declares them, and nothing otherwise.
   *
   * Measured against javac on seven repositories, linking no such call at all
   * missed 0.2 to 0.6 points of recall; linking every same-named method cost
   * up to 8 points of precision. One declaring type is the one case where the
   * name alone points somewhere, and a missed caller is the error a reader
   * of an impact report cannot see.
   */
  soleDeclarations(site: CallSite): ParsedFunction[] {
    if (site.kind === 'new') return [];
    const key = `${site.name}/${site.args}`;
    let result = this.sole.get(key);
    if (!result) {
      result = [];
      let declaringTypes = 0;
      for (const type of this.declaringTypes.get(site.name) ?? []) {
        const fns = (type.methods.get(site.name) ?? []).filter((fn) => fits(fn, site.args));
        if (fns.length === 0) continue;
        if (++declaringTypes > 1) {
          result = [];
          break;
        }
        result.push(...fns);
      }
      this.sole.set(key, result);
    }
    return result;
  }

  /** Whether calls from this function are resolved here rather than by name. */
  handles(fn: ParsedFunction): boolean {
    return fn.callSites !== undefined && this.fileOfFunction.has(fn);
  }

  /**
   * The functions `site` can reach, or null when its receiver's type is not
   * known, so that only the name can say. An empty list means the call goes
   * outside the repository: a library method, or a constructor never written.
   */
  resolve(caller: ParsedFunction, site: CallSite): ParsedFunction[] | null {
    const file = this.fileOfFunction.get(caller);
    if (!file) return null;
    const lookup = this.lookUp(site, file, caller.className);
    return lookup && lookup.targets.filter((fn) => fn !== caller);
  }

  /**
   * The call's targets, the declarations among them that Java chooses at
   * compile time (the rest are overrides dispatch can reach), and the types
   * they were looked up in - repository types, and standard library types
   * by name; null when the receiver's type is not known.
   */
  private lookUp(site: CallSite, file: FileAnalysis, context: string | undefined): Lookup | null {
    const found = new Set<ParsedFunction>();
    const declared = new Set<ParsedFunction>();
    let receiverTypes: TypeInfo[] = [];
    let libraryTypes: string[] = [];
    const nothing: Lookup = { targets: [], declared: [], receiverTypes: [], libraryTypes: [] };

    if (site.receiverCall) {
      // `a.b().c()`: c is looked up in what b returns.
      const result = this.resultTypes(site.receiverCall, file, context);
      if (result === null) return null;
      receiverTypes = result.repo;
      libraryTypes = result.library;
      for (const type of receiverTypes) {
        for (const fn of this.declaredAbove(type, site)) declared.add(fn);
        for (const fn of this.overridesBelow(type, site)) found.add(fn);
      }
    } else if (site.kind === 'unknown' || !site.receivers || site.receivers.length === 0) {
      if (site.field === undefined) {
        // A field of a library type holds a library object.
        if (site.via !== undefined && !this.resolveType(site.via, file, context)) return nothing;
        return null;
      }
      const fieldType = this.fieldTypeOf(site.field, site.via, file, context);
      if (fieldType === undefined) return null;
      if (fieldType === null) return nothing;
      receiverTypes = [fieldType];
      for (const fn of this.declaredAbove(fieldType, site)) declared.add(fn);
      for (const fn of this.overridesBelow(fieldType, site)) found.add(fn);
    } else if (site.kind === 'new') {
      const type = this.resolveType(site.receivers[0]!, file, context);
      if (type) receiverTypes = [type];
      for (const ctor of type?.constructors ?? []) if (fits(ctor, site.args)) declared.add(ctor);
    } else if (site.kind === 'super') {
      const type = this.resolveType(site.receivers[0]!, file, context);
      receiverTypes = type?.supertypes ?? [];
      for (const supertype of receiverTypes) for (const fn of this.declaredAbove(supertype, site)) declared.add(fn);
    } else {
      // An unqualified call lists its enclosing types innermost first, then
      // statically imported types: the first one in which the name is a member
      // is the one Java picks. A static call names one type.
      for (const receiver of site.kind === 'static' ? site.receivers.slice(0, 1) : site.receivers) {
        const type = this.resolveType(receiver, file, context);
        if (!type) {
          if (jdkType(receiver)?.returnTypeOf(site.name) !== undefined) {
            libraryTypes = [receiver];
            break;
          }
          continue;
        }
        const above = this.declaredAbove(type, site);
        const below = site.kind === 'static' ? [] : this.overridesBelow(type, site);
        if (above.length === 0 && below.length === 0) continue;
        receiverTypes = [type];
        for (const fn of above) declared.add(fn);
        for (const fn of below) found.add(fn);
        break;
      }
    }

    for (const fn of declared) found.add(fn);
    const targets = this.narrowByArguments([...found], site, file, context);
    return { targets, declared: targets.filter((fn) => declared.has(fn)), receiverTypes, libraryTypes };
  }

  /**
   * The type of field `name`, read from type `via`, or inherited by the
   * caller's classes when `via` is not given: null when it is a library type
   * (or a field of one), undefined when no field of that name is found.
   */
  private fieldTypeOf(name: string, via: string | undefined, file: FileAnalysis, context: string | undefined): TypeInfo | null | undefined {
    let owners: TypeInfo[];
    if (via !== undefined) {
      const owner = this.resolveType(via, file, context);
      if (!owner) return null;
      owners = [owner];
    } else {
      const types = this.byFile.get(file);
      const parts = context?.split('.') ?? [];
      owners = [];
      for (let i = parts.length; i > 0; i--) {
        const enclosing = types?.get(parts.slice(0, i).join('.'));
        if (enclosing) owners.push(enclosing);
      }
    }
    for (const owner of owners) {
      const field = this.fieldOf(owner, name, new Set());
      if (field) return this.resolveType(field.type, field.owner.file, field.owner.path);
    }
    return undefined;
  }

  private fieldOf(type: TypeInfo, name: string, seen: Set<TypeInfo>): { type: string; owner: TypeInfo } | null {
    if (seen.has(type)) return null;
    seen.add(type);
    const own = type.fields.get(name);
    if (own) return { type: own, owner: type };
    for (const supertype of type.supertypes) {
      const inherited = this.fieldOf(supertype, name, seen);
      if (inherited) return inherited;
    }
    return null;
  }

  /** The declared return type of the method a call resolves to, as an argument type. */
  private returnTypeOf(call: CallSite | null | undefined, file: FileAnalysis, context: string | undefined): Argument {
    if (!call) return null;
    const lookup = this.lookUp(call, file, context);
    if (!lookup) return null;
    const first = lookup.declared[0];
    if (!first) {
      // A library method: the model says what it returns.
      const [library, ...more] = lookup.libraryTypes;
      const returned = library && more.length === 0 ? jdkType(library)?.returnTypeOf(call.name) : undefined;
      return returned && returned !== '?' ? { type: returned, file, context } : null;
    }
    const returned = first.returnType;
    if (returned === undefined || returned === null) return null;
    if (returned === SELF_TYPE) {
      const [type, ...more] = lookup.receiverTypes;
      return type && more.length === 0 ? { type: type.path, file: type.file, context: undefined } : null;
    }
    if (lookup.declared.some((fn) => fn.returnType !== returned)) return null;
    const calleeFile = this.fileOfFunction.get(first);
    return calleeFile ? { type: returned, file: calleeFile, context: first.className } : null;
  }

  /**
   * The types a call's result can have: repository types, and standard
   * library types by name. Both are empty when it returns a primitive or
   * nothing; null when the type is not known - a type variable, or a method
   * of a library outside the JDK model.
   */
  private resultTypes(site: CallSite, file: FileAnalysis, context: string | undefined): { repo: TypeInfo[]; library: string[] } | null {
    const lookup = this.lookUp(site, file, context);
    if (!lookup) return null;
    const repo = new Set<TypeInfo>();
    const library = new Set<string>();
    if (lookup.declared.length === 0) {
      if (lookup.libraryTypes.length === 0) return null;
      for (const name of lookup.libraryTypes) {
        const returned = jdkType(name)?.returnTypeOf(site.name);
        if (returned === undefined || returned === '?') return null;
        if (!PRIMITIVES.has(returned) && !returned.endsWith('[]')) library.add(returned);
      }
      return { repo: [], library: [...library] };
    }
    // A call's static type is the return type of the method Java chose, not
    // of the overrides it may dispatch to: those can narrow it covariantly.
    for (const fn of lookup.declared) {
      const returned = fn.returnType;
      if (returned === undefined || returned === null) return null;
      if (returned === SELF_TYPE) {
        for (const type of lookup.receiverTypes) repo.add(type);
        continue;
      }
      const calleeFile = this.fileOfFunction.get(fn);
      const type = calleeFile && this.resolveType(returned, calleeFile, fn.className);
      if (type) repo.add(type);
      else if (jdkType(returned)) library.add(returned);
    }
    return { repo: [...repo], library: [...library] };
  }

  /**
   * Of several methods a call could reach by name and argument count, the
   * ones its argument types fit, most specific first - Java's overload
   * resolution, as far as the argument types are known. `join(int[], char)`
   * and `join(Object[], String)` take two arguments each; the types tell
   * them apart. Where no candidate fits, all are kept: the inferred types
   * may be what is wrong.
   */
  private narrowByArguments(candidates: ParsedFunction[], site: CallSite, file: FileAnalysis, context: string | undefined): ParsedFunction[] {
    if (candidates.length < 2 || !site.argTypes) return candidates;
    const argTypes: Argument[] = site.argTypes.map((type, i) =>
      type !== null ? { type, file, context } : this.returnTypeOf(site.argCalls?.[i], file, context),
    );
    if (argTypes.every((t) => t === null)) return candidates;
    const scored: { fn: ParsedFunction; score: number }[] = [];
    for (const fn of candidates) {
      const calleeFile = this.fileOfFunction.get(fn);
      if (!calleeFile || !fn.parameterTypes) {
        scored.push({ fn, score: 0 });
        continue;
      }
      let score = 0;
      let fitsAll = true;
      for (let i = 0; i < argTypes.length && fitsAll; i++) {
        let best = -1;
        for (const param of this.parameterTypesAt(fn, i, argTypes.length)) {
          const verdict = this.assignable(argTypes[i] ?? null, param, calleeFile, fn.className);
          best = Math.max(best, VERDICT_SCORE[verdict]);
        }
        if (best < 0) fitsAll = false;
        else score += best;
      }
      if (fitsAll) scored.push({ fn, score });
    }
    if (scored.length === 0) return candidates;
    const top = Math.max(...scored.map((s) => s.score));
    return scored.filter((s) => s.score === top).map((s) => s.fn);
  }

  /** The declared type(s) argument `i` is matched against; a variadic slot takes the array or its element. */
  private parameterTypesAt(fn: ParsedFunction, i: number, args: number): (string | null)[] {
    const types = fn.parameterTypes ?? [];
    const last = types.length - 1;
    if (!fn.isVariadic || i < last) return [types[i] ?? null];
    const array = types[last] ?? null;
    const element = array?.endsWith('[]') ? array.slice(0, -2) : null;
    return args === types.length && i === last ? [array, element] : [element];
  }

  /** Whether an argument of type `arg` can be passed for a parameter of type `param` (JLS 5.3). */
  private assignable(argument: Argument, param: string | null, paramFile: FileAnalysis, paramContext: string | undefined): Verdict {
    if (argument === null || param === null) return 'maybe';
    const { type: arg, file: argFile, context: argContext } = argument;
    if (arg === 'null') return PRIMITIVES.has(param) ? 'no' : 'yes';
    const p = simpleName(param);
    if (arg === '->') {
      // A lambda or method reference needs a functional interface.
      if (PRIMITIVES.has(param) || param.endsWith('[]')) return 'no';
      const declaredType = this.resolveType(param, paramFile, paramContext);
      const isInterface = declaredType ? declaredType.isInterface : jdkType(param)?.isInterface;
      return isInterface === false ? 'no' : 'maybe';
    }

    const argPrimitive = PRIMITIVES.has(arg);
    const paramPrimitive = PRIMITIVES.has(param);
    if (argPrimitive && paramPrimitive) return arg === param ? 'exact' : WIDENING[arg]?.includes(param) ? 'yes' : 'no';
    if (argPrimitive) {
      const box = BOXES[arg] ?? '';
      if (p === box || jdkType(box)?.supertypes.has(p)) return 'yes';
      if (param.endsWith('[]') || jdkType(param) || this.resolveType(param, paramFile, paramContext)) return 'no';
      return 'maybe';
    }
    if (paramPrimitive) {
      const unboxed = UNBOXED[simpleName(arg)];
      if (!unboxed) return 'no';
      return unboxed === param || WIDENING[unboxed]?.includes(param) ? 'yes' : 'no';
    }

    const argDims = dimensions(arg);
    const paramDims = dimensions(param);
    if (paramDims > 0) {
      if (argDims === 0) return 'no';
      if (argDims !== paramDims) return 'maybe';
      const a = arg.slice(0, arg.length - 2 * argDims);
      const q = param.slice(0, param.length - 2 * paramDims);
      if (PRIMITIVES.has(a) || PRIMITIVES.has(q)) return a === q ? 'exact' : 'no';
      return this.assignable({ type: a, file: argFile, context: argContext }, q, paramFile, paramContext);
    }
    if (argDims > 0) return p === 'Object' || p === 'Cloneable' || p === 'Serializable' ? 'yes' : 'no';

    const argType = this.resolveType(arg, argFile, argContext);
    const paramType = this.resolveType(param, paramFile, paramContext);
    if (argType && paramType) return argType === paramType ? 'exact' : isSubtype(argType, paramType) ? 'yes' : 'no';
    // A library type is never a subtype of a repository type.
    if (paramType) return 'no';
    if (p === 'Object') return 'yes';
    if (argType) {
      if (hasSupertypeNamed(argType, p)) return 'yes';
      // Through the library types the repository type extends: a class
      // extending ArrayList is a List.
      let unknownSupertype = false;
      for (const name of this.librarySupertypes(argType)) {
        const library = jdkType(name);
        if (!library) unknownSupertype = true;
        else if (library.supertypes.has(p)) return 'yes';
      }
      return unknownSupertype ? 'maybe' : 'no';
    }
    const a = simpleName(arg);
    if (a === p) return 'exact';
    // A standard library type's supertypes are all known.
    const library = jdkType(arg);
    if (library) return library.supertypes.has(p) ? 'yes' : 'no';
    return jdkType(param)?.isFinal ? 'no' : 'maybe';
  }

  /** The supertypes named in `type`'s hierarchy that are not declared in the repository. */
  private librarySupertypes(type: TypeInfo): string[] {
    const names: string[] = [];
    const seen = new Set<TypeInfo>();
    const stack = [type];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      const context = t.path.includes('.') ? t.path.slice(0, t.path.lastIndexOf('.')) : undefined;
      for (const name of t.supertypeNames) if (!this.resolveType(name, t.file, context)) names.push(name);
      stack.push(...t.supertypes);
    }
    return names;
  }

  /** The nearest declarations of the site's method in `type` or its supertypes. */
  private declaredAbove(type: TypeInfo, site: CallSite): ParsedFunction[] {
    return memo(this.above, type, site, () => this.findAbove(type, site));
  }

  private findAbove(type: TypeInfo, site: CallSite): ParsedFunction[] {
    const result: ParsedFunction[] = [];
    const seen = new Set<TypeInfo>();
    const visit = (t: TypeInfo): void => {
      if (seen.has(t)) return;
      seen.add(t);
      const own = (t.methods.get(site.name) ?? []).filter((fn) => fits(fn, site.args));
      if (own.length > 0) {
        result.push(...own);
        return;
      }
      for (const s of t.supertypes) visit(s);
    };
    visit(type);
    return result;
  }

  /** Overrides of the site's method in the subtypes of `type`, which dispatch can reach. */
  private overridesBelow(type: TypeInfo, site: CallSite): ParsedFunction[] {
    if (type.subtypes.length === 0) return [];
    return memo(this.below, type, site, () => this.findBelow(type, site));
  }

  private findBelow(type: TypeInfo, site: CallSite): ParsedFunction[] {
    const result: ParsedFunction[] = [];
    const seen = new Set<TypeInfo>([type]);
    const stack = [...type.subtypes];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      for (const fn of t.methods.get(site.name) ?? []) if (fits(fn, site.args)) result.push(fn);
      stack.push(...t.subtypes);
    }
    return result;
  }

  /**
   * The repository type a name written in `file` refers to, from within the
   * type at `context`; null when the repository does not declare it.
   */
  resolveType(written: string, file: FileAnalysis, context: string | undefined): TypeInfo | null {
    let byContext = this.resolvedNames.get(file);
    if (!byContext) {
      byContext = new Map();
      this.resolvedNames.set(file, byContext);
    }
    let byName = byContext.get(context ?? '');
    if (!byName) {
      byName = new Map();
      byContext.set(context ?? '', byName);
    }
    const cached = byName.get(written);
    if (cached !== undefined) return cached;
    const resolved = this.lookUpType(written, file, context);
    byName.set(written, resolved);
    return resolved;
  }

  private lookUpType(written: string, file: FileAnalysis, context: string | undefined): TypeInfo | null {
    if (written.endsWith('[]') || PRIMITIVES.has(written)) return null;
    const types = this.byFile.get(file);
    if (!types) return null;
    const exact = types.get(written);
    if (exact) return exact;

    const [head, ...rest] = written.split('.');
    if (!head) return null;
    let type = this.lookUpSimpleName(head, file, types, context);
    if (!type) {
      // Fully qualified: `com.example.Foo.Inner`.
      const segments = written.split('.');
      for (let i = segments.length; i > 0 && !type; i--) {
        const candidate = this.byQualifiedName.get(segments.slice(0, i).join('.'));
        if (candidate) {
          type = candidate;
          rest.splice(0, rest.length, ...segments.slice(i));
        }
      }
      if (!type) return null;
    }
    for (const segment of rest) {
      const member = this.memberType(type, segment, new Set());
      if (!member) return null;
      type = member;
    }
    return type;
  }

  private lookUpSimpleName(name: string, file: FileAnalysis, types: Map<string, TypeInfo>, context: string | undefined): TypeInfo | null {
    // Nested types of the enclosing classes, innermost first, and those they inherit.
    if (context) {
      const parts = context.split('.');
      for (let i = parts.length; i > 0; i--) {
        const enclosing = types.get(parts.slice(0, i).join('.'));
        if (!enclosing) continue;
        if (enclosing.path.endsWith(`.${name}`) || enclosing.path === name) return enclosing;
        const member = this.memberType(enclosing, name, new Set());
        if (member) return member;
      }
    }
    const topLevel = types.get(name);
    if (topLevel) return topLevel;
    for (const imp of file.imports) {
      if (imp.source.endsWith(`.${name}`)) return this.byQualifiedName.get(imp.source) ?? null;
    }
    const samePackage = this.byQualifiedName.get(file.packageName ? `${file.packageName}.${name}` : name);
    if (samePackage) return samePackage;
    for (const imp of file.imports) {
      if (!imp.source.endsWith('.*')) continue;
      const onDemand = this.byQualifiedName.get(`${imp.source.slice(0, -1)}${name}`);
      if (onDemand) return onDemand;
    }
    return null;
  }

  /** A type nested in `type`, or inherited by it from a supertype. */
  private memberType(type: TypeInfo, name: string, seen: Set<TypeInfo>): TypeInfo | null {
    if (seen.has(type)) return null;
    seen.add(type);
    const own = this.byFile.get(type.file)?.get(`${type.path}.${name}`);
    if (own) return own;
    for (const supertype of type.supertypes) {
      const inherited = this.memberType(supertype, name, seen);
      if (inherited) return inherited;
    }
    return null;
  }
}

function memo(
  cache: Map<TypeInfo, Map<string, ParsedFunction[]>>,
  type: TypeInfo,
  site: CallSite,
  compute: () => ParsedFunction[],
): ParsedFunction[] {
  let byKey = cache.get(type);
  if (!byKey) {
    byKey = new Map();
    cache.set(type, byKey);
  }
  const key = `${site.name}/${site.args}`;
  let result = byKey.get(key);
  if (!result) {
    result = compute();
    byKey.set(key, result);
  }
  return result;
}

function simpleName(type: string): string {
  return type.slice(type.lastIndexOf('.') + 1);
}

function dimensions(type: string): number {
  let dims = 0;
  for (let end = type.length; type.endsWith('[]', end); end -= 2) dims++;
  return dims;
}

function isSubtype(type: TypeInfo, of: TypeInfo): boolean {
  const seen = new Set<TypeInfo>();
  const stack = [type];
  while (stack.length > 0) {
    const t = stack.pop()!;
    if (t === of) return true;
    if (seen.has(t)) continue;
    seen.add(t);
    stack.push(...t.supertypes);
  }
  return false;
}

/** Whether `type` or a repository supertype of it names `name` as a supertype - a library interface it implements. */
function hasSupertypeNamed(type: TypeInfo, name: string): boolean {
  const seen = new Set<TypeInfo>();
  const stack = [type];
  while (stack.length > 0) {
    const t = stack.pop()!;
    if (seen.has(t)) continue;
    seen.add(t);
    if (t.supertypeNames.some((s) => simpleName(s) === name)) return true;
    stack.push(...t.supertypes);
  }
  return false;
}

/** Whether a call with `args` arguments can be a call to `fn`; -1 means the call site did not say. */
function fits(fn: ParsedFunction, args: number): boolean {
  if (args < 0) return true;
  const params = fn.parameters.length;
  return fn.isVariadic ? args >= params - 1 : args === params;
}
