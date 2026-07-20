#!/usr/bin/env node
/**
 * ArchSetu CLI
 *
 * Usage:
 *   archsetu analyze ./path/to/repo
 *   archsetu analyze --json ./path/to/repo
 *   archsetu health ./path/to/repo
 *   archsetu dead-code ./path/to/repo
 */

import { Command } from 'commander';
import path from 'path';
import zlib from 'zlib';
import chalk from 'chalk';
import ora from 'ora';
import {
  analyzeRepo,
  calculateHealthScore,
  findDeadCode,
  walkRepo,
} from '@archsetu/core';

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
        process.stdout.write(JSON.stringify(result, null, 2));
        return;
      }

      // Pretty print
      const { health, totalFunctions, deadCode, entryPoints, totalFiles, totalLines } = result;
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
      process.stdout.write(JSON.stringify(dead, null, 2));
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
      const compressed = zlib.gzipSync(JSON.stringify(result));
      const uploadRes = await fetch(initData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/gzip' },
        body: compressed,
      });
      if (!uploadRes.ok) {
        uploadSpinner.fail('Upload failed');
        console.error(chalk.red(`Storage upload failed: HTTP ${uploadRes.status}`));
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

program.parse(process.argv);
