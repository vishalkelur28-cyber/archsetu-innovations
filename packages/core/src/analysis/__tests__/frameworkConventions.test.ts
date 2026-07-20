import { describe, it, expect } from 'vitest';
import { isFrameworkReservedExport, frameworkConventionFor } from '../FrameworkConventions.js';
import { parseFile } from '../../parser/ParserRegistry.js';
import { findDeadCode } from '../DeadCodeFinder.js';
import { detectEntryPointsFromAnalyses } from '../EntryPointDetector.js';
import type { FileAnalysis } from '../../types/parser.types.js';

function parseTsx(source: string, filePath: string): FileAnalysis {
  const analysis = parseFile(source, filePath);
  if (!analysis) throw new Error('expected JsTsParser to handle this fixture');
  return analysis;
}

/**
 * Regression tests for the liam-hq/liam false-positive dead-code bug: Next.js
 * App Router exports called implicitly by file-location convention
 * (generateMetadata, a page.tsx/error.tsx default export) were flagged dead
 * because DeadCodeFinder only recognized call-graph edges, and these
 * functions structurally have none - the framework calls them, not any
 * function in the codebase.
 */
describe('isFrameworkReservedExport - Next.js App Router conventions', () => {
  it('reserves generateMetadata, generateStaticParams, and generateViewport in page.tsx', () => {
    expect(isFrameworkReservedExport('app/p/[...slug]/page.tsx', 'generateMetadata', false)).toBe(true);
    expect(isFrameworkReservedExport('app/p/[...slug]/page.tsx', 'generateStaticParams', false)).toBe(true);
    expect(isFrameworkReservedExport('app/p/[...slug]/page.tsx', 'generateViewport', false)).toBe(true);
  });

  it('reserves the default export in page.tsx and page.ts', () => {
    expect(isFrameworkReservedExport('app/p/[...slug]/page.tsx', 'Page', true)).toBe(true);
    expect(isFrameworkReservedExport('app/api/thing/page.ts', 'ThingPage', true)).toBe(true);
  });

  it('does not reserve an arbitrary named export in page.tsx that is not a default export or known name', () => {
    expect(isFrameworkReservedExport('app/p/[...slug]/page.tsx', 'someHelper', false)).toBe(false);
  });

  it('reserves the default export plus generateMetadata/generateStaticParams in layout.tsx, but not generateViewport', () => {
    expect(isFrameworkReservedExport('app/layout.tsx', 'RootLayout', true)).toBe(true);
    expect(isFrameworkReservedExport('app/layout.tsx', 'generateMetadata', false)).toBe(true);
    expect(isFrameworkReservedExport('app/layout.tsx', 'generateStaticParams', false)).toBe(true);
    expect(isFrameworkReservedExport('app/layout.tsx', 'generateViewport', false)).toBe(false);
  });

  it('reserves the default export in error.tsx, global-error.tsx, not-found.tsx, and loading.tsx', () => {
    expect(isFrameworkReservedExport('app/error/page.tsx'.replace('page', 'error'), 'ErrorPage', true)).toBe(true);
    expect(isFrameworkReservedExport('app/app/global-error.tsx', 'GlobalError', true)).toBe(true);
    expect(isFrameworkReservedExport('app/not-found.tsx', 'NotFound', true)).toBe(true);
    expect(isFrameworkReservedExport('app/loading.tsx', 'Loading', true)).toBe(true);
  });

  it('reserves register and onRequestError in instrumentation.ts (Instrumentation Hook)', () => {
    // Real false positive found on liam-hq/liam (frontend/apps/app/instrumentation.ts)
    // while verifying the generateMetadata/ErrorPage/GlobalError fix.
    expect(isFrameworkReservedExport('instrumentation.ts', 'register', false)).toBe(true);
    expect(isFrameworkReservedExport('instrumentation.ts', 'onRequestError', false)).toBe(true);
    expect(isFrameworkReservedExport('instrumentation.ts', 'helper', false)).toBe(false);
  });

  it('reserves the default export in sitemap.ts, robots.ts, and manifest.ts (Metadata Files)', () => {
    // Real false positive found on liam-hq/liam (frontend/apps/docs/app/docs/sitemap.ts)
    // while verifying the generateMetadata/ErrorPage/GlobalError fix.
    expect(isFrameworkReservedExport('app/docs/sitemap.ts', 'sitemap', true)).toBe(true);
    expect(isFrameworkReservedExport('app/robots.ts', 'robots', true)).toBe(true);
    expect(isFrameworkReservedExport('app/manifest.ts', 'manifest', true)).toBe(true);
  });

  it('reserves HTTP method exports in route.ts', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(isFrameworkReservedExport('app/api/things/route.ts', method, false)).toBe(true);
    }
  });

  it('does not reserve the default export in route.ts (route handlers have no default export convention)', () => {
    expect(isFrameworkReservedExport('app/api/things/route.ts', 'helper', true)).toBe(false);
  });

  it('does not reserve conventionally-named exports in an unrelated file', () => {
    expect(isFrameworkReservedExport('src/utils/format.ts', 'generateMetadata', false)).toBe(false);
    expect(isFrameworkReservedExport('src/components/Button.tsx', 'Button', true)).toBe(false);
  });

  it('normalizes Windows-style backslash paths the same as forward-slash paths', () => {
    expect(isFrameworkReservedExport('app\\p\\[...slug]\\page.tsx', 'generateMetadata', false)).toBe(true);
  });

  it('frameworkConventionFor returns the framework label for a match, null otherwise', () => {
    expect(frameworkConventionFor('app/layout.tsx', 'RootLayout', true)).toBe('Next.js App Router');
    expect(frameworkConventionFor('src/utils/format.ts', 'formatDate', false)).toBeNull();
  });
});

describe('DeadCodeFinder - Next.js App Router false positives', () => {
  it('does not flag generateMetadata as dead code in a page.tsx file', () => {
    const source = `
      export async function generateMetadata({ params }) {
        return { title: params.slug };
      }
      export default function Page({ params }) {
        return null;
      }
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/app/p/[...slug]/page.tsx')]);
    const names = dead.map((d) => d.function.name);
    expect(names).not.toContain('generateMetadata');
    expect(names).not.toContain('Page');
  });

  it('does not flag a named default-export error boundary as dead code in error.tsx', () => {
    const source = `
      export default function ErrorPage({ error }) {
        return null;
      }
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/app/error.tsx')]);
    expect(dead.map((d) => d.function.name)).not.toContain('ErrorPage');
  });

  it('does not flag a named default-export global error boundary as dead code in global-error.tsx', () => {
    const source = `
      export default function GlobalError({ error }) {
        return null;
      }
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/app/global-error.tsx')]);
    expect(dead.map((d) => d.function.name)).not.toContain('GlobalError');
  });

  it('does not flag the default export of layout.tsx, or its generateMetadata', () => {
    const source = `
      export function generateMetadata() {
        return { title: 'App' };
      }
      export default function RootLayout({ children }) {
        return children;
      }
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/app/layout.tsx')]);
    const names = dead.map((d) => d.function.name);
    expect(names).not.toContain('generateMetadata');
    expect(names).not.toContain('RootLayout');
  });

  it('still excludes HTTP method handlers in route.ts from dead code (pre-existing behavior, verified alongside the fix)', () => {
    const source = `
      export async function GET(request) {
        return new Response('ok');
      }
      export async function POST(request) {
        return new Response('ok');
      }
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/app/api/things/route.ts')]);
    const names = dead.map((d) => d.function.name);
    expect(names).not.toContain('GET');
    expect(names).not.toContain('POST');
  });

  it('still flags a genuinely unused function in a page.tsx file as dead (regression guard)', () => {
    const source = `
      function unusedHelper() {
        return 1;
      }
      export default function Page() {
        return null;
      }
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/app/dashboard/page.tsx')]);
    expect(dead.map((d) => d.function.name)).toContain('unusedHelper');
  });

  it('does not flag register/onRequestError as dead code in instrumentation.ts', () => {
    const source = `
      export async function register() {
        await import('./sentry.server.config');
      }
      export const onRequestError = Sentry.captureRequestError;
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/instrumentation.ts')]);
    expect(dead.map((d) => d.function.name)).not.toContain('register');
  });

  it('does not flag the default export of sitemap.ts as dead code', () => {
    const source = `
      export default function sitemap() {
        return [];
      }
    `;
    const dead = findDeadCode([parseTsx(source, '/repo/app/sitemap.ts')]);
    expect(dead.map((d) => d.function.name)).not.toContain('sitemap');
  });
});

describe('EntryPointDetector - Next.js App Router conventions are auto-detected entry points', () => {
  it('detects generateMetadata and the default export of a page.tsx as entry points', () => {
    const source = `
      export async function generateMetadata() {
        return { title: 'x' };
      }
      export default function Page() {
        return null;
      }
    `;
    const analysis = parseTsx(source, '/repo/app/p/page.tsx');
    const entryPoints = detectEntryPointsFromAnalyses([analysis], '/repo');
    const names = entryPoints.map((e) => e.name);
    expect(names).toContain('generateMetadata');
    expect(names).toContain('Page');
  });
});
