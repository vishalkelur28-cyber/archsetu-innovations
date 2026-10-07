#!/usr/bin/env node
/**
 * ArchSetu CLI
 *
 * Usage:
 *   archsetu analyze ./path/to/repo
 *   archsetu analyze --json ./path/to/repo
 *   archsetu health ./path/to/repo
 *   archsetu dead-code ./path/to/repo
 *   archsetu install-hook --min-score 60
 *   archsetu uninstall-hook
 */

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import {
  analyzeRepo,
  calculateHealthScore,
  findDeadCode,
  walkRepo,
  gzipJsonStringify,
  writeJsonToStdout,
} from '@archsetu/core';
import { checkDependencyVulnerabilities } from './osv.js';

// The exact hostname that actually serves 200s - archsetu.com (no www) is a
// 308 redirect to this at the Vercel domain level. Deliberately NOT using
// the apex here: Node's fetch has a confirmed, reproduced bug where it
// cannot resend a Buffer-typed request body when following a redirect (the
// underlying ArrayBuffer is already detached by the time the redirect retry
// tries to re-extract it), which surfaced as an opaque "fetch failed" with
// no useful top-level message - the real cause only showed up in err.cause.
// Pointing directly at the serving domain avoids the redirect (and this bug
// class) entirely, rather than working around fetch's redirect handling.
const DEFAULT_API_URL = 'https://www.archsetu.com';

/**
 * A plain `res.json()` throws an opaque "Unexpected token 'R', "Request
 * En"... is not valid JSON" when the response isn't actually JSON - which
 * happens for real when a hosting platform (Vercel) rejects an oversized
 * request with its own plain-text "Request Entity Too Large" page before
 * the request ever reaches ArchSetu's own code. Reading as text first and
 * only then parsing means a non-JSON response becomes a readable error
 * message instead of a confusing parser exception.
 */
async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const snippet = text.slice(0, 200).trim();
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status}): ${snippet || '(empty body)'}`);
  }
}

const program = new Command();

program
  .name('archsetu')
  .description('Engineering Intelligence Platform CLI')
  .version('0.1.0');

// ─── analyze ──────────────────────────────────────────────────────────────────
program
  .command('analyze [dir]')
  .description('Run full analysis on a local directory')
  .option('--json', 'Output as JSON')
  .action(async (dir: string | undefined, opts: { json?: boolean }) => {
    const rootDir = path.resolve(dir ?? '.');
    const spinner = opts.json ? null : ora(`Analyzing ${rootDir}...`).start();

    try {
      const result = await analyzeRepo(rootDir);

      spinner?.succeed(`Analysis complete in ${(result as { analyzedAt?: string }).analyzedAt ?? 'N/A'}`);

      if (opts.json) {
        await writeJsonToStdout(result);
        return;
      }

      // Pretty print
      const { health, totalFunctions, deadCode, entryPoints, totalFiles, totalLines, testRisk } = result;
      const scoreColor =
        health.score >= 80 ? chalk.green :
        health.score >= 60 ? chalk.yellow :
        health.score >= 40 ? chalk.hex('#f97316') :
        chalk.red;

      console.log('\n' + chalk.bold('──── ArchSetu Analysis ────'));
      console.log(`Health Score: ${scoreColor(health.score + '/100')} ${chalk.gray(`(${health.grade})`)}`);
      console.log(`Files:        ${totalFiles.toLocaleString()}`);
      console.log(`Functions:    ${totalFunctions.toLocaleString()}`);
      console.log(`Dead code:    ${deadCode.length.toLocaleString()} functions`);
      console.log(`Entry points: ${entryPoints.length}`);
      console.log(`Total lines:  ${totalLines.toLocaleString()}`);

      console.log('\n' + chalk.bold('── Health Breakdown ──'));
      const b = health.breakdown;
      const score = (n: number) => n >= 80 ? chalk.green(n) : n >= 60 ? chalk.yellow(n) : chalk.red(n);
      console.log(`Dead code:    ${score(Math.round(b.deadCodeRatio))}/100`);
      console.log(`Complexity:   ${score(Math.round(b.avgComplexity))}/100`);
      console.log(`Test file ratio:${score(Math.round(b.testCoverage))}/100`);

      if (deadCode.length > 0) {
        console.log('\n' + chalk.bold(`── Dead Code (${deadCode.length} functions) ──`));
        deadCode.slice(0, 10).forEach((d) => {
          const safe = d.isSafeToRemove ? chalk.green(' [safe to remove]') : '';
          const shortPath = d.function.filePath.split(/[/\\]/).slice(-2).join('/');
          console.log(`  ${chalk.dim(shortPath)}:${d.function.startLine} ${d.function.name}${safe}`);
        });
        if (deadCode.length > 10) {
          console.log(chalk.dim(`  ... and ${deadCode.length - 10} more`));
        }
      }

      if (testRisk.hotspots.length > 0) {
        console.log('\n' + chalk.bold(`── Test Risk Hotspots (${testRisk.hotspots.length}) ──`));
        console.log(chalk.dim('  Complex code with no static evidence any test in this repo exercises it:'));
        testRisk.hotspots.slice(0, 10).forEach((h) => {
          const shortPath = h.filePath.split(/[/\\]/).slice(-2).join('/');
          const churn = h.churnCount ? chalk.dim(` (${h.churnCount} commits)`) : '';
          console.log(`  ${chalk.dim(shortPath)}:${h.startLine} ${h.functionName} ${chalk.yellow(`complexity ${h.complexity}`)}${churn}`);
        });
        if (testRisk.hotspots.length > 10) {
          console.log(chalk.dim(`  ... and ${testRisk.hotspots.length - 10} more`));
        }
      }

      console.log('');
    } catch (err) {
      spinner?.fail('Analysis failed');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }
  });

// ─── health ───────────────────────────────────────────────────────────────────
program
  .command('health [dir]')
  .description('Print just the health score')
  .action(async (dir: string | undefined) => {
    const rootDir = path.resolve(dir ?? '.');
    const result = await analyzeRepo(rootDir);
    console.log(`${result.health.score} ${result.health.grade}`);
  });

// ─── dead-code ────────────────────────────────────────────────────────────────
program
  .command('dead-code [dir]')
  .description('List dead functions')
  .option('--json', 'Output as JSON')
  .action(async (dir: string | undefined, opts: { json?: boolean }) => {
    const rootDir = path.resolve(dir ?? '.');
    const { files: walked } = await walkRepo(rootDir);

    // Lazy import to avoid circular dependency in this thin CLI layer
    const { parseFile } = await import('@archsetu/core');
    const analyses = walked
      .map((f) => parseFile(f.content, f.filePath))
      .filter(Boolean);

    const dead = findDeadCode(analyses as Parameters<typeof findDeadCode>[0]);

    if (opts.json) {
      await writeJsonToStdout(dead);
      return;
    }

    if (dead.length === 0) {
      console.log(chalk.green('No dead code found.'));
      return;
    }

    dead.forEach((d) => {
      const short = d.function.filePath.split(/[/\\]/).slice(-2).join('/');
      const safe = d.isSafeToRemove ? chalk.green(' ✓') : '';
      console.log(`${short}:${d.function.startLine}\t${d.function.name}${safe}`);
    });
  });

// ─── submit ───────────────────────────────────────────────────────────────────
/**
 * For repos too large for ArchSetu's own hosted worker (see MAX_REPO_SIZE_KB
 * in archsetu.com's github.ts) - runs the analysis right here, using
 * whatever memory the caller's own machine/CI runner has (a GitHub-hosted
 * Actions runner alone has 7GB+, far more than ArchSetu's own 1GB worker
 * VM), then uploads just the (gzip-compressed) result to archsetu.com. See
 * apps/web/src/app/api/v1/submit/route.ts for the receiving end and its
 * trust-boundary notes.
 */
// The hosted worker caps a walk at 10,000 files to protect its own 1GB VM
// (see analyzeRepo's own doc comment in @archsetu/core). `submit` runs on
// the caller's own machine or CI runner instead - a GitHub Actions runner
// alone has 7GB+ - so it shouldn't inherit a limit that exists only to
// protect infrastructure it isn't using. Confirmed as a real, hittable
// ceiling by analyzing posthog/posthog (10,000+ files) via this command.
const SUBMIT_DEFAULT_MAX_FILES = 100_000;

program
  .command('submit <owner/repo> [dir]')
  .description('Analyze a local directory and submit the result to archsetu.com (for repos too large for the hosted analyzer)')
  .option('--token <token>', 'ArchSetu API key (or set ARCHSETU_API_KEY)')
  .option('--api-url <url>', 'ArchSetu API base URL', DEFAULT_API_URL)
  .option('--max-files <n>', 'Maximum files to analyze', (v) => parseInt(v, 10), SUBMIT_DEFAULT_MAX_FILES)
  .action(async (ownerRepo: string, dir: string | undefined, opts: { token?: string; apiUrl: string; maxFiles: number }) => {
    const token = opts.token ?? process.env['ARCHSETU_API_KEY'];
    if (!token) {
      console.error(chalk.red('Missing API key. Pass --token or set the ARCHSETU_API_KEY environment variable (find your key on your archsetu.com dashboard).'));
      process.exit(1);
    }

    const [owner, repo] = ownerRepo.split('/');
    if (!owner || !repo) {
      console.error(chalk.red(`Expected "owner/repo", got "${ownerRepo}".`));
      process.exit(1);
    }

    const rootDir = path.resolve(dir ?? '.');
    const analyzeSpinner = ora(`Analyzing ${rootDir}...`).start();
    let result: Awaited<ReturnType<typeof analyzeRepo>>;
    // The hosted worker times its own clone+analyze and stores it as
    // duration_ms on the analyses row (see analysis.worker.mts) - this path
    // runs entirely outside that worker, so without measuring it here
    // ourselves, every submit-path analysis (which includes every
    // auto-routed-to-Actions large repo, not just manual CLI runs) would
    // permanently show no duration on its report, even though the work
    // obviously took real time. Measuring here, not derived from the submit
    // API calls' own timestamps below, since those only span a few fast HTTP
    // round trips long after the actual analysis already finished.
    const analyzeStartedAt = Date.now();
    try {
      result = await analyzeRepo(rootDir, { maxFiles: opts.maxFiles });
      if (result.truncated) {
        analyzeSpinner.warn(
          `Analysis complete: ${result.health.score}/100 (${result.health.grade}) - ` +
          `truncated at ${opts.maxFiles.toLocaleString()} files, pass --max-files to raise it`,
        );
      } else {
        analyzeSpinner.succeed(`Analysis complete: ${result.health.score}/100 (${result.health.grade})`);
      }
    } catch (err) {
      analyzeSpinner.fail('Analysis failed');
      console.error(chalk.red((err as Error).message));
      process.exit(1);
    }

    const analyzeDurationMs = Date.now() - analyzeStartedAt;

    // Same reasoning as analysis.worker.mts's own call site: analyzeRepo()
    // already computed result.declaredDependencies (pure manifest parsing),
    // but the actual vulnerability-database lookup requires a network call
    // packages/core is contractually forbidden from making - this CLI, like
    // the worker, is one of the two places allowed to make it. Never throws;
    // a slow/unreachable OSV.dev just leaves this null, same degrade-gracefully
    // contract as everything else in this pipeline.
    if (result.declaredDependencies.length > 0) {
      const depSpinner = ora(`Checking ${result.declaredDependencies.length} dependencies for known vulnerabilities...`).start();
      result.dependencyVulnerabilities = await checkDependencyVulnerabilities(result.declaredDependencies);
      const vulnCount = result.dependencyVulnerabilities?.vulnerabilities.length ?? 0;
      if (vulnCount > 0) {
        depSpinner.warn(`Found ${vulnCount} known vulnerabilit${vulnCount === 1 ? 'y' : 'ies'} in dependencies`);
      } else if (result.dependencyVulnerabilities) {
        depSpinner.succeed('No known vulnerabilities found in dependencies');
      } else {
        depSpinner.warn('Dependency vulnerability check unavailable (OSV.dev unreachable)');
      }
    }

    const uploadSpinner = ora(`Uploading results for ${owner}/${repo}...`).start();
    try {
      // ── Step 1: send a small summary, get back a signed upload URL ──────
      // The full result is never sent directly to archsetu.com's own
      // server - a real submission (posthog/posthog, 33,000+ functions)
      // confirmed the full gzip payload can exceed Vercel's own platform
      // request-body ceiling before ever reaching the API route's code, so
      // the large payload goes straight to Storage instead (step 2).
      const initRes = await fetch(`${opts.apiUrl}/api/v1/submit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Archsetu-Owner': owner,
          'X-Archsetu-Repo': repo,
        },
        body: JSON.stringify({
          health: result.health,
          totalFunctions: result.totalFunctions,
          totalFiles: result.totalFiles,
          totalLines: result.totalLines,
          avgComplexity: result.avgComplexity,
          maxComplexity: result.maxComplexity,
          deadCodeCount: result.deadCode.length,
          entryPointCount: result.entryPoints.length,
          languageBreakdown: result.languageBreakdown,
          primaryLanguage: result.primaryLanguage,
          durationMs: analyzeDurationMs,
          // Counts only, same reasoning as everything else on this step-1
          // summary - full finding detail already travels in the step-2
          // Storage upload of the complete `result` object below. Optional
          // on the server side so older CLI versions don't get rejected.
          securityHighCount: result.securityRisk.highCount,
          securityMediumCount: result.securityRisk.mediumCount,
          securityLowCount: result.securityRisk.lowCount,
          gitHistorySecretCount: result.gitHistorySecrets?.findings.length ?? null,
          dependencyVulnCriticalCount: result.dependencyVulnerabilities?.criticalCount ?? null,
          dependencyVulnHighCount: result.dependencyVulnerabilities?.highCount ?? null,
          dependencyVulnMediumCount: result.dependencyVulnerabilities?.mediumCount ?? null,
          dependencyVulnLowCount: result.dependencyVulnerabilities?.lowCount ?? null,
        }),
      });
      const initData = await parseJsonResponse<{
        analysisId?: string;
        uploadUrl?: string;
        reportPath?: string;
        error?: { message: string };
      }>(initRes);
      if (!initRes.ok || !initData.analysisId || !initData.uploadUrl) {
        uploadSpinner.fail('Upload failed');
        console.error(chalk.red(initData.error?.message ?? `HTTP ${initRes.status}`));
        process.exit(1);
      }

      // ── Step 2: PUT the full compressed result straight to Storage ──────
      const compressed = await gzipJsonStringify(result);
      const uploadRes = await fetch(initData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/gzip' },
        body: compressed,
      });
      if (!uploadRes.ok) {
        uploadSpinner.fail('Upload failed');
        // A bare status code alone (the previous behavior here) isn't
        // enough to tell "too large for the bucket's size limit" apart from
        // "expired signed URL" apart from any other Storage-side rejection -
        // confirmed the hard way when an HTTP 400 with no body context took
        // a full extra round trip to diagnose. Storage error responses are
        // small JSON/text, safe to read and show directly.
        const bodyText = await uploadRes.text().catch(() => '');
        const detail = bodyText.slice(0, 500).trim();
        console.error(chalk.red(`Storage upload failed: HTTP ${uploadRes.status} (${(compressed.length / 1024 / 1024).toFixed(1)}MB payload)${detail ? ` - ${detail}` : ''}`));
        process.exit(1);
      }

      // ── Step 3: confirm, so the analysis flips from queued to complete ──
      const completeRes = await fetch(`${opts.apiUrl}/api/v1/submit/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ analysisId: initData.analysisId }),
      });
      const completeData = await parseJsonResponse<{ error?: { message: string } }>(completeRes);
      if (!completeRes.ok) {
        uploadSpinner.fail('Upload failed');
        console.error(chalk.red(completeData.error?.message ?? `HTTP ${completeRes.status}`));
        process.exit(1);
      }

      uploadSpinner.succeed(`Report: ${chalk.cyan(`${opts.apiUrl}${initData.reportPath ?? ''}`)}`);
    } catch (err) {
      uploadSpinner.fail('Upload failed');
      console.error(chalk.red((err as Error).message));
      // fetch() wraps the real network-level failure in `.cause`, which
      // Error.message never includes - "fetch failed" alone gives no way to
      // tell a DNS failure from a TLS error from (as actually happened once)
      // a redirect-handling bug, and cost a manual reproduction with a raw
      // script to find. Surface it directly instead of hiding it.
      const cause = (err as { cause?: unknown }).cause;
      if (cause) console.error(chalk.dim(`Cause: ${cause instanceof Error ? cause.message : String(cause)}`));
      process.exit(1);
    }
  });

// ─── install-hook / uninstall-hook ─────────────────────────────────────────────
// A local git pre-commit gate, the same idea as the GitHub Action but for a
// developer's own machine, before code ever reaches a PR. Deliberately
// top-level command NAMES (not Commander's "hook install" space-separated
// form, which actually parses the second word as a positional argument
// placeholder, not a literal subcommand token) to avoid ambiguity.
const HOOK_MARKER = '# archsetu-managed-hook - https://archsetu.com';

function findGitDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(dir, '.git');
    if (fs.existsSync(gitPath)) return gitPath;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function hookBody(minScore?: number): string {
  const lines = [
    'RESULT=$(archsetu health . 2>/dev/null)',
    'SCORE=$(echo "$RESULT" | awk \'{print $1}\')',
    'GRADE=$(echo "$RESULT" | awk \'{print $2}\')',
    'echo "ArchSetu health: $SCORE/100 ($GRADE)"',
  ];
  if (minScore != null) {
    lines.push(
      `if [ -n "$SCORE" ] && [ "$SCORE" -lt ${minScore} ]; then`,
      `  echo "Health score $SCORE is below the required minimum of ${minScore}. Commit blocked."`,
      `  echo "Run 'git commit --no-verify' to bypass (not recommended)."`,
      '  exit 1',
      'fi',
    );
  }
  return lines.join('\n');
}

program
  .command('install-hook')
  .description('Install a local pre-commit hook that runs ArchSetu health checks before each commit')
  .option('--min-score <n>', 'Block the commit if the health score falls below this (0-100)', (v) => parseInt(v, 10))
  .action((opts: { minScore?: number }) => {
    const gitDir = findGitDir(process.cwd());
    if (!gitDir) {
      console.error(chalk.red('No .git directory found - run this from inside a git repository.'));
      process.exit(1);
    }
    const hooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-commit');

    // Never silently overwrite a hook ArchSetu didn't install itself - a
    // team's existing Husky/lint-staged setup living at this exact path is
    // real, in-use configuration, not something to clobber without asking.
    if (fs.existsSync(hookPath) && !fs.readFileSync(hookPath, 'utf8').includes(HOOK_MARKER)) {
      console.error(chalk.red('A pre-commit hook already exists here and was not installed by ArchSetu - refusing to overwrite it.'));
      console.error('Add this snippet to your existing hook instead:\n');
      console.error(chalk.dim(hookBody(opts.minScore)));
      process.exit(1);
    }

    fs.writeFileSync(hookPath, `#!/usr/bin/env sh\n${HOOK_MARKER}\n${hookBody(opts.minScore)}\n`, { mode: 0o755 });
    fs.chmodSync(hookPath, 0o755);
    console.log(chalk.green(`Installed pre-commit hook at ${hookPath}`));
    console.log(
      opts.minScore != null
        ? `Commits will be blocked if the health score falls below ${opts.minScore}.`
        : 'The hook will report the score on every commit but never block one (pass --min-score to change that).',
    );
  });

program
  .command('uninstall-hook')
  .description('Remove the ArchSetu-managed pre-commit hook')
  .action(() => {
    const gitDir = findGitDir(process.cwd());
    if (!gitDir) {
      console.error(chalk.red('No .git directory found.'));
      process.exit(1);
    }
    const hookPath = path.join(gitDir, 'hooks', 'pre-commit');
    if (!fs.existsSync(hookPath) || !fs.readFileSync(hookPath, 'utf8').includes(HOOK_MARKER)) {
      console.log('No ArchSetu-managed pre-commit hook found here.');
      return;
    }
    fs.unlinkSync(hookPath);
    console.log(chalk.green('Removed the ArchSetu pre-commit hook.'));
  });

// ─── init-ai-rules ──────────────────────────────────────────────────────────
// A lot of code today is written by an AI coding assistant, not typed by
// hand - Claude Code, Cursor, Copilot, and others each read their own
// project-level instructions file. This gives that assistant explicit
// awareness of ArchSetu's own deterministic checks, so the AI-era part of a
// codebase gets held to the same real, evidence-based signal as everything
// else, instead of ArchSetu only ever running after the fact.
const AI_RULES_MARKER = '<!-- archsetu-managed-block -->';
const AI_RULES_BLOCK = `${AI_RULES_MARKER}
## ArchSetu health checks

This project uses ArchSetu (archsetu.com) for deterministic, evidence-based code
health analysis - no AI or guessing involved in these checks, only real,
mechanically verified signal.

- Before finishing a task, run \`archsetu health .\` (or \`npx @archsetuweb/cli health .\`
  if not installed globally) and note the score.
- Never leave newly-introduced dead code behind. If \`archsetu dead-code .\` reports a
  function you just added as unreachable, either wire it up or remove it.
- Before adding a new dependency, avoid anything typosquatted or confusable with an
  internal package name.
- If a pre-commit hook or CI check enforces a minimum ArchSetu score, treat a failing
  score as a real signal to address, not something to bypass with --no-verify.
<!-- /archsetu-managed-block -->`;

interface AiAssistantTarget {
  id: string;
  label: string;
  relativePath: string;
}

const AI_ASSISTANT_TARGETS: AiAssistantTarget[] = [
  { id: 'claude', label: 'Claude Code', relativePath: 'CLAUDE.md' },
  { id: 'cursor', label: 'Cursor', relativePath: '.cursorrules' },
  { id: 'copilot', label: 'GitHub Copilot', relativePath: path.join('.github', 'copilot-instructions.md') },
];

program
  .command('init-ai-rules')
  .description('Add ArchSetu-awareness to your AI coding assistant\'s instructions file (Claude Code, Cursor, Copilot)')
  .option('--assistant <name>', 'Only target one assistant: claude, cursor, or copilot (default: all)')
  .action((opts: { assistant?: string }) => {
    const requested = opts.assistant?.toLowerCase();
    const targets = requested ? AI_ASSISTANT_TARGETS.filter((t) => t.id === requested) : AI_ASSISTANT_TARGETS;

    if (targets.length === 0) {
      console.error(chalk.red(`Unknown assistant "${opts.assistant}" - choose one of: ${AI_ASSISTANT_TARGETS.map((t) => t.id).join(', ')}`));
      process.exit(1);
    }

    for (const target of targets) {
      const fullPath = path.resolve(process.cwd(), target.relativePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(fullPath)) {
        const existing = fs.readFileSync(fullPath, 'utf8');
        if (existing.includes(AI_RULES_MARKER)) {
          console.log(chalk.dim(`${target.label}: already has the ArchSetu block (${target.relativePath}), skipped.`));
          continue;
        }
        // Append, never overwrite - these are files a team actively edits,
        // and replacing the whole file would destroy real, existing content.
        fs.writeFileSync(fullPath, `${existing.replace(/\s+$/, '')}\n\n${AI_RULES_BLOCK}\n`);
        console.log(chalk.green(`${target.label}: appended the ArchSetu block to existing ${target.relativePath}`));
      } else {
        fs.writeFileSync(fullPath, `${AI_RULES_BLOCK}\n`);
        console.log(chalk.green(`${target.label}: created ${target.relativePath}`));
      }
    }
  });

program.parse(process.argv);
