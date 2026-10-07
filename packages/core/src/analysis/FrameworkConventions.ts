/**
 * Registry of framework file-naming conventions whose exports are called
 * implicitly by the framework - by file location, not by an explicit call
 * site anywhere in the codebase. DeadCodeFinder and EntryPointDetector both
 * need this: a function with zero call-graph edges is not necessarily dead
 * if the framework itself is the caller.
 *
 * Extend this list to add a new framework/convention; nothing else in
 * DeadCodeFinder or EntryPointDetector needs to change.
 */

export interface FrameworkConvention {
  /** Human-readable source of the convention, for debugging/description text. */
  framework: string;
  /** Matches the file's path (already normalized to forward slashes). */
  filePattern: RegExp;
  /** Exact export names always reserved in a matching file. */
  namedExports: ReadonlySet<string>;
  /** Whether a matching file's default export is also reserved. */
  includesDefaultExport: boolean;
}

const NEXTJS_APP_ROUTER_CONVENTIONS: FrameworkConvention[] = [
  {
    framework: 'Next.js App Router',
    filePattern: /(^|\/)page\.tsx?$/,
    namedExports: new Set(['generateMetadata', 'generateStaticParams', 'generateViewport']),
    includesDefaultExport: true,
  },
  {
    framework: 'Next.js App Router',
    filePattern: /(^|\/)layout\.tsx?$/,
    namedExports: new Set(['generateMetadata', 'generateStaticParams']),
    includesDefaultExport: true,
  },
  {
    framework: 'Next.js App Router',
    filePattern: /(^|\/)(error|global-error|not-found|loading)\.tsx?$/,
    namedExports: new Set(),
    includesDefaultExport: true,
  },
  {
    framework: 'Next.js App Router',
    filePattern: /(^|\/)route\.tsx?$/,
    namedExports: new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    includesDefaultExport: false,
  },
  // Instrumentation Hook: https://nextjs.org/docs/app/guides/instrumentation
  // Found as a real false positive alongside generateMetadata/ErrorPage/GlobalError
  // while verifying this fix on liam-hq/liam (frontend/apps/app/instrumentation.ts).
  {
    framework: 'Next.js App Router',
    filePattern: /(^|\/)instrumentation\.tsx?$/,
    namedExports: new Set(['register', 'onRequestError']),
    includesDefaultExport: false,
  },
  // Metadata Files: https://nextjs.org/docs/app/api-reference/file-conventions/metadata
  // Also found as a real false positive on the same repo (sitemap.ts).
  {
    framework: 'Next.js App Router',
    filePattern: /(^|\/)(sitemap|robots|manifest)\.tsx?$/,
    namedExports: new Set(),
    includesDefaultExport: true,
  },
];

/**
 * Found via the anomaly-sweep script (apps/web/scripts/anomaly-sweep.mjs)
 * flagging whoiskatrin/sql-translator's dead-code ratio as a statistical
 * outlier - not a repo anyone picked to test by hand. Its `pages/_app.tsx`
 * and `pages/index.tsx` default exports (`MyApp`, `Home`) were flagged
 * dead: real, still-common Next.js Pages Router files, called implicitly by
 * the framework's file-based router exactly like App Router's page.tsx is,
 * but with zero conventions registered for the older router at all.
 */
const NEXTJS_PAGES_ROUTER_CONVENTIONS: FrameworkConvention[] = [
  {
    framework: 'Next.js Pages Router',
    filePattern: /(^|\/)pages\/_(app|document|error)\.tsx?$/,
    namedExports: new Set(['getInitialProps']),
    includesDefaultExport: true,
  },
  {
    framework: 'Next.js Pages Router',
    // Any file under pages/ (at any depth, e.g. pages/blog/[slug].tsx) whose
    // filename doesn't start with `_` and isn't under pages/api/ is itself a
    // route - Next.js calls its default export by file location, the same
    // way App Router's page.tsx works, just without needing the literal
    // filename "page.tsx".
    filePattern: /(^|\/)pages\/(?!api\/)(?:.+\/)?[^_/][^/]*\.tsx?$/,
    namedExports: new Set(['getInitialProps']),
    includesDefaultExport: true,
  },
  {
    framework: 'Next.js Pages Router',
    filePattern: /(^|\/)pages\/api\/.+\.tsx?$/,
    namedExports: new Set(['config']),
    includesDefaultExport: true,
  },
];

/**
 * All known framework conventions, across all frameworks. Add new frameworks
 * here (e.g. Remix's `loader`/`action` exports, SvelteKit's `+page.ts`
 * `load` export) as their own array, spread in below.
 */
const FRAMEWORK_CONVENTIONS: FrameworkConvention[] = [
  ...NEXTJS_APP_ROUTER_CONVENTIONS,
  ...NEXTJS_PAGES_ROUTER_CONVENTIONS,
];

/**
 * True if `exportName` in `filePath` is called implicitly by a known
 * framework convention (file-location-based), and therefore must never be
 * flagged as dead code regardless of call-graph edge count.
 */
export function isFrameworkReservedExport(
  filePath: string,
  exportName: string,
  isDefaultExport: boolean,
): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const convention of FRAMEWORK_CONVENTIONS) {
    if (!convention.filePattern.test(normalized)) continue;
    if (convention.namedExports.has(exportName)) return true;
    if (convention.includesDefaultExport && isDefaultExport) return true;
  }
  return false;
}

/** Returns the matching convention's framework label, or null if none match - used for description text. */
export function frameworkConventionFor(
  filePath: string,
  exportName: string,
  isDefaultExport: boolean,
): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const convention of FRAMEWORK_CONVENTIONS) {
    if (!convention.filePattern.test(normalized)) continue;
    if (convention.namedExports.has(exportName) || (convention.includesDefaultExport && isDefaultExport)) {
      return convention.framework;
    }
  }
  return null;
}
