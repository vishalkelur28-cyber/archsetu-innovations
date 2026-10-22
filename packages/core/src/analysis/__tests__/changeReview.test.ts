import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { analyzeRepo } from '../RepoAnalyzer.js';
import { REACH_DEPTH, REACH_LIMIT, reviewChanges, type ChangedFile } from '../ChangeReview.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archsetu-review-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  return dir;
}

function lineOf(content: string, needle: string): number {
  const index = content.split('\n').findIndex((l) => l.includes(needle));
  if (index < 0) throw new Error(`"${needle}" not found`);
  return index + 1;
}

function change(dir: string, rel: string, lines: Array<[number, number]>, baseContent: string | null): ChangedFile {
  return {
    filePath: path.join(dir, rel),
    baseFilePath: baseContent === null ? null : path.join(dir, rel),
    changedLines: lines.map(([start, end]) => ({ start, end })),
    baseContent,
  };
}

const CORE = [
  'export function chargeCard(amount) {',
  '  return amount * 100;',
  '}',
  '',
].join('\n');

const CALLERS = [
  "import { chargeCard } from './core';",
  '',
  'export function checkout(cart) {',
  '  return chargeCard(cart.total);',
  '}',
  '',
  'export function retryCheckout(cart) {',
  '  return checkout(cart);',
  '}',
  '',
].join('\n');

const OTHER = [
  "import { chargeCard } from './core';",
  '',
  'export function refund(order) {',
  '  return chargeCard(-order.total);',
  '}',
  '',
].join('\n');

describe('reviewChanges', () => {
  it('reports a modified function with everything that reaches it', async () => {
    const dir = await repo({ 'core.ts': CORE, 'callers.ts': CALLERS, 'other.ts': OTHER });
    const analysis = await analyzeRepo(dir);
    const base = CORE.replace('amount * 100', 'amount * 10');

    const review = reviewChanges(analysis, [change(dir, 'core.ts', [[2, 2]], base)]);

    expect(review.changedFunctions).toHaveLength(1);
    const fn = review.changedFunctions[0]!;
    expect(fn.name).toBe('chargeCard');
    expect(fn.change).toBe('modified');
    expect(fn.directCallers).toBe(2);
    expect(fn.affectedFunctions).toBe(3);
    expect(fn.affectedFiles).toBe(2);
    expect(fn.sameNameElsewhere).toBe(0);
  });

  it('ignores functions the changed lines do not touch', async () => {
    const dir = await repo({ 'core.ts': CORE, 'callers.ts': CALLERS });
    const analysis = await analyzeRepo(dir);

    // The blank line between the import and the first function.
    const review = reviewChanges(analysis, [change(dir, 'callers.ts', [[2, 2]], CALLERS)]);

    expect(review.changedFunctions).toEqual([]);
  });

  it('flags an added private function that nothing calls, and not an exported one', async () => {
    const current = [
      'export function used() {',
      '  return 1;',
      '}',
      '',
      'function leftover() {',
      '  return 2;',
      '}',
      '',
      'export function publicApi() {',
      '  return 3;',
      '}',
      '',
    ].join('\n');
    const base = 'export function used() {\n  return 1;\n}\n';
    const dir = await repo({ 'lib.ts': current });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'lib.ts', [[4, 12]], base)]);

    expect(review.changedFunctions.map((f) => [f.name, f.change])).toEqual(
      expect.arrayContaining([['leftover', 'added'], ['publicApi', 'added']]),
    );
    expect(review.unusedNewFunctions.map((f) => f.name)).toEqual(['leftover']);
  });

  it('reports a function that became critically complex, with its base complexity', async () => {
    const branches = Array.from({ length: 24 }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n');
    const current = `export function route(x) {\n${branches}\n  return -1;\n}\n`;
    const base = 'export function route(x) {\n  if (x === 0) return 0;\n  return -1;\n}\n';
    const dir = await repo({ 'router.ts': current });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'router.ts', [[2, 25]], base)]);

    expect(review.complexityIncreases).toHaveLength(1);
    expect(review.complexityIncreases[0]!.baseComplexity).toBe(2);
    expect(review.complexityIncreases[0]!.complexity).toBeGreaterThan(20);
  });

  it('does not report a function that was already that complex and did not get worse', async () => {
    const branches = Array.from({ length: 24 }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n');
    const current = `export function route(x) {\n${branches}\n  return -1;\n}\n`;
    const base = current.replace('return -1', 'return -2');
    const dir = await repo({ 'router.ts': current });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'router.ts', [[26, 26]], base)]);

    expect(review.changedFunctions).toHaveLength(1);
    expect(review.complexityIncreases).toEqual([]);
  });

  it('keeps only the security findings on lines the change wrote', async () => {
    const current = [
      'export function first(input) {',
      '  return eval(input);',
      '}',
      '',
      'export function second(input) {',
      '  return eval(input + "1");',
      '}',
      '',
    ].join('\n');
    const dir = await repo({ 'danger.ts': current });
    const analysis = await analyzeRepo(dir);
    expect(analysis.securityRisk.findings.length).toBe(2);

    const line = lineOf(current, 'input + "1"');
    const review = reviewChanges(analysis, [change(dir, 'danger.ts', [[line, line]], current)]);

    expect(review.securityFindings.map((f) => f.line)).toEqual([line]);
  });

  it('leaves test files out of the changed functions but counts them', async () => {
    const test = "import { chargeCard } from '../core';\n\nfunction helper() {\n  return chargeCard(1);\n}\n";
    const dir = await repo({ 'core.ts': CORE, 'tests/core.test.ts': test });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'tests/core.test.ts', [[1, 5]], null)]);

    expect(review.changedFunctions).toEqual([]);
    expect(review.unusedNewFunctions).toEqual([]);
    expect(review.testFilesChanged).toBe(1);
  });

  it('credits a call to a shared name to the one the caller imports, even when it is not the last declared', async () => {
    // CallGraphBuilder resolves `handle(` to whichever `handle` it saw last
    // (b.ts), so a.ts's has no edges of its own; reach is matched by name,
    // and the import says which one z.ts means.
    const a = 'export function handle(x) {\n  return x;\n}\n';
    const b = 'export function handle(x) {\n  return x + 1;\n}\n';
    const caller = "import { handle } from './a';\n\nexport function main() {\n  return handle(1);\n}\n";
    const dir = await repo({ 'a.ts': a, 'b.ts': b, 'z.ts': caller });
    const analysis = await analyzeRepo(dir);

    const viaA = reviewChanges(analysis, [change(dir, 'a.ts', [[2, 2]], a.replace('x;', 'x * 1;'))]);
    const viaB = reviewChanges(analysis, [change(dir, 'b.ts', [[2, 2]], b.replace('x + 1', 'x + 2'))]);

    expect(viaA.changedFunctions[0]!.directCallers).toBe(1);
    expect(viaA.changedFunctions[0]!.sameNameElsewhere).toBe(1);
    expect(viaB.changedFunctions[0]!.directCallers).toBe(0);
  });

  it('counts callers of a private helper only from its own directory (regression: Math.round)', async () => {
    // Measured on this repository: a private `round` helper was credited with
    // every `Math.round(` in the codebase as a caller, over a thousand of them.
    const helper = [
      'function round(n) {',
      '  return Math.floor(n + 0.5);',
      '}',
      '',
      'export function price(n) {',
      '  return round(n);',
      '}',
      '',
    ].join('\n');
    const elsewhere = 'export function percent(n) {\n  return Math.round(n * 100);\n}\n';
    const dir = await repo({ 'lib/money.ts': helper, 'app/stats.ts': elsewhere });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'lib/money.ts', [[2, 2]], helper.replace('0.5', '0.4'))]);

    const fn = review.changedFunctions.find((f) => f.name === 'round')!;
    expect(fn.directCallers).toBe(1);
    expect(fn.affectedFunctions).toBe(1);
  });

  it('does not count a file that calls its own function of the same name (regression: extractCalls)', async () => {
    // Every parser in one directory has a private extractCalls() and calls its
    // own; each was being credited with all of the others' callers.
    const parser = (lang: string) =>
      `function extractCalls(body) {\n  return body.split('${lang}');\n}\n\nexport function parse${lang}(body) {\n  return extractCalls(body);\n}\n`;
    const dir = await repo({ 'parsers/go.ts': parser('Go'), 'parsers/rust.ts': parser('Rust'), 'parsers/java.ts': parser('Java') });
    const analysis = await analyzeRepo(dir);
    const go = parser('Go');

    const review = reviewChanges(analysis, [change(dir, 'parsers/go.ts', [[2, 2]], go.replace("'Go'", "'go'"))]);

    const fn = review.changedFunctions.find((f) => f.name === 'extractCalls')!;
    expect(fn.directCallers).toBe(1);
    expect(fn.directCallerFiles).toBe(1);
  });

  it('does not credit a method named like a standard one with every `.get(` elsewhere (regression: Map.get)', async () => {
    const cache = [
      'export class Cache {',
      '  get(key: string) {',
      '    return this.lookup(key);',
      '  }',
      '',
      '  lookup(key: string) {',
      '    return key;',
      '  }',
      '}',
      '',
      'export function warm(cache: Cache) {',
      '  return cache.get("a");',
      '}',
      '',
    ].join('\n');
    const route = 'export function handler(req) {\n  return new Map().get(req.url);\n}\n';
    const dir = await repo({ 'lib/cache.ts': cache, 'app/route.ts': route });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'lib/cache.ts', [[3, 3]], cache.replace('this.lookup(key)', 'key'))]);

    const fn = review.changedFunctions.find((f) => f.name === 'get')!;
    expect(fn.standardMethodName).toBe(true);
    expect(fn.directCallers).toBe(1);
    expect(fn.directCallerFiles).toBe(1);
  });

  it('does not credit one of several same-named exported functions with every call elsewhere (regression: ripgrep build)', async () => {
    // ripgrep declares `build` 27 times; an unqualified `.build()` anywhere
    // matched all of them - 38 callers counted, 8 real.
    const builder = (n: string) => `export function build() {\n  return '${n}';\n}\n`;
    const dir = await repo({
      'walk/builder.ts': builder('walk'),
      'types/builder.ts': builder('types'),
      'cli/main.ts': 'export function main() {\n  return build();\n}\n',
      'walk/run.ts': "import { build } from './builder';\n\nexport function run() {\n  return build();\n}\n",
      'app/start.ts': "import { build } from '../walk/builder';\n\nexport function start() {\n  return build();\n}\n",
    });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'walk/builder.ts', [[2, 2]], builder('old'))]);

    const fn = review.changedFunctions.find((f) => f.name === 'build')!;
    // walk/run.ts (same directory) and app/start.ts (imports it) count; cli/main.ts cannot be told apart.
    expect(fn.directCallers).toBe(2);
    expect(fn.sameNameElsewhere).toBe(1);
  });

  it('does not count a same-directory call for one of several same-named methods there (regression: ripgrep crates/ignore/src)', async () => {
    // Every builder in one directory has a `build`; `.build()` in a sibling
    // file names no receiver the call graph can see.
    const builder = (n: string) => `export class ${n}Builder {\n  build() {\n    return '${n}';\n  }\n}\n`;
    const dir = await repo({
      'src/walk.ts': builder('Walk'),
      'src/types.ts': builder('Types'),
      'src/dir.ts': 'export function create(b) {\n  return b.build();\n}\n',
    });
    const analysis = await analyzeRepo(dir);
    const walk = builder('Walk');

    const review = reviewChanges(analysis, [change(dir, 'src/walk.ts', [[3, 3]], walk.replace("'Walk'", "'walk'"))]);

    const fn = review.changedFunctions.find((f) => f.name === 'build')!;
    expect(fn.directCallers).toBe(0);
  });

  it('names each caller by its own line when same-named functions share a file (regression: callers shown at the last one)', async () => {
    const src = [
      'export class A {',
      '  run() {',
      '    return target();',
      '  }',
      '}',
      '',
      'export class B {',
      '  run() {',
      '    return 2;',
      '  }',
      '}',
      '',
      'export function target() {',
      '  return 1;',
      '}',
      '',
    ].join('\n');
    const dir = await repo({ 'm.ts': src });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'm.ts', [[14, 14]], src.replace('return 1', 'return 0'))]);

    const fn = review.changedFunctions.find((f) => f.name === 'target')!;
    expect(fn.callers.map((c) => [c.name, c.startLine])).toEqual([['run', 2]]);
  });

  it('pairs overloads with their base versions by parameter list (regression: commons-lang isAssignable)', async () => {
    const method = (params: string, body: string) => `    public static boolean check(${params}) {\n        return ${body};\n    }\n`;
    const base = `public class T {\n${method('int a', 'a > 0')}\n${method('int a, int b', 'a > b')}\n}\n`;
    const current = `public class T {\n${method('int a', 'a > 0')}\n${method('int a, String s', 's.isEmpty()')}\n${method('int a, int b', 'a > b')}\n}\n`;
    const dir = await repo({ 'src/T.java': current });
    const analysis = await analyzeRepo(dir);
    const inserted = lineOf(current, 'String s');

    const review = reviewChanges(analysis, [
      { ...change(dir, 'src/T.java', [[inserted, inserted + 3]], base), content: current },
    ]);

    expect(review.changedFunctions.map((f) => [f.startLine, f.change])).toEqual([[inserted, 'added']]);
  });

  it('pairs same-named functions in one file with their own base versions (regression: overloads, __init__)', async () => {
    const one = 'class A:\n    def __init__(self):\n        self.x = 1\n';
    const branches = Array.from({ length: 24 }, (_, i) => `        if x == ${i}:\n            return`).join('\n');
    const current = `${one}\n\nclass B:\n    def __init__(self, x):\n${branches}\n`;
    const dir = await repo({ 'models.py': current });
    const analysis = await analyzeRepo(dir);
    const added = lineOf(current, 'class B:');

    const review = reviewChanges(analysis, [change(dir, 'models.py', [[added, added + 49]], one)]);

    const init = review.changedFunctions.filter((f) => f.name === '__init__');
    expect(init).toHaveLength(1);
    expect(init[0]!.change).toBe('added');
    expect(init[0]!.baseComplexity).toBeNull();
  });

  it('counts a deletion only for a function that spans it', async () => {
    const src = 'def a():\n    one()\n    two()\n\n\ndef c():\n    three()\n';
    const dir = await repo({ 'm.py': src });
    const analysis = await analyzeRepo(dir);
    const base = 'def a():\n    one()\n    two()\n\n\ndef b():\n    pass\n\n\ndef c():\n    three()\n';

    const between = reviewChanges(analysis, [{ ...change(dir, 'm.py', [], base), deletedAfter: [5] }]);
    const inside = reviewChanges(analysis, [{ ...change(dir, 'm.py', [], base), deletedAfter: [2] }]);

    expect(between.changedFunctions).toEqual([]);
    expect(inside.changedFunctions.map((f) => f.name)).toEqual(['a']);
  });

  it('judges test files by their path inside the repository, not where it is checked out', async () => {
    const dir = await repo({ 'test/proj/src/app.ts': 'export function serve() {\n  return 1;\n}\n' });
    const root = path.join(dir, 'test', 'proj');
    const analysis = await analyzeRepo(root);

    const review = reviewChanges(analysis, [change(root, 'src/app.ts', [[2, 2]], null)]);

    expect(review.changedFunctions.map((f) => f.name)).toEqual(['serve']);
    expect(review.testFilesChanged).toBe(0);
  });

  it('stops the reach search at REACH_LIMIT and says so', async () => {
    const callers = Array.from({ length: REACH_LIMIT + 5 }, (_, i) => `export function c${i}() {\n  return hub();\n}\n`).join('\n');
    const src = `export function hub() {\n  return 1;\n}\n\n${callers}`;
    const dir = await repo({ 'big.ts': src });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'big.ts', [[2, 2]], src.replace('return 1', 'return 2'))]);

    const hub = review.changedFunctions.find((f) => f.name === 'hub')!;
    expect(hub.affectedFunctions).toBe(REACH_LIMIT);
    expect(hub.reachCapped).toBe(true);
  });

  it('matches the security findings it is given, when the caller scanned the changed files itself', async () => {
    const src = 'export function f(input) {\n  return input;\n}\n';
    const dir = await repo({ 'a.ts': src });
    const analysis = await analyzeRepo(dir);
    const finding = {
      category: 'dynamic-code-execution' as const, severity: 'high' as const,
      filePath: path.join(dir, 'a.ts'), line: 2, description: 'eval', lineText: 'eval(input)',
    };

    const review = reviewChanges(analysis, [change(dir, 'a.ts', [[2, 2]], src)], { securityFindings: [finding] });

    expect(review.securityFindings).toEqual([finding]);
  });

  it(`follows callers at most REACH_DEPTH calls deep`, async () => {
    const chain = [
      'export function f0() { return 0; }',
      'export function f1() { return f0(); }',
      'export function f2() { return f1(); }',
      'export function f3() { return f2(); }',
      'export function f4() { return f3(); }',
      '',
    ].join('\n');
    const dir = await repo({ 'chain.ts': chain });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'chain.ts', [[1, 1]], chain.replace('return 0', 'return 1'))]);

    const fn = review.changedFunctions.find((f) => f.name === 'f0')!;
    expect(fn.directCallers).toBe(1);
    expect(fn.affectedFunctions).toBe(REACH_DEPTH);
  });

  it('reports a package import the change added, and not one the file already had', async () => {
    const current = "import _ from 'lodash';\nimport pad from 'left-pad';\n\nexport function f() {\n  return _.identity(pad('x', 2));\n}\n";
    const base = "import pad from 'left-pad';\n\nexport function f() {\n  return pad('x', 2);\n}\n";
    const dir = await repo({
      'package.json': JSON.stringify({ name: 'demo', dependencies: {} }),
      'src/f.ts': current,
    });
    const analysis = await analyzeRepo(dir);
    expect(analysis.dependencyHygiene.undeclaredImports.map((u) => u.packageName).sort()).toEqual(['left-pad', 'lodash']);

    const review = reviewChanges(analysis, [change(dir, 'src/f.ts', [[1, 1], [5, 5]], base)]);

    expect(review.newUndeclaredImports.map((u) => u.packageName)).toEqual(['lodash']);
  });

  it('treats a function as added when the file is new', async () => {
    const dir = await repo({ 'core.ts': CORE, 'callers.ts': CALLERS });
    const analysis = await analyzeRepo(dir);

    const review = reviewChanges(analysis, [change(dir, 'callers.ts', [[1, 10]], null)]);

    expect(review.changedFunctions.map((f) => [f.name, f.change, f.baseComplexity])).toEqual(
      expect.arrayContaining([['checkout', 'added', null], ['retryCheckout', 'added', null]]),
    );
    // checkout is reached from retryCheckout, so it sorts first.
    expect(review.changedFunctions[0]!.name).toBe('checkout');
  });
});
