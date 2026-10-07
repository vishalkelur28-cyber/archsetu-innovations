import type { FileAnalysis, SupportedLanguage } from '../types/parser.types.js';
import { isMigrationFile, isTestFile } from '../utils/fileUtils.js';
import { scanYamlInfraConfig, scanTerraformInfraConfig, scanDockerfileInfraConfig } from './InfrastructureConfigAnalyzer.js';

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

/**
 * A line whose first non-whitespace characters are a single-line comment
 * marker in virtually any supported language - #  (Python/Ruby/Shell/YAML/
 * PowerShell/Perl), // (JS/TS/Java/Go/C-family/Rust/Kotlin/Swift/PHP), --
 * (SQL/Lua/Haskell), ;; (Lisp family), % (LaTeX/Erlang). An example secret
 * shown for documentation, or commented out for reference, is not a live
 * credential - confirmed as a real, large source of false positives on
 * authelia/authelia's config.template.yml (a config.template.yml file's
 * entire purpose is showing example values, many left commented out).
 *
 * Deliberately line-prefix-only, not real comment parsing: this cannot
 * catch a trailing `// example` after real code on the same line, or a
 * multi-line /* block comment *\/ - both would need actual per-language
 * lexing this text-based pass doesn't do. Same accepted-false-positive
 * tradeoff as the rest of this file; this closes the single largest,
 * cheapest-to-fix gap, not every gap.
 */
// `--(?!-)` (not `--` alone): a real SQL/Lua-style comment is "--" followed
// by a space or text, never another dash - "-----BEGIN RSA PRIVATE KEY-----"
// starts with five dashes and would otherwise be misread as a comment,
// caught by this exact test suite's own private-key fixture regressing
// before this negative lookahead was added.
const COMMENT_LINE_PATTERN = /^\s*(#|\/\/|--(?!-)|;;|%)/;

function isCommentLine(line: string): boolean {
  return COMMENT_LINE_PATTERN.test(line);
}

/**
 * A line carrying an explicit lint-suppression marker - Go's `nolint`
 * (commonly `//nolint:gosec`), Python's bandit `nosec`, JS/TS's
 * `eslint-disable` - means a human already reviewed this exact line and
 * judged it safe/intentional. Re-flagging it as a fresh finding would just
 * be telling a maintainer about something they already triaged. Confirmed
 * as a clean, unambiguous false-positive source on authelia/authelia: every
 * one of its 5 `InsecureSkipVerify: true` findings carried `//nolint:gosec`
 * with an explanation directly on the line ("Not used in production",
 * "solely to determine TLS socket information").
 *
 * Deliberately a substring/word match anywhere on the line, not a
 * line-prefix check like COMMENT_LINE_PATTERN - a suppression marker is
 * almost always a trailing comment after real code on the same line
 * (`InsecureSkipVerify: true, //nolint:gosec`), not the whole line.
 */
const SUPPRESSION_COMMENT_PATTERN = /\b(?:nolint|nosec|eslint-disable)\b/i;

function hasSuppressionComment(line: string): boolean {
  return SUPPRESSION_COMMENT_PATTERN.test(line);
}

/**
 * Python triple-quoted strings/docstrings ("""..."""/'''...''') aren't real
 * code - a parameter description or a multi-line example inside one can read
 * exactly like the calls this scanner looks for. Confirmed as a real false
 * positive on langchain-ai/langchain: a Google-style docstring's
 * "Args:\n    eval(Evaluation): An evaluation object." line matched the same
 * eval() rule as a genuine call, since it starts a fresh line with "eval("
 * just like real code would.
 *
 * A single pass per file, not real parsing: counts """ /''' occurrences per
 * line - an odd count flips "inside a docstring" for every line up to the
 * next odd-count line. A boundary line (the one carrying the marker that
 * flips the state) is conservatively treated as inside either way, since
 * real code sharing a line with an opening/closing marker is rare and this
 * scanner would rather under-scan a boundary line than flag docstring prose.
 * Known gap, same "close the biggest gap, not every gap" tradeoff as the
 * rest of this file: a self-contained single-line docstring
 * (`x = """eval(...) mentioned here"""`, an even marker count) isn't caught,
 * since it never flips the running state.
 */
function computeTripleQuoteLines(content: string): boolean[] {
  const lines = content.split('\n');
  const inside: boolean[] = new Array(lines.length).fill(false);
  let insideNow = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const markers = (line.match(/"""|'''/g) ?? []).length;
    const flips = markers % 2 === 1;
    inside[i] = insideNow || flips;
    if (flips) insideNow = !insideNow;
  }
  return inside;
}

/**
 * A call site's identifier is never immediately preceded by a definition
 * keyword - `def eval(self):` (Python), `async def eval(self):` - so this
 * distinguishes a method/function *definition* named eval/exec from a real
 * call to the builtin. Confirmed as a real false positive on three separate
 * repos analyzed in one session: huggingface/transformers'
 * `def eval(self): return self.train(False)` (a PyTorch train/eval-mode
 * toggle override), vllm-project/vllm's `def eval(self, node: ast.AST)` (an
 * AST visitor method), and unslothai/unsloth's own test suite - all matched
 * as if "eval(" were a call, when it's the def line itself.
 *
 * Deliberately checks the exact text before the match rather than adding
 * another lookbehind alternative to every rule's regex - keeps this one
 * general filter reusable across every language's rules in
 * EXECUTION_RULES_BY_LANGUAGE, including ones added later, rather than
 * needing the same fix repeated in each language's pattern by hand.
 */
function isDefinitionLine(line: string, matchIndex: number): boolean {
  const before = line.slice(0, matchIndex).trim();
  return /(?:^|\s)(?:async\s+)?def$/.test(before);
}

// ─── Hardcoded secrets ──────────────────────────────────────────────────────

export interface SecretRule {
  name: string;
  /** Must contain exactly one capturing group: the value to redact. */
  pattern: RegExp;
  severity: SecuritySeverity;
}

/** Exported so GitHistorySecretScanner.ts can apply the exact same rules to historical diff content, not a second, drifting copy. */
export const SECRET_RULES: SecretRule[] = [
  { name: 'AWS Access Key ID', pattern: /(AKIA[0-9A-Z]{16})/, severity: 'high' },
  { name: 'GitHub access token', pattern: /(gh[pousr]_[A-Za-z0-9]{36,})/, severity: 'high' },
  { name: 'Slack token', pattern: /(xox[baprs]-[0-9A-Za-z-]{10,72})/, severity: 'high' },
  { name: 'Google API key', pattern: /(AIza[0-9A-Za-z_\-]{35})/, severity: 'high' },
  { name: 'Stripe API key', pattern: /((?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,})/, severity: 'high' },
  { name: 'Twilio API key', pattern: /(SK[0-9a-fA-F]{32})/, severity: 'high' },
  { name: 'SendGrid API key', pattern: /(SG\.[A-Za-z0-9_\-.]{66})/, severity: 'high' },
  { name: 'npm access token', pattern: /(npm_[A-Za-z0-9]{36})/, severity: 'high' },
  {
    name: 'Private key block',
    pattern: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----)/,
    severity: 'high',
  },
  {
    name: 'JSON Web Token',
    pattern: /(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/,
    severity: 'medium',
  },
  {
    name: 'Database connection string with embedded credentials',
    pattern: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\/\s'"]+:[^@\/\s'"]+)@/,
    severity: 'high',
  },
  { name: 'Slack webhook URL', pattern: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+)/, severity: 'high' },
  { name: 'Discord bot token', pattern: /([MNO][A-Za-z\d_-]{23}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27})/, severity: 'high' },
  { name: 'Mailgun API key', pattern: /(key-[0-9a-f]{32})/, severity: 'high' },
  { name: 'Twilio Account SID', pattern: /(AC[0-9a-fA-F]{32})/, severity: 'medium' },
  { name: 'GitLab personal access token', pattern: /(glpat-[A-Za-z0-9_-]{20,})/, severity: 'high' },
  { name: 'Docker Hub personal access token', pattern: /(dckr_pat_[A-Za-z0-9_-]{27,})/, severity: 'high' },
  { name: 'Square access token', pattern: /(sq0atp-[0-9A-Za-z\-_]{22})/, severity: 'high' },
  { name: 'Shopify access token', pattern: /(shpat_[a-fA-F0-9]{32})/, severity: 'high' },
  { name: 'Telegram bot token', pattern: /(\d{8,10}:[A-Za-z0-9_-]{35})/, severity: 'medium' },
  { name: 'Braintree/PayPal access token', pattern: /(access_token\$production\$[0-9a-z]{16}\$[0-9a-f]{32})/, severity: 'high' },
  { name: 'Azure Storage account key', pattern: /AccountKey=([A-Za-z0-9+/]{86}==)/, severity: 'high' },
  {
    name: 'Hardcoded credential assignment',
    pattern:
      /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|encryption[_-]?key|signing[_-]?key|session[_-]?secret|jwt[_-]?secret|webhook[_-]?secret|password|passwd)\s*[:=]\s*['"]([A-Za-z0-9_\-/+=]{16,})['"]/i,
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
  /^(changeme|change[_-]?me|your[_-]?api[_-]?key|xxx+|placeholder|example|dummy|fake|test|test\d*|todo|secret|password\d*|admin\d*|guest|demo|sample|default|user|username|root|localhost|redacted|null|undefined)$/i;

function looksLikePlaceholder(value: string): boolean {
  if (PLACEHOLDER_VALUE_PATTERN.test(value)) return true;
  if (value.startsWith('<') && value.endsWith('>')) return true;
  if (value.startsWith('${') && value.endsWith('}')) return true;
  if (/^(.)\1{5,}$/.test(value)) return true; // "aaaaaaaa", "111111111"
  // Connection-string credentials ("user:pass") are one match with a colon
  // in the middle - a placeholder on either side (postgres://user:password@)
  // is exactly as harmless as a placeholder standing alone.
  if (value.includes(':')) {
    const [user, pass] = value.split(':');
    if (user !== undefined && pass !== undefined && (PLACEHOLDER_VALUE_PATTERN.test(user) || PLACEHOLDER_VALUE_PATTERN.test(pass))) return true;
  }
  return false;
}

/**
 * The complete per-line secret-detection decision, exported specifically so
 * GitHistorySecretScanner.ts can apply the exact same rules (env-reference
 * exclusion, comment/suppression skip, placeholder filtering, redaction) to
 * historical diff lines instead of carrying a second, driftable copy of this
 * logic. Returns null for a line with no match, or one that matched but was
 * filtered out (env reference, comment, placeholder value).
 */
export function matchSecretInLine(line: string): { rule: SecretRule; redactedLine: string } | null {
  if (ENV_REFERENCE_PATTERN.test(line)) return null;
  if (isCommentLine(line) || hasSuppressionComment(line)) return null;

  for (const rule of SECRET_RULES) {
    const match = rule.pattern.exec(line);
    if (!match) continue;
    const value = match[1] ?? match[0];
    if (looksLikePlaceholder(value)) continue;
    return { rule, redactedLine: redactMatch(line, match.index, value) };
  }
  return null;
}

function scanForSecrets(filePath: string, content: string, docstringLines: boolean[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (docstringLines[i]) continue;
    const line = lines[i] ?? '';
    const matched = matchSecretInLine(line);
    if (!matched) continue;

    findings.push({
      category: 'hardcoded-secret',
      severity: matched.rule.severity,
      filePath,
      line: i + 1,
      description: `Possible ${matched.rule.name} found in source - credentials should come from environment variables or a secrets manager, never be committed to the repository.`,
      lineText: matched.redactedLine,
    });
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

/** Shared across java/kotlin - both compile to the JVM and share the exact same Runtime/ProcessBuilder APIs. */
const JVM_PROCESS_RULES: ExecutionRule[] = [
  {
    pattern: /\bRuntime\.getRuntime\s*\(\s*\)\.exec\s*\(/,
    severity: 'medium',
    description: 'Runtime.exec() launches an external process - a command string built from untrusted input allows arbitrary command execution.',
  },
  {
    // No `new` keyword required - Kotlin constructor calls never use one, only Java's do.
    pattern: /\b(?:new\s+)?ProcessBuilder\s*\(/,
    severity: 'medium',
    description: 'ProcessBuilder launches an external process - arguments built from untrusted input allow arbitrary command execution.',
  },
];

const EXECUTION_RULES_BY_LANGUAGE: Partial<Record<SupportedLanguage, ExecutionRule[]>> = {
  python: [
    {
      // `(?<!\.)` excludes a method call on some other object - pandas'
      // `df.eval("expr")` is a real, common, unrelated API that a bare
      // `\beval\s*\(` regex can't tell apart from Python's builtin eval(),
      // since `\b` matches the same way whether the preceding character is
      // a `.` or whitespace/line-start.
      pattern: /(?<!\.)\beval\s*\(/,
      severity: 'medium',
      description: 'eval() executes a string as code - a common injection vector if any part of the input can be influenced externally.',
    },
    {
      // Same reasoning as eval() above - confirmed as a real false positive
      // on tiangolo/fastapi's own tutorial code, where SQLModel/SQLAlchemy's
      // `session.exec(select(...))` (a database query call, not code
      // execution) was being flagged identically to Python's builtin exec().
      pattern: /(?<!\.)\bexec\s*\(/,
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
    {
      pattern: /\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?SafeLoader)/,
      severity: 'medium',
      description: 'yaml.load() without Loader=SafeLoader can construct arbitrary Python objects from the input, including ones with code-execution side effects - use yaml.safe_load() or an explicit SafeLoader instead.',
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
    {
      // `(?!...)` excludes calls that already pass the documented safe
      // form - `['allowed_classes' => false]` (or an empty array) disables
      // object unserialization entirely, which is what actually makes this
      // exploitable (the object-injection attack needs a real object with
      // a malicious __wakeup/__destruct, not a plain scalar/array). Same
      // shape as the yaml.load()-without-SafeLoader exclusion below.
      // Confirmed as a real false positive on laravel/framework's own core:
      // `unserialize($recaller, ['allowed_classes' => false])` in
      // Auth/Recaller.php was flagged identically to every unprotected call.
      pattern: /\bunserialize\s*\((?![^)]*['"]allowed_classes['"]\s*=>\s*(?:false|\[\]))/i,
      severity: 'medium',
      description: 'unserialize() on untrusted input is a well-known PHP object-injection / remote-code-execution vector - prefer json_decode() for data that doesn\'t need PHP object types.',
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
    {
      pattern: /\bMarshal\.load\s*\(/,
      severity: 'medium',
      description: 'Marshal.load() on untrusted input can instantiate arbitrary objects, a known remote-code-execution vector - do not use it to deserialize external data.',
    },
  ],
  lua: [
    {
      pattern: /\b(?:loadstring|load)\s*\(/,
      severity: 'medium',
      description: 'loadstring()/load() compiles a string into executable code - a common injection vector if any part of the input can be influenced externally.',
    },
  ],
  java: JVM_PROCESS_RULES,
  kotlin: JVM_PROCESS_RULES,
  go: [
    {
      pattern: /\bexec\.Command\s*\(/,
      severity: 'medium',
      description: 'exec.Command() launches an external process - a command or argument built from untrusted input allows arbitrary command execution.',
    },
    {
      pattern: /\bsyscall\.Exec\s*\(/,
      severity: 'medium',
      description: 'syscall.Exec() replaces the current process image with a new program - untrusted input in the path or arguments allows arbitrary command execution.',
    },
  ],
  csharp: [
    {
      pattern: /\bProcess\.Start\s*\(/,
      severity: 'medium',
      description: 'Process.Start() launches an external process - arguments built from untrusted input allow arbitrary command execution.',
    },
  ],
  shell: [
    {
      pattern: /\beval\s+["$]/,
      severity: 'high',
      description: 'eval on a variable or interpolated string re-parses it as a shell command - a classic shell-injection vector if any part of it is externally influenced.',
    },
  ],
  powershell: [
    {
      pattern: /\b(?:Invoke-Expression|IEX)\b/i,
      severity: 'high',
      description: 'Invoke-Expression (IEX) executes a string as PowerShell code - a common injection vector, and the signature technique behind most "curl | IEX" style attacks.',
    },
  ],
  perl: [
    {
      pattern: /\beval\s*[{("]/,
      severity: 'medium',
      description: 'eval executes a string or block as Perl code - a common injection vector if any part of it can be influenced externally.',
    },
    {
      pattern: /\bsystem\s*\(/,
      severity: 'high',
      description: 'system() runs a command via the shell - unsanitized input allows arbitrary command execution.',
    },
  ],
  dockerfile: [
    {
      pattern: /\bRUN\b.*\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
      severity: 'high',
      description: 'Piping a downloaded script directly into a shell during the image build gives that remote server full control over the build with no integrity check - download, checksum-verify, then execute instead.',
    },
  ],
  terraform: [
    {
      pattern: /provisioner\s+"local-exec"/,
      severity: 'medium',
      description: 'local-exec runs an arbitrary shell command during provisioning - worth confirming its command isn\'t built from untrusted input (a variable, a data source response, etc.).',
    },
  ],
};

function scanForDynamicExecution(filePath: string, language: SupportedLanguage, content: string, docstringLines: boolean[]): SecurityFinding[] {
  const rules = EXECUTION_RULES_BY_LANGUAGE[language];
  if (!rules) return [];

  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (docstringLines[i]) continue;
    const line = lines[i] ?? '';
    if (isCommentLine(line) || hasSuppressionComment(line)) continue;
    for (const rule of rules) {
      const match = rule.pattern.exec(line);
      if (!match || isDefinitionLine(line, match.index)) continue;
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
    if (isCommentLine(line) || hasSuppressionComment(line)) continue;
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

// ─── Insecure transport (disabled TLS/certificate verification) ───────────

/**
 * Language-agnostic, same reasoning as the secrets scan: disabling
 * certificate verification is one of a handful of fixed, well-known idioms
 * per ecosystem, and every one of them is worth a look regardless of what
 * file it's in. Unlike the secrets scan there's no placeholder-filtering
 * needed - there's no legitimate "example" value for "skip TLS verification",
 * only a real setting that is either present or not.
 */
const INSECURE_TRANSPORT_RULES: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\bverify\s*=\s*False\b/,
    description: 'Disables TLS certificate verification (requests-style verify=False) - the connection is no longer protected against man-in-the-middle interception.',
  },
  {
    pattern: /\brejectUnauthorized\s*:\s*false\b/,
    description: 'Disables TLS certificate verification (Node https/tls rejectUnauthorized: false) - the connection is no longer protected against man-in-the-middle interception.',
  },
  {
    pattern: /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
    description: 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification process-wide - the connection is no longer protected against man-in-the-middle interception.',
  },
  {
    pattern: /\bInsecureSkipVerify\s*:\s*true\b/,
    description: 'InsecureSkipVerify: true disables TLS certificate verification (Go crypto/tls) - the connection is no longer protected against man-in-the-middle interception.',
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n]*\s(?:-k\b|--insecure\b|--no-check-certificate\b)/,
    description: 'Disables TLS certificate verification for this request - the connection is no longer protected against man-in-the-middle interception.',
  },
];

function scanForInsecureTransport(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentLine(line) || hasSuppressionComment(line)) continue;
    for (const rule of INSECURE_TRANSPORT_RULES) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        category: 'insecure-transport',
        severity: 'high',
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

// ─── Weak cryptography ─────────────────────────────────────────────────────

/**
 * MD5/SHA1 are flagged at 'low' rather than 'medium'/'high' - both are
 * completely legitimate for non-security uses (checksums, cache keys,
 * dedup, ETags), and this pass has no way to tell that use apart from a
 * security one via text alone. A quiet, low-severity nudge is honest about
 * that uncertainty; flagging every md5() call as a real problem would not be.
 */
const WEAK_CRYPTO_RULES: Array<{ pattern: RegExp; severity: SecuritySeverity; description: string }> = [
  {
    pattern: /\bhashlib\.md5\s*\(|\bMessageDigest\.getInstance\s*\(\s*['"]MD5['"]|\bcrypto\.createHash\s*\(\s*['"]md5['"]/i,
    severity: 'low',
    description: 'MD5 is cryptographically broken. Fine for a non-security checksum, but if this hashes a password, token, or anything an attacker could try to forge or reverse, use bcrypt/argon2/scrypt (passwords) or SHA-256+ (integrity) instead.',
  },
  {
    pattern: /\bhashlib\.sha1\s*\(|\bMessageDigest\.getInstance\s*\(\s*['"]SHA-?1['"]|\bcrypto\.createHash\s*\(\s*['"]sha1['"]/i,
    severity: 'low',
    description: 'SHA-1 is cryptographically broken for collision resistance. Fine for a non-security checksum, but not for password hashing or anything where forgeability matters.',
  },
  {
    pattern: /\bCipher\.getInstance\s*\(\s*['"]DES|\bCipher\.getInstance\s*\(\s*['"]RC4|\bcrypto\.createCipher\s*\(\s*['"]des|\bcrypto\.createCipher\s*\(\s*['"]rc4/i,
    severity: 'medium',
    description: 'DES and RC4 are both broken ciphers with known practical attacks - use AES-GCM (or another modern authenticated cipher) instead.',
  },
  {
    pattern: /\bMath\.random\s*\(\s*\)[^\n]{0,40}\b(?:token|password|secret|session|otp|nonce)\b|\b(?:token|password|secret|session|otp|nonce)\b[^\n]{0,40}\bMath\.random\s*\(\s*\)/i,
    severity: 'medium',
    description: 'Math.random() is not cryptographically secure and is predictable - use crypto.randomBytes()/crypto.getRandomValues() for anything security-sensitive like a token, session ID, or one-time code.',
  },
];

function scanForWeakCryptography(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentLine(line) || hasSuppressionComment(line)) continue;
    for (const rule of WEAK_CRYPTO_RULES) {
      if (!rule.pattern.test(line)) continue;
      findings.push({
        category: 'weak-cryptography',
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

// ─── SQL built via string-building instead of parameters ──────────────────

/**
 * Four fixes here, all confirmed as real false positives running this
 * against real repos (torvalds/linux, kubernetes, elasticsearch):
 *
 * 1. SELECT/UPDATE require their defining clause (FROM/SET respectively) to
 *    also appear in the string, the same way INSERT/DELETE already require
 *    INTO/FROM as part of the keyword itself. Without this, bare
 *    `\bSELECT\b`/`\bUPDATE\b` match the common English verbs
 *    "select"/"update" case-insensitively in any log message, comment, or
 *    UI string - confirmed on a Linux `panic("...select machvec...")` call.
 * 2. The opening and closing quote in each pattern have to be the SAME
 *    quote character (via a backreference), not just "a quote, then later,
 *    any quote." The old `['"]...['"]` let the "closing" match land on an
 *    unrelated quote elsewhere in the line - what happened on the Linux
 *    panic() call: opened on the outer `"`, then matched the `'` used for
 *    display purposes around `%s` as if it were the string's real closer.
 * 3. FROM/SET require whitespace on both sides, not just a `\b` word
 *    boundary - `\bSET\b` alone still matches inside hyphenated compounds
 *    like "set-once" (a hyphen is a non-word character, so it satisfies
 *    `\b` too). Confirmed on kubernetes: a doc comment listing
 *    "+k8s:update=NoSet for set-once fields" got flagged as SQL, since it
 *    contains both "update" and "set-once" with a `+` elsewhere on the line.
 * 4. The string-concatenation pattern no longer matches when the `+` is
 *    immediately followed by another string literal rather than a variable
 *    - concatenating two compile-time string constants can never introduce
 *    injectable data, no matter how SQL-shaped the text looks. Confirmed on
 *    elasticsearch: `"SELECT ... = ? " + "ORDER BY id"` (both sides fixed
 *    text, already parameterized via `?`) was flagged as risky concatenation.
 * 5. SET now additionally requires an assignment shape right after it
 *    (`SET <identifier> =`), not just the bare word - fix #3 above stopped
 *    "set-once" but not "set" used as an ordinary standalone English verb,
 *    which is whitespace-bounded exactly like real SQL SET is. Confirmed on
 *    kubernetes, one line below the fix #3 case: "...fields that must be
 *    set at creation or never..." (real UPDATE ... SET is always followed
 *    by `column = value`; English "set" is followed by a preposition, not
 *    an `=`, which is a genuine, reliable distinguishing signal).
 */
const SQL_INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /`[^`]*\b(?:SELECT(?=[^`]*(?<=\s)FROM(?=\s))|INSERT\s+INTO|UPDATE(?=[^`]*(?<=\s)SET\s+\w+\s*=)|DELETE\s+FROM)\b[^`]*\$\{[^}]+\}[^`]*`/i,
    description: 'SQL query built with a template literal that interpolates a variable directly - use a parameterized query/prepared statement instead of string interpolation.',
  },
  {
    pattern: /f(['"])[^'"]*\b(?:SELECT(?=[^'"]*(?<=\s)FROM(?=\s))|INSERT\s+INTO|UPDATE(?=[^'"]*(?<=\s)SET\s+\w+\s*=)|DELETE\s+FROM)\b[^'"]*\{[^}]+\}[^'"]*\1/i,
    description: 'SQL query built with an f-string that interpolates a variable directly - use a parameterized query instead of string interpolation.',
  },
  {
    pattern: /(['"])[^'"]*\b(?:SELECT(?=[^'"]*(?<=\s)FROM(?=\s))|INSERT\s+INTO|UPDATE(?=[^'"]*(?<=\s)SET\s+\w+\s*=)|DELETE\s+FROM)\b[^'"]*\1\s*\+(?!\s*['"])/i,
    description: 'SQL query built via string concatenation - use a parameterized query/prepared statement instead of concatenating values into the query text.',
  },
  {
    pattern: /(['"])[^'"]*\b(?:SELECT(?=[^'"]*(?<=\s)FROM(?=\s))|INSERT\s+INTO|UPDATE(?=[^'"]*(?<=\s)SET\s+\w+\s*=)|DELETE\s+FROM)\b[^'"]*\1\s*%\s*\S/i,
    description: 'SQL query built via %-style string formatting - use a parameterized query instead of formatting values into the query text.',
  },
];

// A tagged template literal whose tag identifier itself ends in "sql" - `sql`,
// `Prisma.sql`, `safeSql`, `sqltag`, etc. - is not string-built SQL at all:
// these tags exist specifically so `${}` interpolations get converted into
// parameterized query arguments at runtime, the exact opposite of the
// concatenation risk this pattern looks for. Confirmed as real false
// positives analyzing supabase/supabase (`safeSql\`...\``) and
// hoppscotch/hoppscotch (`Prisma.sql\`...\``) - both interpolate identifiers
// into what reads like raw SQL, but through a tag designed to make that safe.
function precededBySafeSqlTag(line: string, matchIndex: number): boolean {
  const before = line.slice(0, matchIndex);
  const identifier = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
  return identifier !== null && /sql$/i.test(identifier[1]!);
}

function scanForSqlInjectionRisk(filePath: string, content: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (isCommentLine(line) || hasSuppressionComment(line)) continue;
    for (const { pattern, description } of SQL_INJECTION_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      if (line[match.index] === '`' && precededBySafeSqlTag(line, match.index)) continue;
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
    // Test/fixture files legitimately embed "bad" values on purpose - fake
    // private keys, dummy secrets, sample malformed input - specifically to
    // verify parsing/handling logic works. Confirmed as the majority source
    // of hardcoded-secret false positives on authelia/authelia (an actual
    // security-focused project's own config-parser test suite, full of
    // intentionally-fake certificates named things like
    // x509PrivateKeyRSAExpired). Skipped for every category, not just
    // secrets - the same "this is deliberately here to test detection, not
    // a real risk" reasoning applies across all of them.
    if (isTestFile(file.filePath)) continue;

    const docstringLines = computeTripleQuoteLines(content);

    findings.push(
      ...scanForSecrets(file.filePath, content, docstringLines),
      ...scanForDynamicExecution(file.filePath, file.language, content, docstringLines),
      ...scanForChildProcessInjectionRisk(file.filePath, file.language, content),
      ...scanForInsecureTransport(file.filePath, content),
      ...scanForWeakCryptography(file.filePath, content),
      ...(isMigrationFile(file.filePath) ? [] : scanForSqlInjectionRisk(file.filePath, content)),
      ...(file.language === 'yaml' ? scanYamlInfraConfig(file.filePath, content) : []),
      ...(file.language === 'terraform' ? scanTerraformInfraConfig(file.filePath, content) : []),
      ...(file.language === 'dockerfile' ? scanDockerfileInfraConfig(file.filePath, content) : []),
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
