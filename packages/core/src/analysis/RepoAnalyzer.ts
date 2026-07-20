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
import { analyzeSecurityRisk } from './SecurityRiskAnalyzer.js';
import { buildOnboardingGuide } from './OnboardingGuide.js';
import { checkDependencyHygiene } from './DependencyHygiene.js';
import { buildReverseDependencyGraph } from './ChangeImpactAnalyzer.js';
import { analyzeGitHistory } from './GitHistoryAnalyzer.js';
import { detectMonorepo } from '../utils/monorepoUtils.js';
import { detectTsPathAliases } from '../utils/tsconfigUtils.js';

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
 *
 * `options.maxFiles` defaults to walkRepo's own 10,000-file cap, which
 * exists to protect ArchSetu's own memory-constrained hosted worker (see
 * apps/web/workers/analyzeJob.child.mts, which calls this with no options
 * and so always gets that default). Callers running with real headroom -
 * the CLI's `submit` command in particular, when invoked from a GitHub
 * Actions runner rather than the hosted worker - should pass a higher
 * value rather than silently truncating large real-world repos.
 */
export async function analyzeRepo(
  rootDir: string,
  options: { maxFiles?: number } = {},
): Promise<RepoAnalysis> {
  // ── 1. Walk and parse ──────────────────────────────────────────────────────
  const { files: walkedFiles, truncated } = await walkRepo(rootDir, options);
  const fileContentMap = new Map<string, string>();
  const fileAnalyses: FileAnalysis[] = [];

  for (const walked of walkedFiles) {
    fileContentMap.set(walked.filePath, walked.content);
    const analysis = parseFile(walked.content, walked.filePath);
    if (analysis) fileAnalyses.push(analysis);
  }

  if (fileAnalyses.length === 0) {
    return buildEmptyAnalysis(rootDir, truncated);
  }

  // ── 2. Aggregate base metrics ──────────────────────────────────────────────
  const totalFiles = fileAnalyses.length;
  const totalLines = fileAnalyses.reduce((s, f) => s + f.lineCount, 0);
  const totalFunctions = fileAnalyses.reduce((s, f) => s + f.functions.length, 0);

  const testFileCount = walkedFiles.filter((f) => isTestFile(f.filePath)).length;
  const testFileRatio = totalFiles > 0 ? testFileCount / totalFiles : 0;
  // walkedFiles itself isn't referenced again after this point (every later
  // pass works from fileAnalyses/fileContentMap instead) - truncating it in
  // place lets its per-file wrapper objects (filePath/relativePath/sizeBytes,
  // on top of the content string already tracked via fileContentMap) be
  // reclaimed a little earlier than waiting for the whole function to return.
  walkedFiles.length = 0;

  const oversizedFileCount = fileAnalyses.filter((f) => f.lineCount > OVERSIZED_LINE_THRESHOLD).length;
  const oversizedFileRatio = totalFiles > 0 ? oversizedFileCount / totalFiles : 0;

  // ── 3. Analysis passes ────────────────────────────────────────────────────
  const deadCode = findDeadCode(fileAnalyses);
  // The health score's deadCodeRatio counts only confidently-dead functions
  // (isSafeToRemove: private, non-test, zero known callers) - not every
  // zero-caller function. An exported function with zero known callers is
  // still listed in `deadCode` (useful, worth surfacing), but is excluded
  // from this ratio: for a library or framework repo, most of its exported
  // surface is called by external consumers this analysis can never see
  // (they're not part of the cloned repo), so counting it as "dead" the
  // same way as a genuinely unreachable private function systematically
  // tanks the health score of every library/framework repo. Confirmed
  // directly against electron/electron, whose public API showed as ~60%
  // "dead" under the old blanket count.
  const confidentlyDeadCount = deadCode.filter((d) => d.isSafeToRemove).length;
  const deadCodeRatio = totalFunctions > 0 ? confidentlyDeadCount / totalFunctions : 0;

  // Computed here, immediately after parsing, specifically so
  // fileContentMap - every file's full raw text, held simultaneously - can
  // be released right after. It's the single largest piece of memory this
  // function ever holds (easily hundreds of MB to low GB on a large real
  // repo), and estimateDuplicationRatio is its only consumer; every pass
  // below this point works from the already-parsed FileAnalysis structures
  // instead, which don't need the original source text. On the free-tier
  // worker VM (1 OCPU / 6GB RAM total), holding that raw text alive for the
  // rest of a large analysis was real, unnecessary memory pressure -
  // confirmed directly: supabase/supabase (8,004 files, 1M+ lines) was
  // SIGKILLed by the OS during analysis, which --max-old-space-size cannot
  // prevent on its own since it only bounds the V8 heap, not this kind of
  // external/Buffer-backed string memory.
  const duplicationRatio = estimateDuplicationRatio(fileAnalyses, fileContentMap);
  // Same reasoning as duplication detection above: this is the one other pass
  // that needs each file's raw source text (to regex-scan for secrets/unsafe
  // calls/string-built SQL) rather than just the already-parsed structure, so
  // it has to run in this same window before fileContentMap is released.
  const securityRisk = analyzeSecurityRisk(fileAnalyses, fileContentMap);
  fileContentMap.clear();

  const callGraph = buildCallGraph(fileAnalyses, rootDir);
  const entryPoints = detectEntryPointsFromAnalyses(fileAnalyses, rootDir);
  const complexity = analyzeComplexity(fileAnalyses);
  const onboarding = buildOnboardingGuide(fileAnalyses, callGraph, entryPoints);

  // package.json is metadata, not a source file walkRepo parses (it's
  // deliberately excluded from the supported-extensions list), so it has to
  // be read independently here rather than pulled from fileContentMap. In a
  // monorepo, a dependency can be correctly declared in any workspace
  // package's package.json, not just the root one - detectMonorepo finds
  // all of them so checkDependencyHygiene can resolve against the nearest
  // (or any) relevant declaration instead of only the root.
  const { sources: dependencySources } = await detectMonorepo(rootDir);
  // A bare import specifier isn't always a package - tsconfig/jsconfig path
  // aliases (`@/*`) and baseUrl-relative imports (`components/Foo`) resolve
  // to local files, not node_modules. See tsconfigUtils.detectTsPathAliases.
  const tsAliasSources = await detectTsPathAliases(rootDir);
  const dependencyHygiene = checkDependencyHygiene(fileAnalyses, dependencySources, tsAliasSources);
  const changeImpactGraph = buildReverseDependencyGraph(fileAnalyses);
  const gitHistory = await analyzeGitHistory(rootDir);

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
    gitHistory,
    securityRisk,
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
    truncated,
    analyzedAt: new Date().toISOString(),
  };
}

function buildEmptyAnalysis(rootDir: string, truncated = false): RepoAnalysis {
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
    gitHistory: null,
    securityRisk: { findings: [], highCount: 0, mediumCount: 0, lowCount: 0 },
    languageBreakdown: {}, totalFunctions: 0, totalFiles: 0, totalLines: 0,
    avgComplexity: 1, maxComplexity: 1, deadCodeRatio: 0, testFileRatio: 0,
    duplicationRatio: 0, oversizedFileRatio: 0, primaryLanguage: 'unknown',
    truncated,
    analyzedAt: new Date().toISOString(),
  };
}
