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
  /** Fraction (0-1) of all functions at "critical" complexity (>20) - see
   * HealthScorer's highComplexityRatio doc comment for why this, not
   * maxComplexity, feeds the health score's complexity sub-score. */
  highComplexityRatio: number;
  files: FileComplexity[];
  mostComplex: FunctionComplexity[];
}

// ─── Test Risk ────────────────────────────────────────────────────────────────
// See TestRiskAnalyzer.ts for the full methodology - static reachability from
// test-file functions through the same call graph dead-code detection already
// builds, not measured line/branch coverage from an actual test run.

export interface TestRiskHotspot {
  functionName: string;
  filePath: string;
  startLine: number;
  complexity: number;
  /** null when git history wasn't available for this analysis (e.g. a shallow clone). */
  churnCount: number | null;
  reason: string;
}

export interface TestRiskResult {
  /** Ranked highest-risk first, capped - see TestRiskAnalyzer's MAX_HOTSPOTS. */
  hotspots: TestRiskHotspot[];
  /** Non-test, non-dead functions with no static call-graph path from any test file. */
  untestedFunctionCount: number;
  /** Non-test, non-dead functions total - the denominator untestedRatio is computed against. */
  testableFunctionCount: number;
  untestedRatio: number;
  hasChurnData: boolean;
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
  | 'sql-injection-risk'
  | 'insecure-transport'
  | 'weak-cryptography'
  | 'container-misconfiguration'
  | 'cloud-exposure'
  | 'ci-workflow-injection';

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

// ─── Git History Secret Scan ───────────────────────────────────────────────────
// A secret committed once and later deleted is still readable in git history
// forever - the current-tree scan above can never see it, since it only reads
// files as they exist right now. Same bounded window as GitHistoryResult
// (GIT_HISTORY_MAX_COMMITS), same reasoning: recent activity, not full
// project archaeology.

export interface HistoricalSecretFinding {
  /** Always 'hardcoded-secret' today - kept as SecurityFindingCategory rather than a narrower literal so this can share types/UI with SecurityFinding if more historical categories are added later. */
  category: SecurityFindingCategory;
  severity: SecuritySeverity;
  filePath: string;
  /** Full commit hash the secret was introduced in (an added line in that commit's diff). */
  commitHash: string;
  /** ISO 8601 - when the introducing commit was made. */
  commitDate: string;
  description: string;
  /** Matched line, trimmed - secret VALUES are masked in place, same redaction as SecurityFinding.lineText. */
  lineText: string;
}

export interface GitHistorySecretScanResult {
  findings: HistoricalSecretFinding[];
  /** How many commits were actually walked - always ≤ the configured bound. */
  commitsScanned: number;
}

// ─── Dependency Vulnerabilities ────────────────────────────────────────────────
// Two-phase, unlike every other field on RepoAnalysis: `declaredDependencies`
// is pure manifest parsing (see DependencyVersionExtractor.ts) and IS
// computed inside analyzeRepo() like everything else. `dependencyVulnerabilities`
// requires an actual vulnerability-database network call (OSV.dev), which
// this package's public contract explicitly forbids - analyzeRepo() always
// leaves it null. The worker and CLI, which already talk to the network for
// other reasons, populate it afterward and attach it to this same object
// before storing/uploading the result. See apps/web/src/lib/osv.ts.

/** See DependencyVersionExtractor.ts for how this is parsed out of each ecosystem's manifest format. */
export interface DeclaredDependency {
  name: string;
  /** Best-effort version, not necessarily the exact installed one for npm - see DependencyVersionExtractor's normalizeNpmVersionRange doc comment. Always exact for PyPI/Go. */
  version: string;
  ecosystem: 'npm' | 'PyPI' | 'Go';
  /** Relative path to the manifest file this was declared in, for display context. */
  manifestPath: string;
}

export type DependencySeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface DependencyVulnerability {
  packageName: string;
  /** The declared version that was checked - see DeclaredDependency's own caveat about npm ranges. */
  version: string;
  ecosystem: 'npm' | 'PyPI' | 'Go';
  /** OSV/GHSA/CVE identifier, e.g. "GHSA-xxxx-xxxx-xxxx" or "CVE-2023-12345". */
  vulnId: string;
  summary: string;
  severity: DependencySeverity;
  /** The version that fixes this, if OSV's data includes one. */
  fixedVersion: string | null;
  referenceUrl: string | null;
}

export interface DependencyVulnScanResult {
  vulnerabilities: DependencyVulnerability[];
  dependenciesScanned: number;
  criticalCount: number;
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
  /** Complex/frequently-changed functions with no static call-graph path from any test file - see TestRiskAnalyzer.ts. */
  testRisk: TestRiskResult;
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
   * Secrets found in historical commit diffs, not the current checked-out
   * tree - null under the exact same conditions as gitHistory (not a git
   * repo, no commits, or the git subprocess timed out/failed). A finding
   * here does NOT imply the same secret is still present in the current
   * code (see securityRisk for that) - it means this value was committed at
   * some point and is permanently recoverable from history regardless of
   * whether it was later deleted, so it should be treated as compromised
   * and rotated either way.
   */
  gitHistorySecrets: GitHistorySecretScanResult | null;
  /** Pure manifest parsing (package.json/requirements.txt/go.mod) - see DependencyVersionExtractor.ts. */
  declaredDependencies: DeclaredDependency[];
  /**
   * Always null immediately after analyzeRepo() returns - this package never
   * makes network calls, and checking a dependency against a vulnerability
   * database requires one. The worker/CLI populate this after the fact; a
   * report showing this as null after 'complete' means the OSV lookup itself
   * failed or timed out, not that the repo has zero vulnerable dependencies -
   * see DependencyVulnScanResult's own doc comment.
   */
  dependencyVulnerabilities: DependencyVulnScanResult | null;
  /**
   * True when the repo had more eligible source files than walkRepo's cap
   * (10,000 by default) and traversal was cut short - every metric below is
   * computed from a partial file set, not the full repo. Surface this to
   * the user rather than presenting a partial analysis as complete.
   */
  truncated: boolean;
  /**
   * True when one or more of the large per-function/per-edge detail arrays
   * (callGraph, complexity.files[].functions, deadCode) were capped for
   * storage/render-size reasons - unlike `truncated` above, every scalar
   * stat (totalFunctions, health, deadCodeRatio, etc.) is still computed
   * from the complete, uncapped analysis; only these detail views are
   * bounded. See ResultSizeCapper in packages/core for the caps themselves.
   */
  detailTruncated: boolean;
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
