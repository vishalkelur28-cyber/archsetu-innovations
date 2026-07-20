import path from 'path';
import type { SupportedLanguage } from '../types/parser.types.js';

/** Maps file extensions → language identifiers. Falls back to 'unknown'. */
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala',
  '.dart': 'dart',
  '.r': 'r',
  '.sh': 'shell',
  '.bash': 'shell',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'css',
  '.lua': 'lua',
  '.pl': 'perl',
  '.pm': 'perl',
  '.hs': 'haskell',
  '.lhs': 'haskell',
  '.ex': 'elixir',
  '.exs': 'elixir',
  // .h is left mapped to 'c' above - it's shared by C, C++, and Objective-C
  // headers, and plain C headers vastly outnumber Objective-C ones in most
  // repos, so that's the better default. .m/.mm are unambiguous.
  '.m': 'objectivec',
  '.mm': 'objectivec',
  '.zig': 'zig',
  '.sol': 'solidity',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.groovy': 'groovy',
  '.gradle': 'groovy',
  '.ml': 'ocaml',
  '.mli': 'ocaml',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  '.fs': 'fsharp',
  '.fsx': 'fsharp',
  '.jl': 'julia',
  '.nim': 'nim',
  '.cr': 'crystal',
  '.vim': 'vimscript',
  '.el': 'elisp',
  '.mk': 'makefile',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.sql': 'sql',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.bat': 'batch',
  '.cmd': 'batch',
};

/**
 * Filenames matched exactly (case-insensitive), independent of extension -
 * Makefiles and Dockerfiles are conventionally named without one at all
 * (`Makefile`, `Dockerfile`, `Dockerfile.prod`), so an extension-only lookup
 * would never recognize the single most common form of either file.
 */
const BASENAME_MAP: Record<string, SupportedLanguage> = {
  'makefile': 'makefile',
  'gnumakefile': 'makefile',
  'dockerfile': 'dockerfile',
};

export function detectLanguage(filePath: string): SupportedLanguage {
  const base = path.basename(filePath).toLowerCase();
  // Exact-name match first (Makefile, Dockerfile) - then the "Dockerfile.prod"
  // / "Dockerfile.dev" convention, which an extension-only lookup would read
  // as extension ".prod"/".dev" and miss entirely.
  if (BASENAME_MAP[base]) return BASENAME_MAP[base];
  if (base.startsWith('dockerfile.')) return 'dockerfile';
  if (base.startsWith('makefile.')) return 'makefile';

  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'unknown';
}

/** Returns true if the file extension is one we can analyze */
export function isSupportedFile(filePath: string): boolean {
  return detectLanguage(filePath) !== 'unknown';
}

/** Directories and file patterns to skip during repo traversal */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  'vendor',
  '.vendor',
  'target',        // Rust/Java build output
  '.gradle',
  '.mvn',
  'coverage',
  '.coverage',
  '.nyc_output',
  'venv',
  '.venv',
  'env',
  '.env',
  '.turbo',
  '.cache',
]);

export const IGNORED_EXTENSIONS = new Set([
  '.min.js',
  '.bundle.js',
  '.map',
  '.lock',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.mp4',
  '.mp3',
  '.wav',
]);
