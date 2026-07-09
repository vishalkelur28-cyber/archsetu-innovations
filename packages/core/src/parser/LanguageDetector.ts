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
};

export function detectLanguage(filePath: string): SupportedLanguage {
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
