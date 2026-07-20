import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedImport } from '../types/parser.types.js';
import { extractFunctionBody } from './BaseParser.js';

/**
 * `resource "type" "name" {`, `module "name" {`, `data "type" "name" {`,
 * `variable "name" {`, `output "name" {`, `provider "name" {` - HCL's block
 * syntax. Group 1 is the block kind, group 2/3 are its one or two labels
 * (a `resource` has both a type and a name; `module`/`variable`/`output`
 * have just one).
 */
const BLOCK_DEF = /^(resource|module|data|variable|output|provider)\s+"([\w-]+)"(?:\s+"([\w-]+)")?\s*\{/gm;

/** source = "./modules/vpc" or source = "terraform-aws-modules/vpc/aws" inside a module block */
const MODULE_SOURCE = /\bsource\s*=\s*"([^"]+)"/;

export const TerraformParser: LanguageParser = {
  language: 'terraform',
  extensions: ['.tf', '.tfvars'],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;
    const blockPattern = new RegExp(BLOCK_DEF.source, 'gm');
    while ((m = blockPattern.exec(content)) !== null) {
      const kind = m[1];
      const label1 = m[2];
      const label2 = m[3];
      if (!kind || !label1) continue;
      const name = label2 ? `${label1}.${label2}` : label1;
      const startLine = linesBefore(content, m.index) + 1;
      const { body, endLine } = extractFunctionBody(lines, startLine - 1);

      if (kind === 'module') {
        const sourceMatch = MODULE_SOURCE.exec(body);
        if (sourceMatch?.[1]) {
          const src = sourceMatch[1];
          imports.push({ source: src, symbols: [], isRelative: src.startsWith('.') });
        }
      }

      exports.push(name);
      classes.push({
        name,
        filePath,
        startLine,
        endLine: endLine + 1,
        methods: [],
        extends: kind,
        isExported: true,
      });
    }

    return {
      filePath,
      language: 'terraform',
      functions: [],
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: 1,
      explanation: `${path.basename(filePath, path.extname(filePath))} defines ${classes.length} Terraform block${classes.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}
