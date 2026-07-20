import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedFunction, ParsedImport } from '../types/parser.types.js';
import { extractFunctionBody } from './BaseParser.js';

/** message Name { or service Name { */
const BLOCK_DEF = /^(message|service|enum)\s+(\w+)\s*\{/gm;

/** rpc MethodName(RequestType) returns (ResponseType); */
const RPC_DEF = /^\s*rpc\s+(\w+)\s*\(([^)]*)\)\s*returns\s*\(([^)]*)\)/gm;

/** import "other.proto"; */
const IMPORT_STMT = /^import\s+(?:public\s+)?"([^"]+)"/gm;

export const ProtobufParser: LanguageParser = {
  language: 'protobuf',
  extensions: ['.proto'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const functions: ParsedFunction[] = [];
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    const importPattern = new RegExp(IMPORT_STMT.source, 'gm');
    while ((m = importPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: !src.includes('/') || src.startsWith('.') });
    }

    // message/service/enum blocks, modeled as classes - a service's rpc
    // methods are extracted separately below as functions, since a service
    // block is really a named group of callable operations, closer to an
    // interface than a data structure.
    const blockPattern = new RegExp(BLOCK_DEF.source, 'gm');
    while ((m = blockPattern.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      if (!name) continue;
      const startLine = linesBefore(content, m.index) + 1;
      const { endLine } = extractFunctionBody(lines, startLine - 1);
      exports.push(name);
      classes.push({
        name, filePath, startLine, endLine: endLine + 1, methods: [],
        ...(kind ? { extends: kind } : {}),
        isExported: true,
      });
    }

    const rpcPattern = new RegExp(RPC_DEF.source, 'gm');
    while ((m = rpcPattern.exec(content)) !== null) {
      const name = m[1];
      if (!name) continue;
      const requestType = (m[2] ?? '').replace(/^stream\s+/, '').trim();
      const startLine = linesBefore(content, m.index) + 1;
      exports.push(name);

      functions.push({
        name,
        filePath,
        startLine,
        endLine: startLine,
        parameters: requestType ? [requestType] : [],
        isExported: true,
        isAsync: false,
        calls: [],
        complexity: 1,
        lineCount: 1,
        language: 'protobuf',
      });
    }

    return {
      filePath,
      language: 'protobuf',
      functions,
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: 1,
      explanation: `${path.basename(filePath, '.proto')} defines ${classes.length} message/service block${classes.length === 1 ? '' : 's'} and ${functions.length} RPC method${functions.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}
