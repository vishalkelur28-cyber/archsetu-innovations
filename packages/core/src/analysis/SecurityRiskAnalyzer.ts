import type { FileAnalysis, SupportedLanguage } from '../types/parser.types.js';

/**
 * Regex-based security risk scanning: hardcoded credentials, dangerous
 * dynamic-execution calls, and string-built SQL queries.
 *
 * This is a companion pass to DeadCodeFinder/ComplexityAnalyzer/
 * GitHistoryAnalyzer, not a replacement for a real SAST tool - it runs on
 * raw line text (same tradeoff as DuplicationDetector), not a real AST or
 * data-flow graph, so it cannot know whether a matched value ever reaches an
 * untrusted input. Every finding here is "this pattern is a well-established
 * anti-pattern, worth a human look" - not "this is a confirmed vulnerability."
 * False positives are expected and acceptable in exchange for zero network
 * calls and zero added dependencies (see the file-header note in
 * DependencyHygiene.ts for the same one-directional-signal philosophy).
 *
 * Deliberately does NOT check dependencies against a known-vulnerability
 * database (e.g. OSV.dev) - that requires a network call, which this
 * package's public contract explicitly forbids (see index.ts: "No network
 * requests are made"). A dependency-vulnerability check belongs one layer up,
 * in the worker that already talks to GitHub/Supabase, not here.
 */

// ─── Public types ───────────────────────────────────────────────────────────

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
  /** Human-readable explanation of what matched and why it's worth reviewing. */
  description: string;
  /**
   * The matched line, trimmed and length-capped. For `hardcoded-secret`
   * findings the credential value itself is masked in place (see
   * redactMatch) - the surrounding code (variable name, call site) stays
   * visible since that's what makes the finding actionable, but the real
   * value is never stored or displayed, including on a public repo's public
   * report page.
   */
  lineText: string;
}

export interface SecurityRiskResult {
  findings: SecurityFinding[];
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

// ─── Tuning ─────────────────────────────────────────────────────────────────

/**
 * Hard cap on total findings. A pathological repo (a vendored SQL dump, a
 * generated file full of matching-looking strings) could otherwise produce
 * thousands of findings - unbounded growth here is exactly the kind of
 * unnecessary memory pressure the worker VM can't afford (see RepoAnalyzer's
 * fileContentMap release note for the same concern applied to a different
 * structure).
 */
const MAX_FINDINGS = 500;

/** Lines referencing an env var aren't hardcoded - the value isn't in source. */
const ENV_REFERENCE_PATTERN = /process\.env|os\.environ|System\.getenv|ENV\[|getenv\(/;

// ─── Hardcoded secrets ──────────────────────────────────────────────────────

interface SecretRule {
  name: string;
  /** Must contain exactly one capturing group: the value to redact. */
  pattern: RegExp;
  severity: SecuritySeverity;
}

const SECRET_RULES: SecretRule[] = [
  { name: 'AWS Access Key ID', pattern: /(AKIA[0-9A-Z]{16})/, severity: 'high' },
  { name: 'GitHub access token', pattern: /(gh[pousr]_[A-Za-z0-9]{36,})/, severity: 'high' },
  { name: 'Slack token', pattern: /(xox[baprs]-[0-9A-Za-z-]{10,72})/, severity: 'high' },
  {
    name: 'Private key block',
    pattern: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----)/,
    severity: 'high',
  },
  {
    name: 'Hardcoded credential assignment',
    pattern:
      /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"]([A-Za-z0-9_\-/+=]{16,})['"]/i,
    severity: 'medium',
  },
];

/**
 * Common placeholder/fixture values that would otherwise trip the generic
 * "credential assignment" rule constantly - `apiKey: "your_api_key_here"` in
 * a README example or `secret: "changeme"` in a docker-compose template is
 * not a leaked credential. Same false-positive-avoidance instinct as
 * DeadCodeFinder's isSafeToRemove distinction: a noisy, untrustworthy
 * security pass is worse than a slightly incomplete one.
 */
const PLACEHOLDER_VALUE_PATTERN =
  /^(changeme|change[_-]?me|your[_-]?api[_-]?key|xxx+|placeholder|example|dummy|fake|test|todo|secret|password|redacted|null|undefined)$/i;

function looksLikePlaceholder(value: string): boolean {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true;
  if (value.startsWith('<') && value.endsWith('>')) return true;
  if (value.startsWith('${') && value.endsWith('}')) return true;
  if (/^(.)\1{5,}$/.test(value)) return true; // "aaaaaaaa", "111111111"
  return false;
}

function scanForSecrets(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (ENV_REFERENCE_PATTERN.test(line)) continue;

    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      const value = match[1] ?? match[0];
      if (looksLikePlaceholder(value)) continue;

      findings.push({
        category: 'hardcoded-secret',
        severity: rule.severity,
        filePath,
        line: i + 1,
        description: `Possible ${rule.name} found in source - credentials should come from environment variables or a secrets manager, never be committed to the repository.`,
        lineText: redactMatch(line, match.index, value),
      });
      break; // one finding per line is plenty; avoid duplicate noise from overlapping rules
    }
  }

  return findings;
}

/** Masks the matched secret value in place, leaving surrounding code visible. */
function redactMatch(line: string, matchIndex: number, value: string): string {
  const valueStart = line.indexOf(value, matchIndex);
  if (valueStart === -1) return '[line redacted]';

  const before = line.slice(0, valueStart);
  const after = line.slice(valueStart + value.length);
  const masked =
    value.length <= 6
      ? '*'.repeat(value.length)
      : `${value.slice(0, 3)}${'*'.repeat(Math.min(20, value.length - 5))}${value.slice(-2)}`;

  return `${before}${masked}${after}`.trim().slice(0, 200);
}

// ─── Dangerous dynamic execution ───────────────────────────────────────────

interface ExecutionRule {
  pattern: RegExp;
  severity: SecuritySeverity;
  description: string;
}

/**
 * Keyed by language rather than applied globally - a bare `exec(` or
 * `system(` regex would false-positive heavily on unrelated same-named APIs
 * in other languages (e.g. JS's `RegExp.prototype.exec`), the same class of
 * mistake DeadCodeFinder's cross-language matching was built to avoid.
 */
const JS_EXECUTION_RULES: ExecutionRule[] = [
  {
    pattern: /\beval\s*\(/,
    severity: 'medium',
    description: 'eval() executes a string as code - a common injection vector if any part of the input can be influenced externally.',
  },
  {
    pattern: /\bnew\s+Function\s*\(/,
    severity: 'medium',
    description: 'The Function constructor compiles a string into executable code - the same risk class as eval().',
  },
];

const EXECUTION_RULES_BY_LANGUAGE: Partial<Record<SupportedLanguage, ExecutionRule[]>> = {
  python: [
    {
      pattern: /\beval\s*\(/,
      severity: 'medium',
      description: 'eval() executes a string as code - a common injection vector if any part of the input can be influenced externally.',
    },
    {
      pattern: /\bexec\s*\(/,
      severity: 'medium',
      description: 'exec() executes a string as code - a common injection vector if any part of the input can be influenced externally.',
    },
    {
      pattern: /\bos\.system\s*\(/,
      severity: 'high',
      description: 'os.system() runs a string directly in the shell - unsanitized input allows arbitrary command execution.',
    },
    {
      pattern: /\bsubprocess\.(?:call|run|Popen|check_call|check_output)\([^)]*shell\s*=\s*True/,
      severity: 'high',
      description: 'shell=True passes the command through the shell - unsanitized input allows arbitrary command execution via shell metacharacters.',
    },
    {
      pattern: /\bpickle\.loads?\s*\(/,
      severity: 'medium',
      description: 'Unpickling untrusted data can execute arbitrary code - pickle is not a safe deserialization format for external input.',
    },
  ],
  javascript: JS_EXECUTION_RULES,
  typescript: JS_EXECUTION_RULES,
  php: [
    {
      pattern: /\beval\s*\(/,
      severity: 'medium',
      description: 'eval() executes a string as code - a common injection vector if any part of the input can be influenced externally.',
    },
    {
      pattern: /\b(?:system|exec|passthru|shell_exec|popen)\s*\(/,
      severity: 'high',
      description: 'Directly executes a shell command - unsanitized input allows arbitrary command execution.',
    },
  ],
  ruby: [
    {
      pattern: /\beval\s*\(/,
      severity: 'medium',
      description: 'eval() executes a string as code - a common injection vector if any part of the input can be influenced externally.',
    },
    {
      pattern: /\bsystem\s*\(/,
      severity: 'high',
      description: 'system() runs a command in a subshell - unsanitized input allows arbitrary command execution.',
    },
  ],
  lua: [
    {
      pattern: /\b(?:loadstring|load)\s*\(/,
      severity: 'medium',
      description: 'loadstring()/load() compiles a string into executable code - a common injection vector if any part of the input can be influenced externally.',
    },
  ],
};

function scanForDynamicExecution(filePath: string, language: SupportedLanguage, content: string): SecurityFinding[] {
  const rules = EXECUTION_RULES_BY_LANGUAGE[language];
  if (!rules) return [];

  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const rule of rules) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        category: 'dynamic-code-execution',
        severity: rule.severity,
        filePath,
        line: i + 1,
        description: rule.description,
        lineText: line.trim().slice(0, 200),
      });
      break;
    }
  }

  return findings;
}

/**
 * child_process.exec()/execSync() only becomes a command-injection risk once
 * its argument is built from something other than a fixed string literal -
 * `execSync('git status')` is fine, `execSync('git show ' + userInput)` is
 * not. Gated on the file actually importing child_process first, so a bare
 * `exec(` in an unrelated context never reaches this check.
 */
const CHILD_PROCESS_IMPORT_PATTERN = /require\(\s*['"]child_process['"]\s*\)|from\s+['"]child_process['"]/;
const EXEC_WITH_DYNAMIC_ARG_PATTERN = /\b(?:exec|execSync)\s*\([^)]*(?:\+|\$\{)/;

function scanForChildProcessInjectionRisk(
  filePath: string,
  language: SupportedLanguage,
  content: string,
): SecurityFinding[] {
  if (language !== 'javascript' && language !== 'typescript') return [];
  if (!CHILD_PROCESS_IMPORT_PATTERN.test(content)) return [];

  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!EXEC_WITH_DYNAMIC_ARG_PATTERN.test(line)) continue;
    findings.push({
      category: 'dynamic-code-execution',
      severity: 'high',
      filePath,
      line: i + 1,
      description: 'child_process.exec()/execSync() called with a concatenated or interpolated command string - unsanitized input allows arbitrary command execution. Prefer execFile()/spawn() with an argument array instead.',
      lineText: line.trim().slice(0, 200),
    });
  }

  return findings;
}

// ─── SQL built via string-building instead of parameters ──────────────────

const SQL_INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*\$\{[^}]+\}[^`]*`/i,
    description: 'SQL query built with a template literal that interpolates a variable directly - use a parameterized query/prepared statement instead of string interpolation.',
  },
  {
    pattern: /f['"][^'"]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"]*\{[^}]+\}[^'"]*['"]/i,
    description: 'SQL query built with an f-string that interpolates a variable directly - use a parameterized query instead of string interpolation.',
  },
  {
    pattern: /['"][^'"]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"]*['"]\s*\+/i,
    description: 'SQL query built via string concatenation - use a parameterized query/prepared statement instead of concatenating values into the query text.',
  },
  {
    pattern: /['"][^'"]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"]*['"]\s*%\s*\S/i,
    description: 'SQL query built via %-style string formatting - use a parameterized query instead of formatting values into the query text.',
  },
];

function scanForSqlInjectionRisk(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const { pattern, description } of SQL_INJECTION_PATTERNS) {
      if (!pattern.test(line)) continue;
      findings.push({
        category: 'sql-injection-risk',
        severity: 'high',
        filePath,
        line: i + 1,
        description,
        lineText: line.trim().slice(0, 200),
      });
      break;
    }
  }

  return findings;
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Runs every security heuristic against each file's raw source text.
 * `fileContents` must be the same map RepoAnalyzer holds for the duration of
 * `estimateDuplicationRatio` - this pass needs to run in that same window,
 * before the map is released, rather than requiring its own separate copy of
 * every file's content held in memory.
 */
export function analyzeSecurityRisk(
  fileAnalyses: FileAnalysis[],
  fileContents: Map<string, string>,
): SecurityRiskResult {
  const findings: SecurityFinding[] = [];

  for (const file of fileAnalyses) {
    if (findings.length >= MAX_FINDINGS) break;

    const content = fileContents.get(file.filePath);
    if (!content) continue;

    findings.push(
      ...scanForSecrets(file.filePath, content),
      ...scanForDynamicExecution(file.filePath, file.language, content),
      ...scanForChildProcessInjectionRisk(file.filePath, file.language, content),
      ...scanForSqlInjectionRisk(file.filePath, content),
    );
  }

  if (findings.length > MAX_FINDINGS) findings.length = MAX_FINDINGS;

  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  for (const finding of findings) {
    if (finding.severity === 'high') highCount++;
    else if (finding.severity === 'medium') mediumCount++;
    else lowCount++;
  }

  return { findings, highCount, mediumCount, lowCount };
}
