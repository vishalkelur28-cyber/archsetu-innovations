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
 * All known framework conventions, across all frameworks. Add new frameworks
 * here (e.g. Remix's `loader`/`action` exports, SvelteKit's `+page.ts`
 * `load` export) as their own array, spread in below.
 */
const FRAMEWORK_CONVENTIONS: FrameworkConvention[] = [...NEXTJS_APP_ROUTER_CONVENTIONS];

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
