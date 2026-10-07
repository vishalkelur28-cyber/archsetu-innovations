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

/** Same minimal-stub pattern as securityRiskAnalyzer.test.ts - only filePath/language are read off FileAnalysis. */
function fa(filePath: string, language: SupportedLanguage): FileAnalysis {
  return { filePath, language, functions: [], classes: [], imports: [], exports: [], lineCount: 0, complexity: 0, explanation: '' };
}

function contentMap(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function findingsFor(language: SupportedLanguage, filePath: string, content: string) {
  return analyzeSecurityRisk([fa(filePath, language)], contentMap({ [filePath]: content })).findings;
}

describe('analyzeSecurityRisk - expanded coverage', () => {
  describe('hardcoded secrets - new vendor patterns', () => {
    it('flags a Google API key', () => {
      const findings = findingsFor('javascript', '/repo/config.js', `const key = "${secret('AIzaSy', 'DaGmWKa4JsXZ-HjGw7ISLan_MEwzHgVqQ')}";`);
      expect(findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'high')).toBe(true);
    });

    it('flags a Stripe live secret key', () => {
      const findings = findingsFor('javascript', '/repo/config.js', `const key = "${secret('sk_live_', '51H9abcdEFGHijklMNOPqrst')}";`);
      expect(findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'high')).toBe(true);
    });

    it('flags a JWT', () => {
      const jwt = secret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'dQw4w9WgXcQ_abc123DEF456');
      const findings = findingsFor('javascript', '/repo/config.js', `const token = "${jwt}";`);
      expect(findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'medium')).toBe(true);
    });

    it('flags a database connection string with real embedded credentials', () => {
      const findings = findingsFor('javascript', '/repo/db.js', `const url = "${secret('postgres://produser:', 'S3cr3tP4ssw0rd!@prod-db.example.com:5432/app')}";`);
      expect(findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'high')).toBe(true);
    });

    it('does not flag a placeholder connection string in docs', () => {
      const findings = findingsFor('javascript', '/repo/README.md', `DATABASE_URL=postgres://user:password@localhost:5432/mydb`);
      expect(findings).toHaveLength(0);
    });

    it('flags a long hardcoded password assignment', () => {
      const findings = findingsFor('python', '/repo/settings.py', `DB_PASSWORD = "aVeryReal-Secure-Passw0rd-value"`);
      expect(findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'medium')).toBe(true);
    });

    it('does not flag a short test-fixture password', () => {
      const findings = findingsFor('python', '/repo/tests/fixtures.py', `password = "test1234"`);
      expect(findings).toHaveLength(0);
    });
  });

  describe('dynamic code execution - expanded language coverage', () => {
    it('flags Java Runtime.exec()', () => {
      const findings = findingsFor('java', '/repo/Main.java', `Runtime.getRuntime().exec(userInput);`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('flags Kotlin ProcessBuilder', () => {
      const findings = findingsFor('kotlin', '/repo/Main.kt', `val proc = ProcessBuilder(cmd).start()`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('flags Go exec.Command()', () => {
      const findings = findingsFor('go', '/repo/main.go', `out, err := exec.Command("sh", "-c", userInput).Output()`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('flags C# Process.Start()', () => {
      const findings = findingsFor('csharp', '/repo/Program.cs', `Process.Start(userSuppliedPath);`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('flags PowerShell Invoke-Expression as high severity', () => {
      const findings = findingsFor('powershell', '/repo/script.ps1', `Invoke-Expression $userInput`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution' && f.severity === 'high')).toBe(true);
    });

    it('flags shell eval on a variable as high severity', () => {
      const findings = findingsFor('shell', '/repo/deploy.sh', `eval "$USER_CMD"`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution' && f.severity === 'high')).toBe(true);
    });

    it('flags a Dockerfile curl-pipe-bash pattern as high severity', () => {
      const findings = findingsFor('dockerfile', '/repo/Dockerfile', `RUN curl -sSL https://get.example.com/install.sh | bash`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution' && f.severity === 'high')).toBe(true);
    });

    it('flags a Terraform local-exec provisioner', () => {
      const findings = findingsFor('terraform', '/repo/main.tf', `provisioner "local-exec" {`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('flags Python yaml.load() without SafeLoader', () => {
      const findings = findingsFor('python', '/repo/parse.py', `config = yaml.load(userSuppliedYaml)`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('does not flag yaml.load() with an explicit SafeLoader', () => {
      const findings = findingsFor('python', '/repo/parse.py', `config = yaml.load(data, Loader=yaml.SafeLoader)`);
      expect(findings.filter((f) => f.description.includes('SafeLoader'))).toHaveLength(0);
    });

    it('flags PHP unserialize()', () => {
      const findings = findingsFor('php', '/repo/index.php', `$obj = unserialize($_COOKIE['data']);`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('flags Ruby Marshal.load()', () => {
      const findings = findingsFor('ruby', '/repo/app.rb', `obj = Marshal.load(user_input)`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('does not flag any language outside the rule table', () => {
      const findings = findingsFor('haskell', '/repo/Main.hs', `main = exec someCommand`);
      expect(findings.filter((f) => f.category === 'dynamic-code-execution')).toHaveLength(0);
    });
  });

  describe('insecure transport', () => {
    it('flags Python requests verify=False', () => {
      const findings = findingsFor('python', '/repo/client.py', `requests.get(url, verify=False)`);
      expect(findings.some((f) => f.category === 'insecure-transport' && f.severity === 'high')).toBe(true);
    });

    it('flags Node rejectUnauthorized: false', () => {
      const findings = findingsFor('javascript', '/repo/client.js', `https.request({ rejectUnauthorized: false })`);
      expect(findings.some((f) => f.category === 'insecure-transport')).toBe(true);
    });

    it('flags Go InsecureSkipVerify: true', () => {
      const findings = findingsFor('go', '/repo/client.go', `tls.Config{InsecureSkipVerify: true}`);
      expect(findings.some((f) => f.category === 'insecure-transport')).toBe(true);
    });

    it('flags curl --insecure', () => {
      const findings = findingsFor('shell', '/repo/fetch.sh', `curl --insecure https://internal.example.com/api`);
      expect(findings.some((f) => f.category === 'insecure-transport')).toBe(true);
    });
  });

  describe('weak cryptography', () => {
    it('flags MD5 at low severity', () => {
      const findings = findingsFor('python', '/repo/hash.py', `digest = hashlib.md5(data).hexdigest()`);
      expect(findings.some((f) => f.category === 'weak-cryptography' && f.severity === 'low')).toBe(true);
    });

    it('flags SHA-1 at low severity', () => {
      const findings = findingsFor('python', '/repo/hash.py', `digest = hashlib.sha1(data).hexdigest()`);
      expect(findings.some((f) => f.category === 'weak-cryptography' && f.severity === 'low')).toBe(true);
    });

    it('flags DES cipher usage at medium severity', () => {
      const findings = findingsFor('java', '/repo/Crypto.java', `Cipher.getInstance("DES/ECB/PKCS5Padding")`);
      expect(findings.some((f) => f.category === 'weak-cryptography' && f.severity === 'medium')).toBe(true);
    });

    it('flags Math.random() used to build a token', () => {
      const findings = findingsFor('javascript', '/repo/auth.js', `const token = Math.random().toString(36);`);
      expect(findings.some((f) => f.category === 'weak-cryptography' && f.severity === 'medium')).toBe(true);
    });

    it('does not flag Math.random() in an unrelated, non-security context', () => {
      const findings = findingsFor('javascript', '/repo/animate.js', `const jitter = Math.random() * 10;`);
      expect(findings.filter((f) => f.category === 'weak-cryptography')).toHaveLength(0);
    });
  });

  describe('comment lines are skipped (regression: authelia/authelia)', () => {
    it('does not flag a hardcoded-secret example shown in a YAML comment', () => {
      const findings = findingsFor('yaml', '/repo/config.template.yml', `# secret_key: 'a-real-looking-example-value-here'`);
      expect(findings.filter((f) => f.category === 'hardcoded-secret')).toHaveLength(0);
    });

    it('does not flag a commented-out eval() example', () => {
      const findings = findingsFor('javascript', '/repo/notes.js', `// eval(userInput) - do NOT do this`);
      expect(findings.filter((f) => f.category === 'dynamic-code-execution')).toHaveLength(0);
    });

    it('does not flag insecure-transport inside a comment', () => {
      const findings = findingsFor('python', '/repo/notes.py', `# requests.get(url, verify=False)  <- never do this`);
      expect(findings.filter((f) => f.category === 'insecure-transport')).toHaveLength(0);
    });

    it('still flags the same line once uncommented', () => {
      const findings = findingsFor('python', '/repo/client.py', `requests.get(url, verify=False)`);
      expect(findings.some((f) => f.category === 'insecure-transport')).toBe(true);
    });

    it('does not mistake a PEM private-key header for a "--" comment', () => {
      const findings = findingsFor('unknown', '/repo/id_rsa.txt', `${secret('-----BEGIN RSA ', 'PRIVATE KEY-----')}\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`);
      expect(findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'high')).toBe(true);
    });
  });

  describe('lines with an explicit lint-suppression comment are skipped (regression: authelia/authelia)', () => {
    it('does not flag InsecureSkipVerify with a trailing //nolint:gosec comment', () => {
      const findings = findingsFor('go', '/repo/internal/debug.go', `InsecureSkipVerify: true, //nolint:gosec // Not used in production.`);
      expect(findings.filter((f) => f.category === 'insecure-transport')).toHaveLength(0);
    });

    it('does not flag a hardcoded secret on a line with # nosec', () => {
      const findings = findingsFor('python', '/repo/settings.py', `password = "aVeryReal-Secure-Passw0rd-value"  # nosec`);
      expect(findings.filter((f) => f.category === 'hardcoded-secret')).toHaveLength(0);
    });

    it('does not flag eval() on a line with // eslint-disable-next-line', () => {
      const findings = findingsFor('javascript', '/repo/parse.js', `eval(userInput) // eslint-disable-line no-eval`);
      expect(findings.filter((f) => f.category === 'dynamic-code-execution')).toHaveLength(0);
    });

    it('still flags the same InsecureSkipVerify line with no suppression comment', () => {
      const findings = findingsFor('go', '/repo/internal/debug.go', `InsecureSkipVerify: true,`);
      expect(findings.some((f) => f.category === 'insecure-transport')).toBe(true);
    });
  });

  describe('compound migration/test directory names (regression: go-gitea/gitea)', () => {
    it('does not flag string-built SQL in a "modelmigration" directory (compound name, not an exact "/migration/" segment)', () => {
      const findings = findingsFor('go', '/repo/modelmigration/v1_15/v182.go', `sess.Exec("INSERT INTO issue_index (group_id, max_index) " + rest)`);
      expect(findings.filter((f) => f.category === 'sql-injection-risk')).toHaveLength(0);
    });

    it('does not flag a hardcoded secret inside a "unittest" directory (singular, distinct from /test/ and /tests/)', () => {
      const findings = findingsFor('go', '/repo/models/unittest/fixtures_loader.go', `secretKey := "abcdefghijklmnopqrstuvwxyz123456"`);
      expect(findings).toHaveLength(0);
    });

    it('still flags string-built SQL in an unrelated file that merely contains "migration" in its own filename', () => {
      const findings = findingsFor('javascript', '/repo/src/userMigrationHelper.js', `db.query("SELECT * FROM " + table)`);
      expect(findings.some((f) => f.category === 'sql-injection-risk')).toBe(true);
    });
  });

  describe('method-call name collisions with eval()/exec() (regression: tiangolo/fastapi)', () => {
    it('does not flag SQLModel/SQLAlchemy session.exec() as Python\'s builtin exec()', () => {
      const findings = findingsFor('python', '/repo/app/routes.py', `heroes = session.exec(select(Hero).offset(offset).limit(limit)).all()`);
      expect(findings.filter((f) => f.category === 'dynamic-code-execution')).toHaveLength(0);
    });

    it('does not flag pandas DataFrame.eval() as Python\'s builtin eval()', () => {
      const findings = findingsFor('python', '/repo/analysis.py', `result = df.eval("col1 + col2")`);
      expect(findings.filter((f) => f.category === 'dynamic-code-execution')).toHaveLength(0);
    });

    it('still flags a bare exec() call with no preceding object', () => {
      const findings = findingsFor('python', '/repo/app.py', `exec(user_input)`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });

    it('still flags a bare eval() call with no preceding object', () => {
      const findings = findingsFor('python', '/repo/app.py', `result = eval(user_input)`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });
  });

  describe('unserialize() with allowed_classes=false is safe (regression: laravel/framework)', () => {
    it('does not flag unserialize() with allowed_classes set to false', () => {
      const findings = findingsFor('php', '/repo/Auth/Recaller.php', `$this->recaller = @unserialize($recaller, ['allowed_classes' => false]) ?: $recaller;`);
      expect(findings.filter((f) => f.category === 'dynamic-code-execution')).toHaveLength(0);
    });

    it('does not flag unserialize() with allowed_classes set to an empty array', () => {
      const findings = findingsFor('php', '/repo/Cache/Store.php', `$value = unserialize($data, ["allowed_classes" => []]);`);
      expect(findings.filter((f) => f.category === 'dynamic-code-execution')).toHaveLength(0);
    });

    it('still flags a plain unserialize() call with no allowed_classes protection', () => {
      const findings = findingsFor('php', '/repo/Bus/Queueable.php', `$chain = unserialize($job);`);
      expect(findings.some((f) => f.category === 'dynamic-code-execution')).toBe(true);
    });
  });

  describe('documentation-example directory conventions (regression: tiangolo/fastapi)', () => {
    it('does not flag a secret inside docs_src/ (runnable tutorial example code)', () => {
      const findings = findingsFor('python', '/repo/docs_src/security/tutorial004.py', `SECRET_KEY = "09d25e094faa6ca2556c818166b7a9563b93f7099f6f0f4caa6cf63b88e8d3e7"`);
      expect(findings).toHaveLength(0);
    });

    it('still flags the same secret in a normal application file, not docs_src/', () => {
      const findings = findingsFor('python', '/repo/app/config.py', `SECRET_KEY = "09d25e094faa6ca2556c818166b7a9563b93f7099f6f0f4caa6cf63b88e8d3e7"`);
      expect(findings.some((f) => f.category === 'hardcoded-secret')).toBe(true);
    });
  });

  describe('test/fixture files are skipped entirely (regression: authelia/authelia)', () => {
    it('does not flag a fake certificate in a _test.go file', () => {
      const findings = findingsFor('go', '/repo/internal/configuration/types_test.go', `x509PrivateKeyRSAExpired = \`${secret('-----BEGIN RSA ', 'PRIVATE KEY-----')}\nfake\n-----END RSA PRIVATE KEY-----\``);
      expect(findings).toHaveLength(0);
    });

    it('does not flag a dummy secret in a test_resources/ config file', () => {
      const findings = findingsFor('yaml', '/repo/internal/configuration/test_resources/config.yml', `secret_key: 'abcdefghijklmnopqrstuvwxyz123456'`);
      expect(findings).toHaveLength(0);
    });

    it('does not flag a fixtures/ directory file', () => {
      const findings = findingsFor('javascript', '/repo/src/fixtures/sample.js', `const apiKey = "${secret('sk_live_', '1234567890abcdef1234567890')}";`);
      expect(findings).toHaveLength(0);
    });

    it('still flags the same secret in a normal (non-test) file', () => {
      const findings = findingsFor('yaml', '/repo/internal/configuration/config.yml', `secret_key: 'abcdefghijklmnopqrstuvwxyz123456'`);
      expect(findings.some((f) => f.category === 'hardcoded-secret')).toBe(true);
    });
  });
});
