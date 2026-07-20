import { describe, it, expect } from 'vitest';
import { parseFile } from '../../parser/ParserRegistry.js';
import { findDeadCode } from '../DeadCodeFinder.js';
import { calculateHealthScore } from '../HealthScorer.js';
import type { FileAnalysis } from '../../types/parser.types.js';

/**
 * Regression tests for the expressjs/express false-positive dead-code bug:
 * analyzing the real repo produced a D (56/100) with 104/123 (85%) of its
 * functions flagged "dead," none of which actually were. Root causes were
 * (1) reference-passing usages (`app.use(fn)`) never counted as "called,"
 * (2) property/prototype-assigned function bodies (`app.render = function
 * render(){}`) invisible to the parser, so calls inside them vanished, and
 * (3) a pre-existing string-stripping bug that corrupted call detection on
 * any file containing a string with `//` in it (e.g. a URL).
 */

function parseJs(source: string, filePath = '/fake/index.js'): FileAnalysis {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error('expected JsTsParser to handle this fixture');
  return analysis;
}

describe('dead code detection - reference-passing and property-assigned functions', () => {
  it('does not flag a function used only via reference-passing (app.use(fn) style)', () => {
    const source = `
      function logger(req, res, next) {
        console.log(req.url);
        next();
      }
      app.use(logger);
    `;
    const dead = findDeadCode([parseJs(source)]);
    expect(dead.map((d) => d.function.name)).not.toContain('logger');
  });

  it('does not flag a function called from inside a property-assigned method body', () => {
    // Mirrors the real express bug: `app.render = function render(...) {}` is
    // invisible to JsTsParser as a "function" (neither a top-level `function
    // name(` declaration nor a `const name = () =>` arrow assignment), so the
    // literal call to tryRender() inside it was previously invisible too.
    const source = `
      function tryRender(view, cb) {
        view.render(cb);
      }
      app.render = function render(name, cb) {
        tryRender(name, cb);
      };
    `;
    const dead = findDeadCode([parseJs(source, '/fake/application.js')]);
    expect(dead.map((d) => d.function.name)).not.toContain('tryRender');
  });

  it('does not flag functions referenced via return, property-access, or bare `new`', () => {
    const source = `
      function debounced() {}
      function makeDebounced() {
        debounced.cancel = function () {};
        return debounced;
      }
      function Circle() {}
      var c = new Circle;
    `;
    const dead = findDeadCode([parseJs(source, '/fake/utils.js')]);
    const names = dead.map((d) => d.function.name);
    expect(names).not.toContain('debounced');
    expect(names).not.toContain('Circle');
  });

  it('does not corrupt call detection when a string contains "//" (e.g. a URL)', () => {
    // Pre-existing bug: stripStringsAndComments used to strip line comments
    // BEFORE removing string literals, so 'http://example.com' was misread as
    // starting a comment mid-string, eating the closing quote and causing the
    // string-removal regex to run away and swallow real code after it.
    const source = `
      function buildUrl() {
        return 'http://example.com/foo';
      }
      function useIt() {
        return buildUrl();
      }
    `;
    const dead = findDeadCode([parseJs(source, '/fake/urls.js')]);
    expect(dead.map((d) => d.function.name)).not.toContain('buildUrl');
  });

  it('does not flag a React component used only as a JSX tag (<Home />, <Banner url={x}>)', () => {
    // Real bug found via a live user test on JosinJojy/Netflix-reactjs:
    // 22 of 66 functions (33%) were flagged dead, every single one a React
    // component used only via JSX tag syntax (<Home />), never invoked with
    // parens - invisible to every reference pattern that existed at the time.
    const source = `
      function Home() {
        return null;
      }
      function Banner({ url }) {
        return null;
      }
      function App() {
        return (
          <div>
            <Home />
            <Banner url={'x'}></Banner>
          </div>
        );
      }
    `;
    const dead = findDeadCode([parseJs(source, '/fake/App.jsx')]);
    const names = dead.map((d) => d.function.name);
    expect(names).not.toContain('Home');
    expect(names).not.toContain('Banner');
  });

  it('still flags a genuinely unused, non-exported function as dead (regression guard)', () => {
    // This is the critical guard: it proves the fix narrowed false positives
    // rather than disabling dead-code detection outright.
    const source = `
      function trulyUnusedHelper(value) {
        return value * 2;
      }
      function main() {
        console.log('hello');
      }
      main();
    `;
    const dead = findDeadCode([parseJs(source)]);
    expect(dead.map((d) => d.function.name)).toContain('trulyUnusedHelper');
  });
});

describe('dead code in test files is never marked safe to remove', () => {
  // Reproduces gajus/slonik (createErrorWithCodeAndConstraint, a *.test.ts
  // helper) and Hufe921/canvas-editor (textEl/flushMicrotasks/etc under
  // tests/factories and tests/helpers): a zero-caller export inside a test
  // file may be genuinely unused, or may be wired up by a test-runner
  // discovery mechanism this regex-based call graph can't model - either
  // way it shouldn't be presented as a confident "safe to delete" the way a
  // genuinely dead production function is.

  it('does not mark a zero-caller non-exported function in a *.test.ts file as safe to remove', () => {
    const source = `
      function unusedTestHelper() {
        return 1;
      }
    `;
    const dead = findDeadCode([parseJs(source, '/repo/src/query.test/query.test.ts')]);
    const finding = dead.find((d) => d.function.name === 'unusedTestHelper');
    expect(finding?.isSafeToRemove).toBe(false);
  });

  it('does not mark a zero-caller function under a tests/ directory as safe to remove', () => {
    const source = `
      export function textEl(value) {
        return { value };
      }
    `;
    const dead = findDeadCode([parseJs(source, '/repo/tests/factories/elements.ts')]);
    const finding = dead.find((d) => d.function.name === 'textEl');
    expect(finding?.isSafeToRemove).toBe(false);
  });

  it('still marks a zero-caller non-exported function in a normal (non-test) file as safe to remove', () => {
    // Regression guard: the test-file check narrows safety, it doesn't
    // disable the existing exported/non-exported distinction elsewhere.
    const source = `
      function trulyUnusedHelper() {
        return 1;
      }
    `;
    const dead = findDeadCode([parseJs(source, '/repo/src/utils.ts')]);
    const finding = dead.find((d) => d.function.name === 'trulyUnusedHelper');
    expect(finding?.isSafeToRemove).toBe(true);
  });
});

describe('cross-language call resolution', () => {
  it('does not flag a PascalCase C++ function as dead when called by its camelCase JS-exposed name', () => {
    // Mirrors a real native-binding pattern: a C++ function using the
    // Chromium/Electron PascalCase convention, exposed to JS under a
    // different, camelCase name via a binding table.
    const cppSource = `
      void CreateWindow(int width, int height) {
        InitBuffer();
      }
    `;
    const jsSource = `
      function launch() {
        addon.createWindow(800, 600);
      }
    `;
    const cppFile = parseFile(cppSource, '/fake/window.cpp');
    const jsFile = parseFile(jsSource, '/fake/launch.js');
    if (!cppFile || !jsFile) throw new Error('expected both parsers to handle these fixtures');

    const dead = findDeadCode([cppFile, jsFile]);
    expect(dead.map((d) => d.function.name)).not.toContain('CreateWindow');
  });

  it('does not apply the cross-language fallback within the same language (regression guard)', () => {
    // Two genuinely distinct C++ functions that happen to normalize to the
    // same form - neither is called by anything, so both should still be
    // flagged. Proves the normalized index only bridges a language
    // boundary, rather than papering over genuine same-language misses.
    const cppSource = `
      void create_window() {
        DoNothing();
      }
      void CreateWindow() {
        DoNothing();
      }
    `;
    const cppFile = parseFile(cppSource, '/fake/window2.cpp');
    if (!cppFile) throw new Error('expected CppParser to handle this fixture');

    const dead = findDeadCode([cppFile]);
    const names = dead.map((d) => d.function.name);
    expect(names).toContain('create_window');
    expect(names).toContain('CreateWindow');
  });
});

describe('CppParser call extraction', () => {
  it('recognizes calls to PascalCase-named functions (the Chromium/Electron C++ convention)', () => {
    // Previously any call whose name didn't start lowercase was silently
    // dropped (meant to filter constructor-style `MyClass(x)` calls), which
    // also discarded every genuine call to a PascalCase function - the
    // standard convention in large real-world C++ codebases.
    const source = `
      void InitializeBuffer() {}
      void CreateWindow() {
        InitializeBuffer();
      }
    `;
    const file = parseFile(source, '/fake/win.cpp');
    if (!file) throw new Error('expected CppParser to handle this fixture');
    const dead = findDeadCode([file]);
    expect(dead.map((d) => d.function.name)).not.toContain('InitializeBuffer');
  });
});

describe('ShellParser call extraction', () => {
  it('recognizes a call to a function whose name has no underscore', () => {
    const source = `
      deploy() {
        echo "deploying"
      }
      main() {
        deploy
      }
    `;
    const file = parseFile(source, '/fake/deploy.sh');
    if (!file) throw new Error('expected ShellParser to handle this fixture');
    const dead = findDeadCode([file]);
    expect(dead.map((d) => d.function.name)).not.toContain('deploy');
  });

  it('recognizes a call inside an if condition (if cmd; then)', () => {
    const source = `
      verifyConfig() {
        return 0
      }
      main() {
        if verifyConfig; then
          echo ok
        fi
      }
    `;
    const file = parseFile(source, '/fake/check.sh');
    if (!file) throw new Error('expected ShellParser to handle this fixture');
    const dead = findDeadCode([file]);
    expect(dead.map((d) => d.function.name)).not.toContain('verifyConfig');
  });
});

describe('deadCodeRatio excludes exported "possibly public API" functions from scoring', () => {
  it('still lists an exported, zero-caller function as dead code but never as safe to remove', () => {
    // This is what RepoAnalyzer's deadCodeRatio filters on: exported dead
    // findings are excluded from the score-driving ratio (a library's
    // public API is called by external consumers this analysis never sees),
    // but still surfaced here for informational purposes.
    // The export must sit at true column 0 - JsTsParser treats indentation
    // as a signal for "is this actually module-top-level" (a reasonable
    // heuristic for real files, where nested code is indented), so an
    // artificially-indented fixture here would misreport isExported: false
    // regardless of the `export` keyword.
    const source = `export function publicHelper() {
  return 1;
}
`;
    const file = parseFile(source, '/fake/lib.ts');
    if (!file) throw new Error('expected JsTsParser to handle this fixture');
    const dead = findDeadCode([file]);
    const finding = dead.find((d) => d.function.name === 'publicHelper');
    expect(finding).toBeDefined();
    expect(finding?.isSafeToRemove).toBe(false);
  });
});

describe('HealthScorer - express-shaped fixture should not score as a D', () => {
  it('produces a healthy score/grade when the dead-code ratio is near zero', () => {
    // Reflects the corrected real-world result: expressjs/express went from
    // 104/123 (85%) false "dead" functions to 0/123 after this fix, and the
    // grade moved from D (56) to B (77) on the actual repo.
    const health = calculateHealthScore({
      deadCodeRatio: 0,
      avgComplexity: 1.73,
      maxComplexity: 14,
      testFileRatio: 0.3,
      duplicationRatio: 0.04,
      oversizedFileRatio: 0.12,
    });
    expect(health.score).toBeGreaterThanOrEqual(70);
    expect(['A+', 'A', 'B']).toContain(health.grade);
  });

  it('still scores meaningfully worse when dead-code ratio is genuinely high', () => {
    // Dead code is only 25% of the weighted formula, so even 85% dead code
    // won't necessarily push an otherwise-healthy repo into D/F territory -
    // this asserts the metric still moves the score down, not a specific grade.
    const healthy = calculateHealthScore({
      deadCodeRatio: 0,
      avgComplexity: 1.73,
      maxComplexity: 14,
      testFileRatio: 0.3,
      duplicationRatio: 0.04,
      oversizedFileRatio: 0.12,
    });
    const highDeadCode = calculateHealthScore({
      deadCodeRatio: 0.85,
      avgComplexity: 1.73,
      maxComplexity: 14,
      testFileRatio: 0.3,
      duplicationRatio: 0.04,
      oversizedFileRatio: 0.12,
    });
    expect(highDeadCode.score).toBeLessThan(healthy.score);
  });
});
