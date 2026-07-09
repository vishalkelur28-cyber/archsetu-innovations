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
]);

/**
 * Parses a single file and returns its structural analysis.
 * Returns null for unsupported file types.
 */
export function parseFile(content: string, filePath: string): FileAnalysis | null {
  const language = detectLanguage(filePath);
  if (language === 'unknown' || language === 'html' || language === 'css' || language === 'r') {
    return buildMinimalAnalysis(content, filePath, language);
  }

  const parser = PARSERS.get(language);
  if (!parser) return null;

  try {
    return parser.parseFile(content, filePath);
  } catch {
    // Parser errors on malformed files should not abort the full repo analysis
    return buildMinimalAnalysis(content, filePath, language);
  }
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
