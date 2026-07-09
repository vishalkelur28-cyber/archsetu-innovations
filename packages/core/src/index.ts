/**
 * @archsetu/core - Public API
 *
 * All analysis functions operate on a local directory path (rootDir).
 * No network requests are made. No VS Code dependencies.
 *
 * Typical usage:
 *   import { analyzeRepo } from '@archsetu/core';
 *   const result = await analyzeRepo('/path/to/cloned/repo');
 */

export { analyzeRepo } from './analysis/RepoAnalyzer.js';

// Individual analysis functions (used by CLI and GitHub App)
export { calculateHealthScore } from './analysis/HealthScorer.js';
export { findDeadCode } from './analysis/DeadCodeFinder.js';
export { buildCallGraph } from './analysis/CallGraphBuilder.js';
export { detectEntryPointsFromAnalyses as detectEntryPoints } from './analysis/EntryPointDetector.js';
export { analyzeComplexity } from './analysis/ComplexityAnalyzer.js';
export { analyzeBlastRadius } from './analysis/BlastRadiusAnalyzer.js';
export { analyzeChangeImpact } from './analysis/ChangeImpactAnalyzer.js';
export { explainFile } from './analysis/FileExplainer.js';
export { buildOnboardingGuide } from './analysis/OnboardingGuide.js';
export { generatePrDescriptionDraft } from './analysis/PrDescriptionGenerator.js';
export { compareAnalyses } from './analysis/AnalysisComparator.js';
export { checkDependencyHygiene } from './analysis/DependencyHygiene.js';

// Parser utilities (used by CLI for per-file analysis)
export { parseFile } from './parser/ParserRegistry.js';
export { detectLanguage } from './parser/LanguageDetector.js';
export { walkRepo } from './utils/fileUtils.js';

// Types re-exported for consumers
export type {
  RepoAnalysis,
  HealthScore,
  HealthGrade,
  CallGraph,
  CallGraphNode,
  CallGraphEdge,
  DeadCodeResult,
  EntryPoint,
  EntryPointType,
  ComplexityReport,
  FileComplexity,
  FunctionComplexity,
  ComplexityLevel,
  BlastRadiusResult,
  ChangeImpactResult,
  ChangeImpactGraph,
  FileExplanation,
  RiskLevel,
  LanguageBreakdown,
  OnboardingGuide,
  OnboardingStop,
  OnboardingStopReason,
  UndeclaredImport,
  DependencyHygieneResult,
} from './types/analysis.types.js';

export type { ChangedFunctionSummary, PrDescriptionDraft } from './analysis/PrDescriptionGenerator.js';
export type { AnalysisDiff } from './analysis/AnalysisComparator.js';

export type {
  ParsedFunction,
  ParsedImport,
  ParsedClass,
  FileAnalysis,
  LanguageParser,
  SupportedLanguage,
} from './types/parser.types.js';
