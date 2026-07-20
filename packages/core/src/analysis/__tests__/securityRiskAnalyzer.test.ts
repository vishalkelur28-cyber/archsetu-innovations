import { describe, it, expect } from 'vitest';
import { analyzeSecurityRisk } from '../SecurityRiskAnalyzer.js';
import type { FileAnalysis, SupportedLanguage } from '../../types/parser.types.js';

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
        '/repo/config.js': `const awsKey = "AKIAABCDEFGHIJKLMNOP";`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.category).toBe('hardcoded-secret');
      expect(result.findings[0]?.severity).toBe('high');
      expect(result.findings[0]?.lineText).not.toContain('AKIAABCDEFGHIJKLMNOP');
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
        '/repo/id_rsa.txt': `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----`,
      });

      const result = analyzeSecurityRisk(files, contents);
      expect(result.findings.some((f) => f.category === 'hardcoded-secret' && f.severity === 'high')).toBe(true);
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
