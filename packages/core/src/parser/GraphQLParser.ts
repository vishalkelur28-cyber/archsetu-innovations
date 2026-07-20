import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction } from '../types/parser.types.js';
import { extractFunctionBody } from './BaseParser.js';

/** type Name { or interface Name { or input Name { or enum Name { */
const TYPE_DEF = /^(type|interface|input|enum)\s+(\w+)(?:\s+implements\s+[\w\s&]+)?\s*\{/gm;

/** A field shaped like a resolver: name(arg: Type, ...): ReturnType - has parentheses, unlike a plain data field. */
const RESOLVER_FIELD = /^\s*(\w+)\s*\(([^)]*)\)\s*:/gm;

export const GraphQLParser: LanguageParser = {
  language: 'graphql',
  extensions: ['.graphql', '.gql'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // type/interface/input/enum blocks, modeled as classes. A resolver-
    // shaped field (has an argument list, e.g. `user(id: ID!): User`) is
    // extracted separately below as a function - a plain data field
    // (`name: String!`, no parens) has nothing function-like to analyze.
    const typePattern = new RegExp(TYPE_DEF.source, 'gm');
    while ((m = typePattern.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);
      exports.push(name);
      classes.push({
        name, filePath, startLine, endLine: endLine + 1, methods: [],
        ...(kind ? { extends: kind } : {}),
        isExported: true,
      });

      const fieldPattern = new RegExp(RESOLVER_FIELD.source, 'gm');
      let fm: RegExpExecArray | null;
      while ((fm = fieldPattern.exec(body)) !== null) {
        const fieldName = fm[1];
        if (!fieldName) continue;
        const fieldLine = startLine + linesBefore(body, fm.index);
        exports.push(fieldName);
        functions.push({
          name: fieldName,
          filePath,
          startLine: fieldLine,
          endLine: fieldLine,
          parameters: parseParams(fm[2] ?? ''),
          isExported: true,
          isAsync: false,
          calls: [],
          complexity: 1,
          lineCount: 1,
          language: 'graphql',
        });
      }
    }

    return {
      filePath,
      language: 'graphql',
      functions,
      classes,
      imports: [],
      exports: [...new Set(exports)],
      lineCount,
      complexity: 1,
      explanation: `${path.basename(filePath, path.extname(filePath))} defines ${classes.length} type${classes.length === 1 ? '' : 's'} and ${functions.length} resolver field${functions.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}

function parseParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim().split(/\s*:/)[0]?.trim() ?? '')
    .filter(Boolean);
}
