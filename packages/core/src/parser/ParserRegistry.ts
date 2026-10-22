/**
 * Routes source files to the correct language parser.
 * All parsers are registered here and selected by file extension.
 */

import { detectLanguage } from './LanguageDetector.js';
import { JsTsParser } from './JsTsParser.js';
import { PythonParser } from './PythonParser.js';
import { JavaParser } from './JavaParser.js';
import { GoParser } from './GoParser.js';
import { RustParser } from './RustParser.js';
import { CppParser } from './CppParser.js';
import { CsharpParser } from './CsharpParser.js';
import { RubyParser } from './RubyParser.js';
import { PhpParser } from './PhpParser.js';
import { KotlinParser } from './KotlinParser.js';
import { SwiftParser } from './SwiftParser.js';
import { ScalaParser } from './ScalaParser.js';
import { DartParser } from './DartParser.js';
import { ShellParser } from './ShellParser.js';
import { LuaParser } from './LuaParser.js';
import { PerlParser } from './PerlParser.js';
import { HaskellParser } from './HaskellParser.js';
import { ElixirParser } from './ElixirParser.js';
import { ObjectiveCParser } from './ObjectiveCParser.js';
import { ZigParser } from './ZigParser.js';
import { SolidityParser } from './SolidityParser.js';
import { PowerShellParser } from './PowerShellParser.js';
import { GroovyParser } from './GroovyParser.js';
import { OCamlParser } from './OCamlParser.js';
import { ErlangParser } from './ErlangParser.js';
import { ClojureParser } from './ClojureParser.js';
import { FSharpParser } from './FSharpParser.js';
import { JuliaParser } from './JuliaParser.js';
import { NimParser } from './NimParser.js';
import { CrystalParser } from './CrystalParser.js';
import { VimScriptParser } from './VimScriptParser.js';
import { EmacsLispParser } from './EmacsLispParser.js';
import { MakefileParser } from './MakefileParser.js';
import { DockerfileParser } from './DockerfileParser.js';
import { TerraformParser } from './TerraformParser.js';
import { SqlParser } from './SqlParser.js';
import { VueParser } from './VueParser.js';
import { SvelteParser } from './SvelteParser.js';
import { ProtobufParser } from './ProtobufParser.js';
import { GraphQLParser } from './GraphQLParser.js';
import { BatchParser } from './BatchParser.js';
import { markImplicitlyInvoked } from './ImplicitInvocation.js';
import { codeOf } from './LexicalSyntax.js';

import type { FileAnalysis, LanguageParser, SupportedLanguage } from '../types/parser.types.js';

const PARSERS: Map<SupportedLanguage, LanguageParser> = new Map([
  ['javascript', JsTsParser],
  ['typescript', JsTsParser],
  ['python', PythonParser],
  ['java', JavaParser],
  ['go', GoParser],
  ['rust', RustParser],
  ['c', CppParser],
  ['cpp', CppParser],
  ['csharp', CsharpParser],
  ['ruby', RubyParser],
  ['php', PhpParser],
  ['kotlin', KotlinParser],
  ['swift', SwiftParser],
  ['scala', ScalaParser],
  ['dart', DartParser],
  ['shell', ShellParser],
  ['lua', LuaParser],
  ['perl', PerlParser],
  ['haskell', HaskellParser],
  ['elixir', ElixirParser],
  ['objectivec', ObjectiveCParser],
  ['zig', ZigParser],
  ['solidity', SolidityParser],
  ['powershell', PowerShellParser],
  ['groovy', GroovyParser],
  ['ocaml', OCamlParser],
  ['erlang', ErlangParser],
  ['clojure', ClojureParser],
  ['fsharp', FSharpParser],
  ['julia', JuliaParser],
  ['nim', NimParser],
  ['crystal', CrystalParser],
  ['vimscript', VimScriptParser],
  ['elisp', EmacsLispParser],
  ['makefile', MakefileParser],
  ['dockerfile', DockerfileParser],
  ['terraform', TerraformParser],
  ['sql', SqlParser],
  ['vue', VueParser],
  ['svelte', SvelteParser],
  ['protobuf', ProtobufParser],
  ['graphql', GraphQLParser],
  ['batch', BatchParser],
]);

/**
 * Parses a single file and returns its structural analysis.
 * Returns null for unsupported file types.
 */
export function parseFile(content: string, filePath: string): FileAnalysis | null {
  const language = detectLanguage(filePath);
  // YAML is pure data (CI pipelines, k8s manifests, docker-compose) - no
  // function/class concept exists to extract, so it gets the same basic
  // line-count-only scan as html/css/r rather than a full LanguageParser.
  // Still worth detecting explicitly (rather than leaving it 'unknown' and
  // invisible to walkRepo entirely) since these files are common and
  // meaningful, unlike genuinely-generated noise like lockfiles.
  if (language === 'unknown' || language === 'html' || language === 'css' || language === 'r' || language === 'yaml') {
    return buildMinimalAnalysis(content, filePath, language);
  }

  const parser = PARSERS.get(language);
  if (!parser) return null;

  try {
    const analysis = parser.parseFile(content, filePath);
    dropDeclarationsOutsideCode(analysis, content);
    markImplicitlyInvoked(analysis, content);
    if (GENERATED_MARKER.test(content.slice(0, 2048))) analysis.isGenerated = true;
    return analysis;
  } catch {
    // Parser errors on malformed files should not abort the full repo analysis
    return buildMinimalAnalysis(content, filePath, language);
  }
}

/**
 * The header conventions tools write into files they generate: Go's
 * `// Code generated ... DO NOT EDIT.` (also emitted by protoc and goyacc for
 * other languages), `@generated`, and .NET's `<auto-generated>`.
 */
const GENERATED_MARKER = /\bCode generated\b.*\bDO NOT EDIT\b|@generated\b|<auto-generated\b/;

/**
 * Removes functions whose declaration line lies entirely inside a comment or a
 * string. The parsers match declarations in raw text, so commented-out code
 * and code samples held in strings - a tool page's
 * `const SAMPLE = \`function processOrder(order) {...\``, a Storybook story's
 * example component, a test fixture - were reported as real functions: counted,
 * scored for complexity, and listed as dead code because nothing calls them.
 *
 * The first few lines must all be blank, not just the declaration line, so
 * that a parser reporting a line or two early (several did, until their
 * patterns stopped starting on the blank line above a declaration) can never
 * cost a real function.
 */
function dropDeclarationsOutsideCode(analysis: FileAnalysis, content: string): void {
  if (analysis.functions.length === 0) return;
  const code = codeOf(content, analysis.language);
  if (code === null) return;
  const codeLines = code.split('\n');
  const hasCode = (fn: FileAnalysis['functions'][number]): boolean =>
    codeLines.slice(fn.startLine - 1, Math.min(fn.endLine, fn.startLine + 3)).some((line) => line.trim() !== '');
  const kept = analysis.functions.filter(hasCode);
  if (kept.length === analysis.functions.length) return;
  analysis.functions = kept;
  analysis.complexity = kept.length > 0
    ? Math.round((kept.reduce((s, f) => s + f.complexity, 0) / kept.length) * 100) / 100
    : 1;
}

/** Creates a minimal analysis record for files where we have no full parser */
function buildMinimalAnalysis(content: string, filePath: string, language: SupportedLanguage): FileAnalysis {
  return {
    filePath,
    language,
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    lineCount: content.split('\n').length,
    complexity: 1,
    explanation: `${filePath.split('/').pop() ?? filePath} - ${language} file (basic scan only).`,
  };
}
