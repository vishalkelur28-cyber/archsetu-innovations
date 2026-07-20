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
  isAsync: boolean;
  /** Names of functions this function calls within the same repo */
  calls: string[];
  /** Cyclomatic complexity score - see ComplexityAnalyzer for rules */
  complexity: number;
  lineCount: number;
  language: SupportedLanguage;
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
}

export interface LanguageParser {
  language: SupportedLanguage;
  extensions: string[];
  parseFile(content: string, filePath: string): FileAnalysis;
}
