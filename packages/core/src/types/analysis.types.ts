/**
 * Result types for all high-level analysis operations.
 * Consumers (web worker, CLI, API) interact with these types via packages/core/index.ts.
 */

import type { ParsedFunction, SupportedLanguage } from './parser.types.js';

// ─── Health Score ─────────────────────────────────────────────────────────────

export type HealthGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthScoreBreakdown {
  /** 100 − (deadCodeRatio × 100) */
  deadCodeRatio: number;
  /** 100 − ((avgComplexity − 1) × 10), clamped ≥ 0 */
  avgComplexity: number;
  /** 100 − (maxComplexity × 2), clamped ≥ 0 */
  maxComplexity: number;
  /**
   * testFileRatio × 200, clamped ≤ 100. Field name kept as `testCoverage` for
   * backward compatibility with already-stored analysis JSON (renaming it
   * would silently break every report analyzed before this comment was
   * added, with no migration path since old blobs are immutable in
   * storage). Every human-facing label reads "Test File Ratio" - this is
   * a file-count ratio, not measured line/branch coverage; don't let the
   * field name mislead a future display site into calling it "coverage."
   */
  testCoverage: number;
  /** 100 − (duplicationRatio × 100) */
  duplication: number;
  /** 100 − (oversizedFileRatio × 100) */
  fileSize: number;
}

export interface HealthScore {
  score: number;
  grade: HealthGrade;
  breakdown: HealthScoreBreakdown;
}

// ─── Call Graph ───────────────────────────────────────────────────────────────

export interface CallGraphNode {
  id: string;
  name: string;
  filePath: string;
  language: SupportedLanguage;
  complexity: number;
  isExported: boolean;
  isEntryPoint: boolean;
  isDead: boolean;
  lineCount: number;
  startLine: number;
}

export interface CallGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

// ─── Dead Code ────────────────────────────────────────────────────────────────

export interface DeadCodeResult {
  function: ParsedFunction;
  callerCount: number;
  isSafeToRemove: boolean;
}

// ─── Entry Points ─────────────────────────────────────────────────────────────

export type EntryPointType = 'cli' | 'server' | 'test' | 'library' | 'script' | 'other';

export interface EntryPoint {
  name: string;
  filePath: string;
  startLine: number;
  type: EntryPointType;
  description: string;
  language: SupportedLanguage;
}

// ─── Complexity ───────────────────────────────────────────────────────────────

export type ComplexityLevel = 'low' | 'medium' | 'high' | 'critical';

export interface FunctionComplexity {
  name: string;
  filePath: string;
  startLine: number;
  complexity: number;
  level: ComplexityLevel;
  lineCount: number;
}

export interface FileComplexity {
  filePath: string;
  language: SupportedLanguage;
  avgComplexity: number;
  maxComplexity: number;
  level: ComplexityLevel;
  functions: FunctionComplexity[];
}

export interface ComplexityReport {
  avgComplexity: number;
  maxComplexity: number;
  files: FileComplexity[];
  mostComplex: FunctionComplexity[];
}

// ─── Blast Radius ─────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface BlastRadiusResult {
  targetFunction: string;
  targetFile: string;
  affectedFunctions: Array<{
    function: ParsedFunction;
    depth: number;
    callPath: string[];
  }>;
  affectedFiles: string[];
  riskLevel: RiskLevel;
  totalImpact: number;
}

// ─── Change Impact ────────────────────────────────────────────────────────────

export interface ChangeImpactResult {
  targetFile: string;
  directDependents: string[];
  indirectDependents: string[];
  totalAffectedFiles: number;
  riskLevel: RiskLevel;
  affectedFunctions: ParsedFunction[];
}

/**
 * Reverse-dependency graph: filePath -> direct dependents (files that import
 * it). Precomputed once per analysis so the UI can answer "what breaks if I
 * change this file" for any file via client-side BFS, without a server
 * round-trip or re-walking every file's imports per query.
 */
export interface ChangeImpactGraph {
  [filePath: string]: string[];
}

// ─── File Explanation ─────────────────────────────────────────────────────────

export interface FileExplanation {
  filePath: string;
  language: SupportedLanguage;
  explanation: string;
  purpose: string;
  imports: Array<{ source: string; symbols: string[] }>;
  exports: string[];
  functions: ParsedFunction[];
  lineCount: number;
}

// ─── Onboarding Guide ─────────────────────────────────────────────────────────

export type OnboardingStopReason = 'entry-point' | 'hub';

export interface OnboardingStop {
  filePath: string;
  language: SupportedLanguage;
  /** Why this file is on the list: it's an entry point, or it's highly connected to the rest of the codebase */
  reason: OnboardingStopReason;
  /** Human-readable description of what makes it worth visiting first */
  reasonDetail: string;
  /** What the file does, from FileExplainer */
  explanation: string;
  /** Total call-graph edges (incoming + outgoing) touching functions in this file */
  connectionCount: number;
}

export interface OnboardingGuide {
  stops: OnboardingStop[];
  /** e.g. "This repo has 3 entry points and 245 functions across 60 files. These 6 files touch 42% of all call-graph connections." */
  summary: string;
}

// ─── Dependency Hygiene ───────────────────────────────────────────────────────

export interface UndeclaredImport {
  packageName: string;
  importedFrom: string[];
}

export interface DependencyHygieneResult {
  undeclaredImports: UndeclaredImport[];
}

// ─── Full Repo Analysis ───────────────────────────────────────────────────────

export interface LanguageBreakdown {
  [language: string]: number;
}

export interface RepoAnalysis {
  rootDir: string;
  health: HealthScore;
  callGraph: CallGraph;
  deadCode: DeadCodeResult[];
  entryPoints: EntryPoint[];
  complexity: ComplexityReport;
  onboarding: OnboardingGuide;
  dependencyHygiene: DependencyHygieneResult;
  changeImpactGraph: ChangeImpactGraph;
  languageBreakdown: LanguageBreakdown;
  totalFunctions: number;
  totalFiles: number;
  totalLines: number;
  avgComplexity: number;
  maxComplexity: number;
  deadCodeRatio: number;
  testFileRatio: number;
  duplicationRatio: number;
  oversizedFileRatio: number;
  primaryLanguage: SupportedLanguage;
  analyzedAt: string;
}
