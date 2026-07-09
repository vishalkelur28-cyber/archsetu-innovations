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
import chalk from 'chalk';
import ora from 'ora';
import {
  analyzeRepo,
  calculateHealthScore,
  findDeadCode,
  walkRepo,
} from '@archsetu/core';

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
    const walked = await walkRepo(rootDir);

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

program.parse(process.argv);
