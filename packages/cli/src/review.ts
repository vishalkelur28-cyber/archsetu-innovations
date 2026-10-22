/**
 * `archsetu review`: what a change touches, read off git and the engine.
 *
 * The git half collects the change - the lines it wrote and each changed
 * file's base version - and hands it to @archsetu/core's reviewChanges. The
 * rendering half turns the result into a terminal report, or the Markdown a
 * pull request comment carries. Both halves are here rather than in core
 * because core never runs git for anything but history, and never formats.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { REACH_DEPTH, REACH_LIMIT, analyzeSecurityRisk, detectLanguage, parseFile } from '@archsetu/core';
import type { ChangeReview, ChangedFile, ChangedFunction, FileAnalysis, LineRange, SecurityFinding } from '@archsetu/core';

export const REVIEW_CHECKS = ['security', 'complexity', 'unused', 'dependencies'] as const;
export type ReviewCheck = (typeof REVIEW_CHECKS)[number];

/** The HTML comment a pull request comment carries so a later run can find and replace it. */
export const REVIEW_COMMENT_MARKER = '<!-- archsetu-review -->';

const MAX_TABLE_ROWS = 10;
const MAX_LISTED_FINDINGS = 10;
const MAX_LISTED_CALLERS = 8;

/**
 * Languages whose caller counts were checked against real repositories and
 * found accurate - TypeScript (zod), Python (flask), Go (pocketbase) by hand,
 * Vue and Svelte through the JavaScript parser, and Java against javac's own
 * resolution of every call in seven repositories (commons-lang, commons-io,
 * commons-collections, gson, jsoup, TheAlgorithms, spring-petclinic): 91 to
 * 100% of counted callers real, 97 to 100% of real callers counted. Java
 * calls are linked by the receiver's type and the argument types, not the
 * name (see TypedCallResolver).
 *
 * Everywhere else the counts are marked approximate. Measured on ripgrep, a
 * name-matched call graph cannot tell `.build()` on one type from another:
 * 68% of counted Rust callers were real. Methods-on-objects languages that
 * were not measured (C#, Kotlin, Swift and the rest) are assumed no better.
 */
const VERIFIED_CALLER_LANGUAGES: ReadonlySet<string> = new Set(['javascript', 'typescript', 'vue', 'svelte', 'python', 'go', 'java']);

const LANGUAGE_NAMES: Record<string, string> = {
  java: 'Java', rust: 'Rust', csharp: 'C#', kotlin: 'Kotlin', swift: 'Swift', scala: 'Scala', cpp: 'C++', c: 'C',
  php: 'PHP', ruby: 'Ruby', dart: 'Dart', objectivec: 'Objective-C', groovy: 'Groovy',
};

const approximate = (f: ChangedFunction) => !VERIFIED_CALLER_LANGUAGES.has(f.language);

export class ReviewError extends Error {}

export interface CollectedChanges {
  gitRoot: string;
  /** The commit the working tree was compared against. */
  comparedWith: string;
  files: ChangedFile[];
  /** Things the reader should know about the comparison itself. */
  warnings: string[];
}

export interface CollectOptions {
  /** Absolute paths never to count as changed, such as the review's own --out file. */
  exclude?: readonly string[];
}

/**
 * Compares the working tree against where it left `baseRef` - the merge base
 * when git can find one, so a base branch that moved on since does not show
 * up as this change undoing its work. A shallow CI checkout has no merge base
 * to find; there the base commit itself is used, which is exact for a pull
 * request's merge commit when the base is its first parent.
 *
 * Uncommitted and untracked files count as part of the change, so running
 * this before committing reports what is about to be committed. Only changes
 * inside `scopeDir` are returned.
 */
export function collectChanges(scopeDir: string, baseRef: string, options: CollectOptions = {}): CollectedChanges {
  if (!fs.existsSync(scopeDir) || !fs.statSync(scopeDir).isDirectory()) {
    throw new ReviewError(`${scopeDir} is not a directory.`);
  }
  const gitRoot = fs.realpathSync.native(git(scopeDir, ['rev-parse', '--show-toplevel']).trim());
  const base = gitOrNull(gitRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])?.trim();
  if (!base) throw new ReviewError(missingBaseMessage(baseRef));
  const comparedWith = gitOrNull(gitRoot, ['merge-base', base, 'HEAD'])?.trim() || base;

  const warnings: string[] = [];
  // A pull request's merge commit in a shallow checkout: its first parent is
  // what the change was merged onto. Comparing with anything older counts the
  // base branch's own newer commits as part of the change.
  const parents = (gitOrNull(gitRoot, ['cat-file', '-p', 'HEAD']) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('parent '))
    .map((l) => l.slice('parent '.length).trim());
  if (parents.length === 2 && parents[0] !== comparedWith) {
    warnings.push(
      `The checked-out commit merges onto ${parents[0]!.slice(0, 12)}, not onto ${comparedWith.slice(0, 12)}, ` +
      'so commits on the base branch between the two are counted as part of this change.',
    );
  }

  const diff = git(gitRoot, [
    '-c', 'core.quotePath=false',
    'diff', '--no-color', '--no-ext-diff', '--unified=0', '--find-renames',
    '--diff-filter=d', '--src-prefix=a/', '--dst-prefix=b/',
    comparedWith, '--',
  ]);
  const entries = parseUnifiedDiff(diff);

  const excluded = new Set((options.exclude ?? []).map((p) => comparable(p)));
  const untracked = git(gitRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const rel of untracked) {
    if (excluded.has(comparable(path.join(gitRoot, rel)))) continue;
    entries.push({ path: rel, basePath: null, changedLines: [{ start: 1, end: Number.MAX_SAFE_INTEGER }], deletedAfter: [] });
  }

  const scope = fs.realpathSync.native(scopeDir);
  const inScope = entries.filter((e) => isWithin(path.join(gitRoot, e.path), scope));
  // Base contents are only needed to parse, and only parseable files have them worth reading.
  const baseContents = readBlobs(
    gitRoot,
    inScope
      .filter((e) => e.basePath !== null && detectLanguage(e.path) !== 'unknown')
      .map((e) => `${comparedWith}:${e.basePath}`),
  );

  const files = inScope.map((entry): ChangedFile => {
    const filePath = path.join(gitRoot, entry.path);
    const content = detectLanguage(entry.path) !== 'unknown' ? readOrUndefined(filePath) : undefined;
    return {
      filePath,
      baseFilePath: entry.basePath === null ? null : path.join(gitRoot, entry.basePath),
      changedLines: entry.changedLines,
      deletedAfter: entry.deletedAfter,
      baseContent: entry.basePath === null ? null : baseContents.get(`${comparedWith}:${entry.basePath}`) ?? null,
      ...(content === undefined ? {} : { content }),
    };
  });

  return { gitRoot, comparedWith, files, warnings };
}

/** What to do about a base the checkout does not have, for each way it can be written. */
function missingBaseMessage(baseRef: string): string {
  const missing = `"${baseRef}" is not a commit this checkout has.`;
  if (/^0+$/.test(baseRef)) {
    return `${missing} GitHub sends this all-zero commit for a push that creates a branch, so there is nothing to compare with. Pass a branch instead, such as --base origin/main.`;
  }
  if (/^[0-9a-f]{7,40}$/i.test(baseRef)) return `${missing} Fetch it first: git fetch --depth=1 origin ${baseRef}`;
  const branch = baseRef.replace(/^origin\//, '');
  return `${missing} Fetch it first: git fetch origin ${branch}` + (baseRef === branch ? `, then pass --base origin/${branch}` : '');
}

/**
 * Reads many blobs through one `git cat-file --batch` process. One process
 * per changed file cost tens of milliseconds each on Windows, which a change
 * touching thousands of files turned into minutes.
 */
function readBlobs(cwd: string, specs: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  // The batch protocol is one spec per line.
  const usable = specs.filter((s) => !s.includes('\n'));
  if (usable.length === 0) return blobs;
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd,
    input: usable.join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return blobs;
  const out = result.stdout;
  let pos = 0;
  for (const spec of usable) {
    const headerEnd = out.indexOf(0x0a, pos);
    if (headerEnd < 0) break;
    const header = out.subarray(pos, headerEnd).toString('utf8');
    pos = headerEnd + 1;
    const m = /^\S+ (\S+) (\d+)$/.exec(header);
    if (!m) continue; // "<spec> missing"
    const size = Number(m[2]);
    if (m[1] === 'blob') blobs.set(spec, out.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return blobs;
}

export interface DiffEntry {
  /** Repository-relative path after the change. */
  path: string;
  /** Repository-relative path before the change, or null when the change adds the file. */
  basePath: string | null;
  /** Lines the change wrote that hold more than whitespace. */
  changedLines: LineRange[];
  /** Lines after which the change only deleted. */
  deletedAfter: number[];
}

/**
 * Reads `git diff --unified=0` output. Only the new side of each hunk
 * matters: those are the lines the change wrote. A hunk that only deletes is
 * recorded as a deletion after a line, for the function spanning it.
 *
 * Lines that are only whitespace don't count. Indented languages give a
 * function its trailing blank lines, so a function added below another one -
 * which starts with a blank line - marked the one above it as changed.
 *
 * Each hunk's line counts are followed, so content lines are never read as
 * headers: an added line beginning `++ ` appears as `+++ ` and used to start
 * a new file entry, taking the rest of the file's hunks with it.
 */
export function parseUnifiedDiff(diff: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  let current = null as DiffEntry | null;
  let oldPath: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  let hunkStart = 0;
  let wrote = false;

  const endHunk = (deletedAfter: number) => {
    if (current && !wrote && deletedAfter > 0) current.deletedAfter.push(deletedAfter);
  };

  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-') && oldLeft > 0) {
        oldLeft--;
      } else if (line.startsWith('+') && newLeft > 0) {
        if (line.slice(1).trim() !== '') {
          addLine(current!, newLine);
          wrote = true;
        }
        newLine++;
        newLeft--;
      } else if (!line.startsWith('\\')) {
        // A truncated or unexpected hunk; stop trusting its counts.
        oldLeft = 0;
        newLeft = 0;
      }
      if (oldLeft === 0 && newLeft === 0) endHunk(hunkStart - 1);
      continue;
    }

    if (line.startsWith('diff --git ')) {
      current = null;
      oldPath = null;
    } else if (line.startsWith('rename from ')) {
      oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      // A pure rename has no ---/+++ lines at all, only these two.
      current = { path: unquote(line.slice('rename to '.length)), basePath: oldPath, changedLines: [], deletedAfter: [] };
      entries.push(current);
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4).replace(/\t$/, '');
      oldPath = p === '/dev/null' ? null : stripPrefix(unquote(p), 'a/');
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t$/, '');
      if (p === '/dev/null') continue;
      const newPath = stripPrefix(unquote(p), 'b/');
      if (current?.path === newPath) continue;
      current = { path: newPath, basePath: oldPath, changedLines: [], deletedAfter: [] };
      entries.push(current);
    } else if (line.startsWith('@@') && current) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      hunkStart = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
      newLine = hunkStart;
      wrote = false;
      // With no new lines, the new side's start is the line the deletion follows.
      if (newLeft === 0) hunkStart += 1;
      if (oldLeft === 0 && newLeft === 0) endHunk(hunkStart - 1);
    }
  }
  return entries;
}

function addLine(entry: DiffEntry, line: number): void {
  const last = entry.changedLines[entry.changedLines.length - 1];
  if (last && last.end === line - 1) last.end = line;
  else entry.changedLines.push({ start: line, end: line });
}

/** Git C-quotes a path holding a quote, backslash or control character, even with core.quotePath off. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  return p.slice(1, -1).replace(/\\([\\"tn])/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c));
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function isWithin(filePath: string, dir: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readOrUndefined(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function comparable(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Security findings for the changed files alone. The analysis's own scan
 * stops at 500 findings in walk order, so in a repository with that much old
 * debt a new `eval(` in a file late in the order was never seen. Paths go in
 * relative to the repository so a checkout that happens to sit under a
 * `test/` directory isn't read as all test code; findings come back absolute.
 */
export function scanChangedFiles(gitRoot: string, files: readonly ChangedFile[]): SecurityFinding[] {
  const analyses: FileAnalysis[] = [];
  const contents = new Map<string, string>();
  for (const file of files) {
    if (file.changedLines.length === 0) continue;
    const content = file.content ?? readOrUndefined(file.filePath);
    if (content === undefined) continue;
    const relative = `/${path.relative(gitRoot, file.filePath).split(path.sep).join('/')}`;
    const parsed = parseFile(content, relative);
    if (!parsed) continue;
    analyses.push(parsed);
    contents.set(relative, content);
  }
  return analyzeSecurityRisk(analyses, contents).findings.map((f) => ({
    ...f,
    filePath: path.join(gitRoot, f.filePath.slice(1)),
  }));
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw new ReviewError(`Could not run git: ${result.error.message}`);
  if (result.status !== 0) {
    throw new ReviewError(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout;
}

function gitOrNull(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

export function parseChecks(value: string | undefined): ReviewCheck[] {
  if (!value) return [];
  const names = value.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !(REVIEW_CHECKS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new ReviewError(`Unknown check "${unknown.join('", "')}". Choose from: ${REVIEW_CHECKS.join(', ')}.`);
  }
  return names as ReviewCheck[];
}

export function failedChecks(review: ChangeReview, checks: readonly ReviewCheck[]): ReviewCheck[] {
  const counts: Record<ReviewCheck, number> = {
    security: review.securityFindings.length,
    complexity: review.complexityIncreases.length,
    unused: review.unusedNewFunctions.length,
    dependencies: review.newUndeclaredImports.length,
  };
  return checks.filter((c) => counts[c] > 0);
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface ReviewContext {
  gitRoot: string;
  base: string;
  comparedWith: string;
  version: string;
  failed: readonly ReviewCheck[];
  warnings: readonly string[];
}

/** The review with repository-relative paths, for --json. Absolute paths would leak the runner's layout. */
export function reviewToJson(review: ChangeReview, ctx: ReviewContext): Record<string, unknown> {
  const rel = (p: string) => displayPath(p, ctx.gitRoot);
  const fn = (f: ChangedFunction) => ({
    ...f,
    filePath: rel(f.filePath),
    callers: f.callers.map((c) => ({ ...c, filePath: rel(c.filePath) })),
  });
  return {
    base: ctx.base,
    comparedWith: ctx.comparedWith,
    changedFiles: review.changedFiles,
    testFilesChanged: review.testFilesChanged,
    changedFunctions: review.changedFunctions.map(fn),
    securityFindings: review.securityFindings.map((f) => ({ ...f, filePath: rel(f.filePath) })),
    complexityIncreases: review.complexityIncreases.map(fn),
    unusedNewFunctions: review.unusedNewFunctions.map(fn),
    newUndeclaredImports: review.newUndeclaredImports.map((u) => ({ ...u, filePaths: u.filePaths.map(rel) })),
    analysisTruncated: review.analysisTruncated,
    callGraphTruncated: review.callGraphTruncated,
    warnings: ctx.warnings,
    failedChecks: ctx.failed,
    markdown: renderMarkdown(review, ctx),
  };
}

export function renderMarkdown(review: ChangeReview, ctx: ReviewContext): string {
  const rel = (p: string) => displayPath(p, ctx.gitRoot);
  const out: string[] = [REVIEW_COMMENT_MARKER, '### ArchSetu: what this change touches', ''];
  const fns = review.changedFunctions;
  const fileCount = new Set(fns.map((f) => f.filePath)).size;

  if (fns.length === 0) {
    out.push(`This change does not touch any function ArchSetu parses (${plural(review.changedFiles, 'file')} changed).`);
  } else {
    out.push(`**${plural(fns.length, 'function')} changed in ${plural(fileCount, 'file')}.**${widestReach(fns)}`);
    out.push('');
    out.push(`| Function | Change | Direct callers | Within ${REACH_DEPTH} calls | Risk | Complexity |`);
    out.push('|---|---|---|---|---|---|');
    for (const f of fns.slice(0, MAX_TABLE_ROWS)) {
      const shared = (f.sameNameElsewhere > 0 ? ' †' : '') + (f.standardMethodName ? ' ‡' : '');
      out.push(
        `| \`${escapeCell(f.name)}\`${shared}<br><sub>\`${escapeCell(rel(f.filePath))}:${f.startLine}\`</sub> ` +
        `| ${f.change} | ${approx(f)}${directCallers(f)} | ${approx(f)}${reach(f)} | ${riskLabel(f.riskLevel)} | ${complexityChange(f)} |`,
      );
    }
    if (fns.length > MAX_TABLE_ROWS) {
      out.push('', `_…and ${plural(fns.length - MAX_TABLE_ROWS, 'more changed function')} with a smaller reach._`);
    }
    const shown = fns.slice(0, MAX_TABLE_ROWS);
    if (shown.some((f) => f.sameNameElsewhere > 0)) {
      out.push(
        '',
        '† Shares its name with another function. Calls are matched by name, so callers of the other may be counted here too; ' +
        'callers in other directories count only where an import shows which one they mean.',
      );
    }
    if (shown.some((f) => f.standardMethodName)) {
      out.push('', '‡ Also the name of a standard-library method (`get`, `then`, `close`…), so only callers in its own file are counted.');
    }
    const approximateLanguages = [...new Set(shown.filter(approximate).map((f) => LANGUAGE_NAMES[f.language] ?? f.language))];
    if (approximateLanguages.length > 0) {
      out.push(
        '',
        `≈ Approximate for ${approximateLanguages.join(', ')}. Calls are matched by name, which cannot tell a method on one type ` +
        'from a same-named method on another, or one overload from the next, so these counts can include callers of those and miss real ones. ' +
        'Check them against the callers listed below.',
      );
    }
    const withCallers = shown.filter((f) => f.callers.length > 0);
    if (withCallers.length > 0) {
      out.push('', '<details><summary>Direct callers</summary>', '');
      for (const f of withCallers) {
        const listed = f.callers.slice(0, MAX_LISTED_CALLERS)
          .map((c) => `\`${escapeCell(c.name)}\` (\`${rel(c.filePath)}:${c.startLine}\`)`);
        const more = f.directCallers - listed.length;
        out.push(
          `- \`${escapeCell(f.name)}\` (\`${rel(f.filePath)}:${f.startLine}\`) ← ${listed.join(', ')}` +
          `${more > 0 ? `, and ${more.toLocaleString('en-US')} more` : ''}`,
        );
      }
      out.push('', '</details>');
    }
  }

  const issues: string[] = [];
  for (const f of review.securityFindings.slice(0, MAX_LISTED_FINDINGS)) {
    issues.push(`- **Security** (${f.severity}) \`${rel(f.filePath)}:${f.line}\`: ${f.description}`);
  }
  for (const f of review.complexityIncreases.slice(0, MAX_LISTED_FINDINGS)) {
    const from = f.baseComplexity === null ? 'is new and has' : `went from ${f.baseComplexity} to`;
    issues.push(`- **Complexity** \`${f.name}\` (\`${rel(f.filePath)}:${f.startLine}\`) ${from} complexity ${f.complexity}.`);
  }
  for (const f of review.unusedNewFunctions.slice(0, MAX_LISTED_FINDINGS)) {
    issues.push(`- **Unused** \`${f.name}\` (\`${rel(f.filePath)}:${f.startLine}\`) is new, private, and nothing calls it.`);
  }
  for (const u of review.newUndeclaredImports.slice(0, MAX_LISTED_FINDINGS)) {
    issues.push(`- **Dependency** \`${u.packageName}\` is now imported in ${u.filePaths.map((p) => `\`${rel(p)}\``).join(', ')} but no package.json declares it.`);
  }
  if (issues.length > 0) {
    out.push('', '#### Worth a look', '', ...issues);
    const hidden = hiddenCount(review);
    if (hidden > 0) out.push(`- _…and ${hidden} more. Run \`archsetu review --base ${ctx.base}\` locally for the full list._`);
  }

  if (fns.length > 0 && review.testFilesChanged === 0) {
    out.push('', 'No test file changed.');
  }

  if (ctx.failed.length > 0) {
    out.push('', `**Failed checks:** ${ctx.failed.join(', ')}.`);
  }

  const notes = [...ctx.warnings, ...limitNotes(review)];
  if (notes.length > 0) out.push('', ...notes.map((n) => `> **Note:** ${n}`));

  out.push(
    '',
    '<details><summary>How this was worked out</summary>',
    '',
    'ArchSetu parsed the whole repository inside this run and built its call graph, then matched the changed lines against it. ' +
    `Nothing was uploaded. "Within ${REACH_DEPTH} calls" counts every function that reaches the changed one through at most ${REACH_DEPTH} calls, ` +
    'direct callers included; risk is graded from that count. ' +
    'Calls are matched by function name, and a caller in another file counts only where the name can mean just this function: ' +
    'one no other file in its directory declares, or - from further away - an exported one that no other file declares, ' +
    'or that the caller\'s file imports. ' +
    'So a count can miss callers - dynamic dispatch, reflection, calls on objects whose type the name does not settle, ' +
    'callers outside this repository - and can include a call to a same-named function in a library or another type. ' +
    'Every count lists its callers above, so each one can be checked. The same code always gives the same report.',
    '',
    `Compared with \`${ctx.comparedWith.slice(0, 12)}\` (${escapeCell(ctx.base)}). ArchSetu CLI ${ctx.version}.`,
    '</details>',
  );

  return out.join('\n');
}

export function renderText(review: ChangeReview, ctx: ReviewContext, color: TextColors): string {
  const rel = (p: string) => displayPath(p, ctx.gitRoot);
  const out: string[] = ['', color.bold('──── ArchSetu review ────'), color.dim(`Compared with ${ctx.comparedWith.slice(0, 12)} (${ctx.base})`), ''];
  const fns = review.changedFunctions;

  if (fns.length === 0) {
    out.push(`No function ArchSetu parses was changed (${plural(review.changedFiles, 'file')} changed).`);
  } else {
    out.push(color.bold(`${plural(fns.length, 'function')} changed`));
    for (const f of fns.slice(0, 25)) {
      const risk = f.riskLevel === 'critical' || f.riskLevel === 'high' ? color.red(f.riskLevel) : f.riskLevel === 'medium' ? color.yellow(f.riskLevel) : color.green(f.riskLevel);
      out.push(
        `  ${f.name}${f.sameNameElsewhere > 0 ? color.dim(' (shared name)') : ''}` +
        `${f.standardMethodName ? color.dim(' (standard method name: same-file callers only)') : ''} ${color.dim(`${rel(f.filePath)}:${f.startLine}`)}\n` +
        `    ${f.change}, direct callers: ${approx(f)}${directCallers(f)}, within ${REACH_DEPTH} calls: ${approx(f)}${reach(f)}, ` +
        `risk ${risk}, complexity ${complexityChange(f)}`,
      );
    }
    if (fns.length > 25) out.push(color.dim(`  … and ${fns.length - 25} more`));
    if (fns.some(approximate)) {
      out.push(color.dim('  ≈ approximate: in this language a name cannot tell same-named methods or overloads apart; see the callers in --json'));
    }
  }

  const section = (title: string, lines: string[]) => {
    if (lines.length === 0) return;
    out.push('', color.bold(title), ...lines.map((l) => `  ${l}`));
  };
  section('Security', review.securityFindings.map((f) => `${color.red(f.severity)} ${rel(f.filePath)}:${f.line} ${f.description}`));
  section('Complexity', review.complexityIncreases.map((f) => `${f.name} ${color.dim(`${rel(f.filePath)}:${f.startLine}`)} ${complexityChange(f)}`));
  section('Unused new functions', review.unusedNewFunctions.map((f) => `${f.name} ${color.dim(`${rel(f.filePath)}:${f.startLine}`)}`));
  section('Undeclared dependencies', review.newUndeclaredImports.map((u) => `${u.packageName} ${color.dim(u.filePaths.map(rel).join(', '))}`));

  if (fns.length > 0 && review.testFilesChanged === 0) out.push('', color.dim('No test file changed.'));
  for (const note of [...ctx.warnings, ...limitNotes(review)]) out.push('', color.yellow(`Note: ${note}`));
  if (ctx.failed.length > 0) out.push('', color.red(`Failed checks: ${ctx.failed.join(', ')}`));
  out.push('');
  return out.join('\n');
}

function limitNotes(review: ChangeReview): string[] {
  const notes: string[] = [];
  if (review.analysisTruncated) {
    notes.push('The repository has more files than the analysis limit, so some were not parsed; raise it with --max-files.');
  }
  if (review.callGraphTruncated) {
    notes.push("The repository is past the call graph's size cap, so its least-connected functions were left out.");
  }
  return notes;
}

export interface TextColors {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
}

function widestReach(fns: readonly ChangedFunction[]): string {
  const top = fns[0];
  if (!top || top.affectedFunctions === 0) return ' Nothing else in the repository calls them.';
  return ` The widest reach is \`${escapeCell(top.name)}\`: ${plural(top.directCallers, 'direct caller')}, ` +
    `${functionCount(top)} in ${plural(top.affectedFiles, 'file')} within ${REACH_DEPTH} calls.`;
}

function functionCount(f: ChangedFunction): string {
  return f.reachCapped ? `${REACH_LIMIT.toLocaleString('en-US')}+ functions` : plural(f.affectedFunctions, 'function');
}

function approx(f: ChangedFunction): string {
  return approximate(f) ? '≈ ' : '';
}

function directCallers(f: ChangedFunction): string {
  if (f.directCallers === 0) return 'none';
  return `${f.directCallers.toLocaleString('en-US')} in ${plural(f.directCallerFiles, 'file')}`;
}

function reach(f: ChangedFunction): string {
  if (f.affectedFunctions === 0) return 'none';
  const entry = f.affectedEntryPoints > 0 ? `, ${plural(f.affectedEntryPoints, 'entry point')}` : '';
  return `${functionCount(f)} in ${plural(f.affectedFiles, 'file')}${entry}`;
}

function complexityChange(f: ChangedFunction): string {
  if (f.baseComplexity === null) return `${f.complexity} (new)`;
  if (f.baseComplexity === f.complexity) return String(f.complexity);
  return `${f.baseComplexity} → ${f.complexity}`;
}

function riskLabel(level: ChangedFunction['riskLevel']): string {
  return level === 'critical' || level === 'high' ? `**${level}**` : level;
}

function hiddenCount(review: ChangeReview): number {
  return [review.securityFindings, review.complexityIncreases, review.unusedNewFunctions, review.newUndeclaredImports]
    .reduce((sum, list) => sum + Math.max(0, list.length - MAX_LISTED_FINDINGS), 0);
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function displayPath(filePath: string, gitRoot: string): string {
  return path.relative(gitRoot, filePath).replace(/\\/g, '/');
}
