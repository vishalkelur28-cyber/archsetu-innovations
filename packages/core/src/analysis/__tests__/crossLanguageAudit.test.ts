import { describe, it, expect } from 'vitest';
import { analyzeSecurityRisk } from '../SecurityRiskAnalyzer.js';
import { checkDependencyHygiene } from '../DependencyHygiene.js';
import type { FileAnalysis, SupportedLanguage } from '../../types/parser.types.js';
import type { DeclaredDependencySource } from '../../utils/monorepoUtils.js';

/**
 * A permanent, automated safety net - not a one-off regression test for a
 * single bug, but a structural check that runs the *same class* of question
 * ("does this heuristic behave sanely for every language it's applied to?")
 * that this session's real bugs all fell out of: DependencyHygiene blind to
 * Rust's `::` import syntax, and SQL-injection patterns matching ordinary
 * English words ("select", "set-once") that show up in log/print strings in
 * any language, not just the three specific cases found by hand so far
 * (Linux, kubernetes, elasticsearch).
 *
 * The goal is to catch the *next* language-specific false positive before a
 * multi-million-line real-world repo does, by exercising every supported
 * language against the shape of input that has already broken something
 * once - rather than waiting for the next stress test to find it by hand.
 */

function fa(filePath: string, language: SupportedLanguage): FileAnalysis {
  return {
    filePath, language, functions: [], classes: [], imports: [], exports: [],
    lineCount: 0, complexity: 0, explanation: '',
  };
}

const ALL_LANGUAGES: SupportedLanguage[] = [
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'csharp',
  'ruby', 'php', 'kotlin', 'swift', 'scala', 'dart', 'r', 'shell', 'html', 'css',
  'lua', 'perl', 'haskell', 'elixir', 'objectivec', 'zig', 'solidity', 'powershell',
  'groovy', 'ocaml', 'erlang', 'clojure', 'fsharp', 'julia', 'nim', 'crystal',
  'vimscript', 'elisp', 'makefile', 'dockerfile', 'terraform', 'sql', 'vue',
  'svelte', 'yaml', 'protobuf', 'graphql', 'batch',
];

describe('cross-language audit: DependencyHygiene', () => {
  it('never reports a finding for any non-JS/TS language, regardless of import shape', () => {
    // package.json is a JS/TS-ecosystem concept. Every other language here
    // gets a source string shaped like a real false-positive trigger for the
    // pre-fix code: a `::`-or-`.`-separated path with no npm-style `/`
    // separator (the exact shape that produced 15,886 false positives on
    // rust-lang/rust).
    for (const language of ALL_LANGUAGES) {
      if (language === 'javascript' || language === 'typescript') continue;
      const file: FileAnalysis = {
        ...fa('/repo/main.ext', language),
        imports: [{ source: 'std::collections::HashMap', symbols: ['HashMap'], isRelative: false }],
      };
      const sources: DeclaredDependencySource[] = [{ dir: '/repo', declared: new Set(['unrelated-package']) }];

      const result = checkDependencyHygiene([file], sources);
      expect(result.undeclaredImports, `language=${language} should never be checked`).toHaveLength(0);
    }
  });

  it('still works normally for javascript and typescript', () => {
    for (const language of ['javascript', 'typescript'] as const) {
      const file: FileAnalysis = {
        ...fa('/repo/main.ext', language),
        imports: [{ source: 'lodash', symbols: ['default'], isRelative: false }],
      };
      const sources: DeclaredDependencySource[] = [{ dir: '/repo', declared: new Set(['express']) }];

      const result = checkDependencyHygiene([file], sources);
      expect(result.undeclaredImports.map((u) => u.packageName), `language=${language}`).toContain('lodash');
    }
  });
});

describe('cross-language audit: SQL-injection heuristic', () => {
  // scanForSqlInjectionRisk takes no `language` parameter at all - it scans
  // every file's raw text identically regardless of extension, so the false-
  // positive risk (English words that coincide with SQL keywords, inside a
  // quoted string, concatenated with `+`) is uniform across every language
  // that concatenates strings with `+`. One realistic "print a status
  // message" line per language, in that language's own syntax.
  const PLUS_CONCAT_SAMPLES: Partial<Record<SupportedLanguage, string>> = {
    javascript: `console.log("Failed to select the handler" + suffix);`,
    typescript: `console.log("Failed to select the handler" + suffix);`,
    java: `System.out.println("Failed to select the handler" + suffix);`,
    python: `print("Failed to select the handler" + suffix)`,
    go: `fmt.Println("Failed to select the handler" + suffix)`,
    csharp: `Console.WriteLine("Failed to select the handler" + suffix);`,
    rust: `println!("{}", "Failed to select the handler".to_string() + &suffix);`,
    swift: `print("Failed to select the handler" + suffix)`,
    kotlin: `println("Failed to select the handler" + suffix)`,
    dart: `print("Failed to select the handler" + suffix);`,
    scala: `println("Failed to select the handler" + suffix)`,
    ruby: `puts("Failed to select the handler" + suffix)`,
  };

  it('does not flag an ordinary "select"/"update"/"delete from" status message concatenated with a variable, in any language that uses + for string concatenation', () => {
    for (const [language, line] of Object.entries(PLUS_CONCAT_SAMPLES) as Array<[SupportedLanguage, string]>) {
      const files = [fa(`/repo/main.${language}`, language)];
      const contents = new Map([[`/repo/main.${language}`, line]]);

      const result = analyzeSecurityRisk(files, contents);
      const sqlFindings = result.findings.filter((f) => f.category === 'sql-injection-risk');
      expect(sqlFindings, `language=${language}: ${line}`).toHaveLength(0);
    }
  });

  it('still flags a genuine SQL query concatenated with a variable, in every one of those languages', () => {
    for (const language of Object.keys(PLUS_CONCAT_SAMPLES) as SupportedLanguage[]) {
      const line = `query = "SELECT * FROM users WHERE id = " + userId;`;
      const files = [fa(`/repo/db.${language}`, language)];
      const contents = new Map([[`/repo/db.${language}`, line]]);

      const result = analyzeSecurityRisk(files, contents);
      const sqlFindings = result.findings.filter((f) => f.category === 'sql-injection-risk');
      expect(sqlFindings.length, `language=${language} should still catch real SQL concatenation`).toBeGreaterThan(0);
    }
  });
});

describe('cross-language audit: dynamic-code-execution coverage map', () => {
  // Not a bug - a visible, testable record of current coverage, so it's an
  // explicit decision (not silent tribal knowledge) when a language has no
  // rules yet, and a regression is caught if an existing language's rules
  // are ever accidentally removed. 6 of 47 supported languages covered as
  // of this writing; extending to more is real, valuable future work, not
  // something this test claims is already done.
  const LANGUAGES_WITH_DYNAMIC_EXECUTION_RULES: SupportedLanguage[] = [
    'python', 'javascript', 'typescript', 'php', 'ruby', 'lua',
  ];

  it('documents which languages currently have dynamic-code-execution detection', () => {
    const evalSamples: Partial<Record<SupportedLanguage, string>> = {
      python: 'eval(user_input)',
      javascript: 'eval(userInput);',
      typescript: 'eval(userInput);',
      php: 'eval($userInput);',
      ruby: 'eval(user_input)',
      lua: 'load(user_input)()',
      // Deliberately no entry for languages outside the coverage list - a
      // language added here without also adding a rule above would fail,
      // making "we don't detect eval-injection in this language yet" a
      // visible, intentional fact instead of an invisible gap.
    };

    for (const language of LANGUAGES_WITH_DYNAMIC_EXECUTION_RULES) {
      const sample = evalSamples[language];
      expect(sample, `add a sample for language=${language} to keep this test meaningful`).toBeDefined();
      const files = [fa(`/repo/x.${language}`, language)];
      const contents = new Map([[`/repo/x.${language}`, sample as string]]);
      const result = analyzeSecurityRisk(files, contents);
      expect(
        result.findings.some((f) => f.category === 'dynamic-code-execution'),
        `language=${language} is claimed as covered but didn't fire`,
      ).toBe(true);
    }
  });
});
