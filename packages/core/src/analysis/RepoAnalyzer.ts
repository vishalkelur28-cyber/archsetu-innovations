import type { FileAnalysis } from '../types/parser.types.js';
import type { RepoAnalysis, LanguageBreakdown } from '../types/analysis.types.js';
import type { SupportedLanguage } from '../types/parser.types.js';
import { parseFile } from '../parser/ParserRegistry.js';
import { walkRepo } from '../utils/fileUtils.js';
import { isTestFile } from '../utils/fileUtils.js';
import { calculateHealthScore } from './HealthScorer.js';
import { findDeadCode } from './DeadCodeFinder.js';
import { buildCallGraph } from './CallGraphBuilder.js';
import { detectEntryPointsFromAnalyses } from './EntryPointDetector.js';
import { analyzeComplexity } from './ComplexityAnalyzer.js';
import { estimateDuplicationRatio } from './DuplicationDetector.js';
import { buildOnboardingGuide } from './OnboardingGuide.js';
import { checkDependencyHygiene } from './DependencyHygiene.js';
import { buildReverseDependencyGraph } from './ChangeImpactAnalyzer.js';
import path from 'path';
import fs from 'fs/promises';

const OVERSIZED_LINE_THRESHOLD = 300;

/**
 * Orchestrates a full analysis of a repository.
 *
 * Order of operations:
 * 1. Walk the repo file tree
 * 2. Parse each supported file
 * 3. Run all analysis passes over the parsed data
 * 4. Assemble the RepoAnalysis result
 *
 * The rootDir must be the absolute path to the cloned repository.
 * This function never writes files or makes network requests.
 */
export async function analyzeRepo(rootDir: string): Promise<RepoAnalysis> {
  // ── 1. Walk and parse ──────────────────────────────────────────────────────
  const walkedFiles = await walkRepo(rootDir);
  const fileContentMap = new Map<string, string>();
  const fileAnalyses: FileAnalysis[] = [];

  for (const walked of walkedFiles) {
    fileContentMap.set(walked.filePath, walked.content);
    const analysis = parseFile(walked.content, walked.filePath);
    if (analysis) fileAnalyses.push(analysis);
  }

  if (fileAnalyses.length === 0) {
    return buildEmptyAnalysis(rootDir);
  }

  // ── 2. Aggregate base metrics ──────────────────────────────────────────────
  const totalFiles = fileAnalyses.length;
  const totalLines = fileAnalyses.reduce((s, f) => s + f.lineCount, 0);
  const totalFunctions = fileAnalyses.reduce((s, f) => s + f.functions.length, 0);

  const testFileCount = walkedFiles.filter((f) => isTestFile(f.filePath)).length;
  const testFileRatio = totalFiles > 0 ? testFileCount / totalFiles : 0;

  const oversizedFileCount = fileAnalyses.filter((f) => f.lineCount > OVERSIZED_LINE_THRESHOLD).length;
  const oversizedFileRatio = totalFiles > 0 ? oversizedFileCount / totalFiles : 0;

  // ── 3. Analysis passes ────────────────────────────────────────────────────
  const deadCode = findDeadCode(fileAnalyses);
  const deadCodeRatio = totalFunctions > 0 ? deadCode.length / totalFunctions : 0;

  const callGraph = buildCallGraph(fileAnalyses, rootDir);
  const entryPoints = detectEntryPointsFromAnalyses(fileAnalyses, rootDir);
  const complexity = analyzeComplexity(fileAnalyses);
  const duplicationRatio = estimateDuplicationRatio(fileAnalyses, fileContentMap);
  const onboarding = buildOnboardingGuide(fileAnalyses, callGraph, entryPoints);

  // package.json is metadata, not a source file walkRepo parses (it's
  // deliberately excluded from the supported-extensions list), so it has to
  // be read independently here rather than pulled from fileContentMap.
  const packageJsonContent = await readPackageJsonSafely(rootDir);
  const dependencyHygiene = checkDependencyHygiene(fileAnalyses, packageJsonContent);
  const changeImpactGraph = buildReverseDependencyGraph(fileAnalyses);

  const avgComplexity = complexity.avgComplexity;
  const maxComplexity = complexity.maxComplexity;

  // ── 4. Health score ───────────────────────────────────────────────────────
  const health = calculateHealthScore({
    deadCodeRatio,
    avgComplexity,
    maxComplexity,
    testFileRatio,
    duplicationRatio,
    oversizedFileRatio,
  });

  // ── 5. Language breakdown ─────────────────────────────────────────────────
  const languageBreakdown: LanguageBreakdown = {};
  for (const file of fileAnalyses) {
    const lang = file.language;
    languageBreakdown[lang] = (languageBreakdown[lang] ?? 0) + file.lineCount;
  }

  // Convert to percentages
  const totalLangLines = Object.values(languageBreakdown).reduce((s, v) => s + v, 0);
  if (totalLangLines > 0) {
    for (const lang of Object.keys(languageBreakdown)) {
      const val = languageBreakdown[lang];
      if (val !== undefined) {
        languageBreakdown[lang] = Math.round((val / totalLangLines) * 100);
      }
    }
  }

  const primaryLanguage = (Object.entries(languageBreakdown)
    .sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'unknown') as SupportedLanguage;

  return {
    rootDir,
    health,
    callGraph,
    deadCode,
    entryPoints,
    complexity,
    onboarding,
    dependencyHygiene,
    changeImpactGraph,
    languageBreakdown,
    totalFunctions,
    totalFiles,
    totalLines,
    avgComplexity,
    maxComplexity,
    deadCodeRatio,
    testFileRatio,
    duplicationRatio,
    oversizedFileRatio,
    primaryLanguage,
    analyzedAt: new Date().toISOString(),
  };
}

async function readPackageJsonSafely(rootDir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(rootDir, 'package.json'), 'utf-8');
  } catch {
    return null; // not a Node.js project, or no root package.json - fine, not an error
  }
}

function buildEmptyAnalysis(rootDir: string): RepoAnalysis {
  const health = calculateHealthScore({
    deadCodeRatio: 0, avgComplexity: 1, maxComplexity: 1,
    testFileRatio: 0, duplicationRatio: 0, oversizedFileRatio: 0,
  });
  return {
    rootDir, health, callGraph: { nodes: [], edges: [] }, deadCode: [],
    entryPoints: [], complexity: { avgComplexity: 1, maxComplexity: 1, files: [], mostComplex: [] },
    onboarding: { stops: [], summary: 'No files were found to analyze.' },
    dependencyHygiene: { undeclaredImports: [] },
    changeImpactGraph: {},
    languageBreakdown: {}, totalFunctions: 0, totalFiles: 0, totalLines: 0,
    avgComplexity: 1, maxComplexity: 1, deadCodeRatio: 0, testFileRatio: 0,
    duplicationRatio: 0, oversizedFileRatio: 0, primaryLanguage: 'unknown',
    analyzedAt: new Date().toISOString(),
  };
}
