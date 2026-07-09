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
