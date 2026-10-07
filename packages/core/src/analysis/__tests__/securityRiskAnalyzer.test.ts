import { describe, it, expect } from 'vitest';
import { analyzeSecurityRisk } from '../SecurityRiskAnalyzer.js';
import type { FileAnalysis, SupportedLanguage } from '../../types/parser.types.js';

/**
 * Assembles a credential-shaped fixture at test time.
 *
 * These values are fake, but they are realistic enough that GitHub push
 * protection, gitleaks and this engine's own SecurityRiskAnalyzer all
 * (correctly) match them. Written as literals they make the file
 * unpublishable to a public repository - the push is refused. Joining the
 * parts at runtime gives the detector under test exactly the string it would
 * see in a real repository, while the source on disk contains no
 * credential-shaped string at all.
 */
const secret = (...parts: string[]): string => parts.join('');

/**
 * analyzeSecurityRisk only reads `filePath`/`language` off each FileAnalysis
 * (everything else comes from the raw content map), so a minimal stub is
 * enough here - no need to run the real parser for these fixtures.
 */
function fa(filePath: string, language: SupportedLanguage): FileAnalysis {
  return {
    filePath,
    language,
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    lineCount: 0,
    complexity: 0,
    explanation: '',
  };
}

function contentMap(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe('analyzeSecurityRisk', () => {
  describe('hardcoded secrets', () => {
    it('flags an AWS access key and masks the value, keeping the surrounding line', () => {
      const files = [fa('/repo/config.js', 'javascript')];
      const contents = contentMap({
        '/repo/config.js': `const awsKey = "${secret('AKIA', 'ABCDEFGHIJKLMNOP')}";`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.category).toBe('hardcoded-secret');
      expect(result.findings[0]?.severity).toBe('high');
      expect(result.findings[0]?.lineText).not.toContain(secret('AKIA', 'ABCDEFGHIJKLMNOP'));
      expect(result.findings[0]?.lineText).toContain('const awsKey');
      expect(result.highCount).toBe(1);
    });

    it('does not flag a placeholder credential value', () => {
      const files = [fa('/repo/config.js', 'javascript')];
      const contents = contentMap({
        '/repo/config.js': `const apiKey = "changeme";`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag a value sourced from an environment variable', () => {
      const files = [fa('/repo/config.js', 'javascript')];
      const contents = contentMap({
        '/repo/config.js': `const apiKey = process.env.API_KEY || "fallback-not-a-real-secret-value";`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('flags a private key block', () => {
      const files = [fa('/repo/id_rsa.txt', 'unknown')];
      const contents = contentMap({
        '/repo/id_rsa.txt': `${secret('-----BEGIN RSA ', 'PRIVATE KEY-----')}\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'high')).toBe(true);
    });

    it.each([
      ['Slack webhook URL', '/repo/notify.js', `const url = "${secret('https://hooks.slack.com/', 'services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX')}";`],
      ['Discord bot token', '/repo/bot.js', `const token = "${secret('MTIzNDU2Nzg5MDEyMzQ1Njc4', '.GaBcDe.', 'AbCdEfGhIjKlMnOpQrStUvWxYzAbC1')}";`],
      ['Mailgun API key', '/repo/mail.js', `const key = "${secret('key-', '1234567890abcdef1234567890abcdef')}";`],
      ['Twilio Account SID', '/repo/sms.js', `const sid = "${secret('AC', '1234567890abcdef1234567890abcdef')}";`],
      ['GitLab personal access token', '/repo/ci.yml', `TOKEN: "${secret('glpat-', 'AbCdEfGhIjKlMnOpQrSt')}"`],
      ['Docker Hub personal access token', '/repo/deploy.sh', `docker login -u me -p ${secret('dckr_pat_', 'AbCdEfGhIjKlMnOpQrStUvWxYzA')}`],
      ['Square access token', '/repo/pay.js', `const token = "${secret('sq0atp-', 'AbCdEfGhIjKlMnOpQrStUv')}";`],
      ['Shopify access token', '/repo/shop.js', `const token = "${secret('shpat_', '1234567890abcdef1234567890abcdef')}";`],
      ['Telegram bot token', '/repo/bot.py', `TOKEN = "${secret('123456789:', 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhI')}"`],
      ['Braintree/PayPal access token', '/repo/pay.js', `const token = "${secret('access_token$production$', '1234567890abcdef$1234567890abcdef1234567890abcdef')}";`],
      ['Azure Storage account key', '/repo/config.js', `const conn = "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${secret('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==')};EndpointSuffix=core.windows.net";`],
    ])('flags a %s', (_name, filePath, line) => {
      const files = [fa(filePath, 'javascript')];
      const contents = contentMap({ [filePath]: line });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'hardcoded-secret')).toBe(true);
    });
  });

  describe('dynamic code execution', () => {
    it('flags Python os.system() as high severity', () => {
      const files = [fa('/repo/script.py', 'python')];
      const contents = contentMap({
        '/repo/script.py': `import os\ndef run(cmd):\n    os.system(cmd)`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.category).toBe('dynamic-code-execution');
      expect(result.findings[0]?.severity).toBe('high');
    });

    it('flags Python subprocess call with shell=True', () => {
      const files = [fa('/repo/script.py', 'python')];
      const contents = contentMap({
        '/repo/script.py': `subprocess.run(cmd, shell=True)`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.severity === 'high')).toBe(true);
    });

    it('does not flag JS RegExp.exec() as dangerous execution', () => {
      const files = [fa('/repo/parse.js', 'javascript')];
      const contents = contentMap({
        '/repo/parse.js': `function run(pattern, text) { return pattern.exec(text); }`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('flags eval() in JavaScript', () => {
      const files = [fa('/repo/util.js', 'javascript')];
      const contents = contentMap({
        '/repo/util.js': `function run(code) { return eval(code); }`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.severity).toBe('medium');
    });

    it('does not flag a Python method definition named eval() as a real call', () => {
      // Confirmed real false positive on huggingface/transformers -
      // `def eval(self): return self.train(False)` is a PyTorch train/eval
      // mode toggle override, not a call to the builtin.
      const files = [fa('/repo/modeling_utils.py', 'python')];
      const contents = contentMap({
        '/repo/modeling_utils.py': `class Model:\n    def eval(self):\n        return self.train(False)\n`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag a Python method definition named exec() as a real call', () => {
      // Confirmed real false positive on vllm-project/vllm -
      // `def eval(self, node: ast.AST) -> Any:` is an AST visitor method.
      const files = [fa('/repo/jit_warmup.py', 'python')];
      const contents = contentMap({
        '/repo/jit_warmup.py': `class Visitor:\n    def exec(self, node) -> Any:\n        pass\n`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('still flags a genuine eval() call even when a same-named method is defined elsewhere in the file', () => {
      const files = [fa('/repo/mixed.py', 'python')];
      const contents = contentMap({
        '/repo/mixed.py': `class Model:\n    def eval(self):\n        return self.train(False)\n\ndef run(cmd):\n    eval(cmd)\n`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.lineText).toBe('eval(cmd)');
    });

    it('does not flag eval()/exec() mentioned inside a Python docstring', () => {
      // Confirmed real false positive on langchain-ai/langchain - a
      // Google-style docstring's "Args:\n    eval(Evaluation): An evaluation
      // object." line matched the same rule as a real call.
      const files = [fa('/repo/feedback_transform.py', 'python')];
      const contents = contentMap({
        '/repo/feedback_transform.py':
          'class FeedbackQueryTransformation:\n    """\n    Transform the query.\n\n    Args:\n        eval(Evaluation): An evaluation object.\n        llm(LLM): An LLM.\n    """\n\n    def __init__(self):\n        pass\n',
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('still flags a real eval() call that comes right after a docstring closes', () => {
      const files = [fa('/repo/after_docstring.py', 'python')];
      const contents = contentMap({
        '/repo/after_docstring.py': 'def run(cmd):\n    """Run cmd."""\n    eval(cmd)\n',
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.lineText).toBe('eval(cmd)');
    });

    it('flags child_process.execSync with a concatenated command, when child_process is imported', () => {
      const files = [fa('/repo/deploy.js', 'javascript')];
      const contents = contentMap({
        '/repo/deploy.js': `const { execSync } = require('child_process');\nfunction run(branch) { execSync('git checkout ' + branch); }`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'dynamic-code-execution' && f.severity === 'high')).toBe(true);
    });

    it('does not flag child_process.execSync called with a fixed string literal', () => {
      const files = [fa('/repo/deploy.js', 'javascript')];
      const contents = contentMap({
        '/repo/deploy.js': `const { execSync } = require('child_process');\nfunction run() { execSync('git status'); }`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag execSync-shaped code when child_process was never imported', () => {
      const files = [fa('/repo/utils.js', 'javascript')];
      const contents = contentMap({
        '/repo/utils.js': `function execSync(input) { return input + userSuffix; }`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });
  });

  describe('SQL injection risk', () => {
    it('flags a SQL query built with a JS template literal interpolation', () => {
      const files = [fa('/repo/db.js', 'javascript')];
      const contents = contentMap({
        '/repo/db.js': 'function find(id) { return db.query(`SELECT * FROM users WHERE id = ${id}`); }',
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });

    it('flags a SQL query built with a Python f-string', () => {
      const files = [fa('/repo/db.py', 'python')];
      const contents = contentMap({
        '/repo/db.py': `def find(id):\n    query = f"SELECT * FROM users WHERE id = {id}"`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });

    it('flags a SQL query built via string concatenation', () => {
      const files = [fa('/repo/db.js', 'javascript')];
      const contents = contentMap({
        '/repo/db.js': `function find(id) { return db.query("SELECT * FROM users WHERE id = " + id); }`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });

    it('does not flag a parameterized query with a placeholder', () => {
      const files = [fa('/repo/db.js', 'javascript')];
      const contents = contentMap({
        '/repo/db.js': `function find(id) { return db.query("SELECT * FROM users WHERE id = ?", [id]); }`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('flags a real SQL query built via %-style string formatting', () => {
      const files = [fa('/repo/db.py', 'python')];
      const contents = contentMap({
        '/repo/db.py': `query = "SELECT * FROM users WHERE id = %s" % user_id`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });

    it('does not flag a kernel-style panic/log message that happens to contain the English word "select"', () => {
      // Confirmed as a real false positive analyzing torvalds/linux:
      // arch/sh/kernel/machvec.c's panic() call was flagged as SQL
      // injection. Two independent bugs, both fixed: (1) bare `\bSELECT\b`
      // matched the English verb "select", not just the SQL keyword, and
      // (2) the pattern's "closing quote" could land on the unrelated `'`
      // used for display around %s, rather than requiring it to match the
      // same quote character that opened the string.
      const files = [fa('/repo/machvec.c', 'c')];
      const contents = contentMap({
        '/repo/machvec.c': `panic("Failed to select machvec '%s' -- halting.\\n", name);`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag "update" used as an English word without a SET clause', () => {
      const files = [fa('/repo/log.js', 'javascript')];
      const contents = contentMap({
        '/repo/log.js': `console.log("Failed to update config '%s'" + suffix);`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag "set" appearing inside a hyphenated compound word like "set-once"', () => {
      // Confirmed as a real false positive analyzing kubernetes/kubernetes:
      // a doc comment listing "+k8s:update=NoSet for set-once fields, ..."
      // matched both UPDATE and (via the hyphen acting as a word boundary)
      // SET, plus a `+` elsewhere on the same line for string concatenation.
      const files = [fa('/repo/validators/update.go', 'go')];
      const contents = contentMap({
        '/repo/validators/update.go': `msg := "Examples: +k8s:update=NoModify +k8s:update=NoUnset for set-once fields, " +\n\t"+k8s:update=NoSet for fields that must be set at creation or never, "`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag concatenation of two static string literals with no variable', () => {
      // Confirmed as a real false positive analyzing elasticsearch: both
      // halves of the concatenation are fixed text (one already uses a `?`
      // placeholder) - there is no variable/expression that could ever
      // carry injectable data into this query.
      const files = [fa('/repo/Query.java', 'java')];
      const contents = contentMap({
        '/repo/Query.java': `String sql = "SELECT id, birth_date FROM emps WHERE birth_date::date = ? " + "ORDER BY id";`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('still flags concatenation of a real SQL string literal with a variable', () => {
      const files = [fa('/repo/Query.java', 'java')];
      const contents = contentMap({
        '/repo/Query.java': `String sql = "SELECT id FROM samples WHERE id > " + str(lowerId);`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });

    it('flags a real UPDATE ... SET query built via concatenation', () => {
      const files = [fa('/repo/db.js', 'javascript')];
      const contents = contentMap({
        '/repo/db.js': `db.query("UPDATE users SET name = " + name);`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });

    it('does not flag "set" used as an ordinary English verb, even whitespace-bounded, without an assignment after it', () => {
      // Confirmed as a real false positive one line below the "set-once" fix
      // above, analyzing kubernetes: "...fields that must be set at
      // creation or never..." - "set" here is whitespace-bounded exactly
      // like real SQL SET is, so the earlier hyphen-boundary fix alone
      // didn't catch it. Real SQL SET is always followed by `column =
      // value`; English "set" is followed by a preposition, not `=`.
      const files = [fa('/repo/validators/update.go', 'go')];
      const contents = contentMap({
        '/repo/validators/update.go': `msg := "+k8s:update=NoSet for fields that must be set at creation or never, " +\n\t"more text"`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag table-name interpolation inside a database migration file', () => {
      // Confirmed as a real false positive analyzing n8n-io/n8n: migration
      // files build DDL/DML by interpolating table/column names (e.g.
      // `INSERT INTO "${tablePrefix}tag_entity"`) - standard SQL has no way
      // to bind an identifier as a parameter, so this is simply how
      // migrations are written, not a sign of unparameterized user input.
      // Migration files accounted for the large majority of n8n's
      // sql-injection-risk findings, none reachable by request-time input.
      const files = [fa('/repo/src/migrations/1690000000002-AddColumn.ts', 'typescript')];
      const contents = contentMap({
        '/repo/src/migrations/1690000000002-AddColumn.ts': `await queryRunner.query(\`INSERT INTO "\${tablePrefix}tag_entity"("id", "name") SELECT "id", "name" FROM "\${tablePrefix}temporary_tag_entity"\`);`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('still flags SQL injection risk in a non-migration file with the same shape', () => {
      const files = [fa('/repo/src/services/tags.ts', 'typescript')];
      const contents = contentMap({
        '/repo/src/services/tags.ts': `await db.query(\`INSERT INTO "\${tablePrefix}tag_entity"("id") SELECT "id" FROM "\${tablePrefix}temp"\`);`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });

    it('does not flag interpolation inside a Prisma.sql tagged template', () => {
      // Confirmed as a real false positive analyzing hoppscotch/hoppscotch:
      // Prisma.sql is Prisma's own helper specifically so `${}` values
      // become parameterized query args instead of raw string content - it's
      // the *recommended safe* way to write raw SQL in Prisma, the opposite
      // of the anti-pattern this check looks for.
      const files = [fa('/repo/src/prisma.service.ts', 'typescript')];
      const contents = contentMap({
        '/repo/src/prisma.service.ts': `Prisma.sql\`SELECT "orderIndex" FROM "TeamCollection" WHERE "teamID" = \${teamId} FOR UPDATE\``,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('does not flag interpolation inside a custom safeSql tagged template', () => {
      // Confirmed as a real false positive analyzing supabase/supabase - any
      // identifier ending in "sql" used as a template tag (sql`...`,
      // safeSql`...`, sqltag`...`) is, by ecosystem convention, a tag that
      // parameterizes its interpolations rather than concatenating them.
      const files = [fa('/repo/src/logs.utils.ts', 'typescript')];
      const contents = contentMap({
        '/repo/src/logs.utils.ts': `return safeSql\`select id, timestamp from \${LOG_TABLE_SQL[table]}\`;`,
      });

      expect(analyzeSecurityRisk(files, contents).findings).toHaveLength(0);
    });

    it('still flags a plain (non-tagged) template literal building the same query shape', () => {
      const files = [fa('/repo/src/logs.ts', 'typescript')];
      const contents = contentMap({
        '/repo/src/logs.ts': `const query = \`select id, timestamp from \${LOG_TABLE_SQL[table]}\`;`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });
  });

  it('returns zero findings for a clean file', () => {
    const files = [fa('/repo/index.js', 'javascript')];
    const contents = contentMap({
      '/repo/index.js': `export function add(a, b) { return a + b; }`,
    });

    const result = analyzeSecurityRisk(files, contents);
    expect(result.findings).toHaveLength(0);
    expect(result.highCount).toBe(0);
    expect(result.mediumCount).toBe(0);
    expect(result.lowCount).toBe(0);
  });

  it('skips files with no matching content in the map', () => {
    const files = [fa('/repo/missing.js', 'javascript')];
    const result = analyzeSecurityRisk(files, contentMap({}));
    expect(result.findings).toHaveLength(0);
  });
});
