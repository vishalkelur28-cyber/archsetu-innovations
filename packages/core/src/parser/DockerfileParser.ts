import path from 'path';
import type { FileAnalysis, LanguageParser, ParsedImport } from '../types/parser.types.js';

/**
 * FROM [--platform=<platform>] image:tag [AS stageName] - starts a new
 * build stage. The optional `--platform=...` flag (BuildKit's standard
 * multi-arch syntax, e.g. `FROM --platform=$BUILDPLATFORM node:20 AS
 * builder`) has to be skipped explicitly - without it, `\S+` greedily
 * grabs the flag itself as if it were the image name, and the `AS name`
 * that actually follows the real image name several tokens later never
 * matches at all (both the image and the stage name come out wrong).
 */
const FROM_STMT = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+([\w-]+))?/gim;

/** COPY --from=builder /app/dist ./dist - references another stage as a source. */
const COPY_FROM = /^COPY\s+--from=(\S+)/gim;

export const DockerfileParser: LanguageParser = {
  language: 'dockerfile',
  extensions: [],

  parseFile(content: string, filePath: string): FileAnalysis {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const classes: FileAnalysis['classes'] = [];
    const imports: ParsedImport[] = [];
    const exports: string[] = [];

    let m: RegExpExecArray | null;

    // A base image is the closest thing a Dockerfile has to an import - the
    // build depends entirely on what that image provides.
    const fromMatches: Array<{ image: string; stage: string | null; index: number }> = [];
    const fromPattern = new RegExp(FROM_STMT.source, 'gim');
    while ((m = fromPattern.exec(content)) !== null) {
      const image = m[1] ?? '';
      const stage = m[2] ?? null;
      fromMatches.push({ image, stage, index: m.index });
      // A stage referencing an earlier stage by name (multi-stage builds)
      // isn't an external dependency - only a real image reference is.
      const referencesEarlierStage = fromMatches.some((f) => f.stage === image);
      imports.push({ source: image, symbols: [], isRelative: referencesEarlierStage });
    }

    const copyFromPattern = new RegExp(COPY_FROM.source, 'gim');
    while ((m = copyFromPattern.exec(content)) !== null) {
      const src = m[1] ?? '';
      imports.push({ source: src, symbols: [], isRelative: true });
    }

    // Each FROM starts a new build stage - modeled as a class since a stage
    // is a named, self-contained block of sequential instructions, closer
    // to Objective-C's @interface/@implementation blocks than to a function.
    for (let i = 0; i < fromMatches.length; i++) {
      const current = fromMatches[i];
      if (!current) continue;
      const next = fromMatches[i + 1];
      const startLine = linesBefore(content, current.index) + 1;
      const endLine = next ? linesBefore(content, next.index) : lineCount;
      const name = current.stage ?? `stage-${i}`;
      exports.push(name);
      classes.push({
        name,
        filePath,
        startLine,
        endLine,
        methods: [],
        extends: current.image,
        isExported: true,
      });
    }

    return {
      filePath,
      language: 'dockerfile',
      functions: [],
      classes,
      imports,
      exports: [...new Set(exports)],
      lineCount,
      complexity: 1,
      explanation: `${path.basename(filePath)} defines ${classes.length} build stage${classes.length === 1 ? '' : 's'}.`,
    };
  },
};

function linesBefore(content: string, index: number): number {
  return content.slice(0, index).split('\n').length - 1;
}
