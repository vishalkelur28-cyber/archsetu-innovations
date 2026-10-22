/**
 * All shared TypeScript interfaces for the ArchSetu parser layer.
 * These types form the contract between language parsers and the analysis engine.
 */

export type SupportedLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'swift'
  | 'scala'
  | 'dart'
  | 'r'
  | 'shell'
  | 'html'
  | 'css'
  | 'lua'
  | 'perl'
  | 'haskell'
  | 'elixir'
  | 'objectivec'
  | 'zig'
  | 'solidity'
  | 'powershell'
  | 'groovy'
  | 'ocaml'
  | 'erlang'
  | 'clojure'
  | 'fsharp'
  | 'julia'
  | 'nim'
  | 'crystal'
  | 'vimscript'
  | 'elisp'
  | 'makefile'
  | 'dockerfile'
  | 'terraform'
  | 'sql'
  | 'vue'
  | 'svelte'
  | 'yaml'
  | 'protobuf'
  | 'graphql'
  | 'batch'
  | 'unknown';

export interface ParsedFunction {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  parameters: string[];
  isExported: boolean;
  /**
   * True when this function is the file's default export (`export default
   * function name() {}`), as opposed to a named export (`export function
   * name() {}`) or not exported at all. Only populated by parsers that can
   * distinguish the two (currently JsTsParser); other languages leave this
   * undefined. Needed to match framework file-convention exports (e.g. a
   * Next.js `page.tsx` default export) - see FrameworkConventions.ts.
   */
  isDefaultExport?: boolean;
  /**
   * True when something outside this repository's code calls the function by
   * contract - a test runner (`#[test]`, `@Test`), a framework annotation
   * (`@GetMapping`, `@app.route`), the language runtime (`__exit__`), or
   * dispatch through a supertype (`@Override`, `impl Trait for T`). Set by
   * markImplicitlyInvoked after parsing; DeadCodeFinder never reports these.
   */
  isImplicitlyInvoked?: boolean;
  isAsync: boolean;
  /** Names of functions this function calls within the same repo */
  calls: string[];
  /**
   * Each call with what the parser could tell about its target: the type it
   * is looked up in and the number of arguments. Where present, the call
   * graph links calls by these instead of by name alone. Only parsers that
   * can type receivers set it (currently JavaParser).
   */
  callSites?: CallSite[];
  /** The declaring type, as a path of nested type names within the file: `Outer.Inner`, `Outer.$1` for an anonymous class. */
  className?: string;
  isConstructor?: boolean;
  /** The last parameter takes any number of arguments (`String... args`). */
  isVariadic?: boolean;
  /** Each parameter's declared type, as written (`String`, `int[]`); a type variable is replaced by its bound, or Object. */
  parameterTypes?: (string | null)[];
  /**
   * The declared return type, as written; null where it is a type variable
   * without a bound, and `<self>` for a type variable bounded by the declaring
   * class itself (`B extends Builder<B>`), which returns the receiver's type.
   */
  returnType?: string | null;
  /** Cyclomatic complexity score - see ComplexityAnalyzer for rules */
  complexity: number;
  lineCount: number;
  language: SupportedLanguage;
}

export interface CallSite {
  /** The method called, or for a constructor call the class constructed. */
  name: string;
  /** Arguments passed, or -1 when the call site does not say (a method reference). */
  args: number;
  /**
   * The type of each argument where the expression shows it - a literal, a
   * variable, `new Foo()`, a cast - or null. `null` is the null literal and
   * `->` a lambda or method reference. Picks between overloads.
   */
  argTypes?: (string | null)[];
  /**
   * - `member`: an instance method, dispatched at run time, so an override
   *   in a subtype of the receiver can be the one that runs;
   * - `static`: `Type.name()`, looked up in that type and its supertypes;
   * - `super`: `super.name()`, looked up from the supertypes of the first receiver;
   * - `new`: a constructor of the first receiver;
   * - `unknown`: the receiver's type could not be told, so only the name is known.
   */
  kind: 'member' | 'static' | 'super' | 'new' | 'unknown';
  /**
   * Types to look the name up in, in order, as written in the source or as a
   * nested-type path within the file; the first that has the name wins. An
   * unqualified call lists its enclosing types, innermost first, then any
   * statically imported types.
   */
  receivers?: string[];
  /**
   * For a receiver the parser could not type that is read from a field of a
   * known type - `System.out` in `System.out.println()` - that type. When it
   * is not declared in the repository, the call cannot reach the repository.
   */
  via?: string;
  /** For `a.b().c()`, the call `b()` whose result `c()` is called on. */
  receiverCall?: CallSite;
  /**
   * For a receiver that is a field the parser could not type: its name. The
   * field is declared in `via`, or, without `via`, inherited by the caller's
   * class from a supertype - possibly one in another file.
   */
  field?: string;
  /** For each argument that is itself a call, that call; its declared return type stands in for the argument's type. */
  argCalls?: (CallSite | null)[];
}

export interface ParsedImport {
  /** The module specifier (file path or package name) */
  source: string;
  /** Named exports imported from the source */
  symbols: string[];
  /** True when the import path starts with . or .. */
  isRelative: boolean;
  /** Absolute path if the relative import has been resolved */
  resolvedPath?: string;
}

export interface ParsedClass {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  methods: ParsedFunction[];
  extends?: string;
  implements?: string[];
  isExported: boolean;
  /** Nested type path within the file (`Outer.Inner`), where the parser tracks nesting. */
  path?: string;
  /** The declared types of the class's fields, where the parser tracks them. */
  fields?: Record<string, string>;
  kind?: 'class' | 'interface' | 'enum' | 'record' | 'annotation';
}

export interface FileAnalysis {
  filePath: string;
  language: SupportedLanguage;
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: ParsedImport[];
  exports: string[];
  lineCount: number;
  /** Average cyclomatic complexity across all functions in this file */
  complexity: number;
  /** Human-readable 1-2 sentence description of what this file does */
  explanation: string;
  /**
   * Names referenced anywhere in the file that a per-function `calls` scan can't
   * attribute to a specific caller - module-top-level statements, property/prototype
   * -assigned function bodies the parser doesn't model as functions, and anonymous
   * inline callback bodies. Used by DeadCodeFinder as an additional liveness signal;
   * intentionally not used to draw call-graph edges since there's no known caller.
   */
  moduleLevelCalls?: string[];
  /**
   * True when the file carries a generator's header (`Code generated ... DO
   * NOT EDIT.`, `@generated`). Its functions are never reported as dead code:
   * the fix for an unused generated function is to regenerate, not to edit.
   */
  isGenerated?: boolean;
  /** The file's package (`package a.b;`), where the language has one. */
  packageName?: string;
  /**
   * Anonymous classes, kept apart from `classes` so they are not counted or
   * listed as types; the call graph needs their supertypes to resolve the
   * calls made inside them.
   */
  anonymousClasses?: ParsedClass[];
}

export interface LanguageParser {
  language: SupportedLanguage;
  extensions: string[];
  parseFile(content: string, filePath: string): FileAnalysis;
}
