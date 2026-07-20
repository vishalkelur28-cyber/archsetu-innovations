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

// ─── Git History ──────────────────────────────────────────────────────────────
// Computed from a bounded slice of commit history (see GIT_HISTORY_MAX_COMMITS
// in GitHistoryAnalyzer.ts) - deliberately "recent activity," not "entire
// project archaeology." A repo cloned specifically for analysis only fetches
// that bounded depth, so results reflect who's actively maintaining the code
// now, not every contributor since the first commit.

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface FileOwnership {
  filePath: string;
  /** Every distinct author who touched this file within the analyzed window, sorted by commit count descending. */
  authors: Array<CommitAuthor & { commitCount: number; percentage: number }>;
  /** The author with the most commits touching this file. */
  primaryOwner: CommitAuthor;
}

export type BusFactorRisk = 'low' | 'medium' | 'high' | 'critical';

export interface RepoBusFactor {
  /**
   * Truck factor: the minimum number of top contributors (by files owned)
   * whose combined departure would leave over half the codebase's files
   * without their primary maintainer. 1 means a single person's departure
   * already crosses that line.
   */
  busFactor: number;
  topContributors: Array<CommitAuthor & { fileCount: number; percentageOfCodebase: number }>;
  riskLevel: BusFactorRisk;
}

export interface FileChurn {
  filePath: string;
  commitCount: number;
  authorCount: number;
  lastModified: string;
}

export interface GitHistoryResult {
  /** How many commits were actually walked - always ≤ the configured bound. */
  commitsAnalyzed: number;
  oldestCommitDate: string | null;
  newestCommitDate: string | null;
  busFactor: RepoBusFactor;
  fileOwnership: FileOwnership[];
  /** Top files by commit count within the analyzed window, descending. */
  highChurnFiles: FileChurn[];
}

// ─── Security Risk ────────────────────────────────────────────────────────────
// Regex-based heuristics only (no AST, no network calls, no vulnerability
// database lookups) - see SecurityRiskAnalyzer.ts for the full rationale and
// the accepted false-positive tradeoff.

export type SecurityFindingCategory =
  | 'hardcoded-secret'
  | 'dynamic-code-execution'
  | 'sql-injection-risk';

export type SecuritySeverity = 'high' | 'medium' | 'low';

export interface SecurityFinding {
  category: SecurityFindingCategory;
  severity: SecuritySeverity;
  filePath: string;
  /** 1-indexed line number. */
  line: number;
  description: string;
  /** Matched line, trimmed - secret VALUES are masked in place, never stored in full. */
  lineText: string;
}

export interface SecurityRiskResult {
  findings: SecurityFinding[];
  highCount: number;
  mediumCount: number;
  lowCount: number;
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
  /**
   * null when the rootDir isn't a git repository, or has no commit history
   * available (e.g. a fresh/empty repo) - never let a consumer assume this
   * is always populated the way the other fields are.
   */
  gitHistory: GitHistoryResult | null;
  /** Regex-based security heuristics - hardcoded secrets, unsafe dynamic execution, string-built SQL. */
  securityRisk: SecurityRiskResult;
  /**
   * True when the repo had more eligible source files than walkRepo's cap
   * (10,000 by default) and traversal was cut short - every metric below is
   * computed from a partial file set, not the full repo. Surface this to
   * the user rather than presenting a partial analysis as complete.
   */
  truncated: boolean;
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
