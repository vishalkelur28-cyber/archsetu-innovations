import type { HealthGrade, RepoAnalysis } from '../types/analysis.types.js';

export interface AnalysisDiff {
  healthScoreDelta: number;
  previousGrade: HealthGrade;
  currentGrade: HealthGrade;
  gradeChanged: boolean;
  deadCodeCountDelta: number;
  newDeadFunctions: string[];
  resolvedDeadFunctions: string[];
  avgComplexityDelta: number;
  totalFunctionsDelta: number;
  summary: string;
}

/**
 * Diffs two analyses of the same repo (e.g. this week vs. last week) into a
 * short, human-readable digest. Pure function, no new detection logic - it
 * only compares numbers and dead-code names the engine already produces.
 */
export function compareAnalyses(previous: RepoAnalysis, current: RepoAnalysis): AnalysisDiff {
  const prevDeadNames = new Set(previous.deadCode.map((d) => d.function.name));
  const currDeadNames = new Set(current.deadCode.map((d) => d.function.name));

  const newDeadFunctions = current.deadCode
    .filter((d) => !prevDeadNames.has(d.function.name))
    .map((d) => d.function.name);
  const resolvedDeadFunctions = previous.deadCode
    .filter((d) => !currDeadNames.has(d.function.name))
    .map((d) => d.function.name);

  const healthScoreDelta = current.health.score - previous.health.score;
  const deadCodeCountDelta = current.deadCode.length - previous.deadCode.length;
  const avgComplexityDelta = Math.round((current.avgComplexity - previous.avgComplexity) * 100) / 100;
  const totalFunctionsDelta = current.totalFunctions - previous.totalFunctions;
  const gradeChanged = previous.health.grade !== current.health.grade;

  const summary = buildSummary({
    healthScoreDelta,
    gradeChanged,
    previousGrade: previous.health.grade,
    currentGrade: current.health.grade,
    newDeadFunctions,
    resolvedDeadFunctions,
    avgComplexityDelta,
    totalFunctionsDelta,
  });

  return {
    healthScoreDelta,
    previousGrade: previous.health.grade,
    currentGrade: current.health.grade,
    gradeChanged,
    deadCodeCountDelta,
    newDeadFunctions,
    resolvedDeadFunctions,
    avgComplexityDelta,
    totalFunctionsDelta,
    summary,
  };
}

function buildSummary(d: {
  healthScoreDelta: number;
  gradeChanged: boolean;
  previousGrade: HealthGrade;
  currentGrade: HealthGrade;
  newDeadFunctions: string[];
  resolvedDeadFunctions: string[];
  avgComplexityDelta: number;
  totalFunctionsDelta: number;
}): string {
  const parts: string[] = [];

  if (d.healthScoreDelta === 0) {
    parts.push('Health score unchanged.');
  } else {
    const arrow = d.healthScoreDelta > 0 ? '↑' : '↓';
    parts.push(`Health score ${arrow}${Math.abs(d.healthScoreDelta)}${d.gradeChanged ? ` (${d.previousGrade} → ${d.currentGrade})` : ''}.`);
  }

  if (d.newDeadFunctions.length > 0) {
    parts.push(`${d.newDeadFunctions.length} new dead function${d.newDeadFunctions.length === 1 ? '' : 's'}.`);
  }
  if (d.resolvedDeadFunctions.length > 0) {
    parts.push(`${d.resolvedDeadFunctions.length} dead function${d.resolvedDeadFunctions.length === 1 ? '' : 's'} cleaned up.`);
  }
  if (d.avgComplexityDelta !== 0) {
    parts.push(`Avg complexity ${d.avgComplexityDelta > 0 ? 'up' : 'down'} ${Math.abs(d.avgComplexityDelta)}.`);
  }
  if (d.totalFunctionsDelta !== 0) {
    parts.push(`${d.totalFunctionsDelta > 0 ? '+' : ''}${d.totalFunctionsDelta} functions.`);
  }

  return parts.length > 0 ? parts.join(' ') : 'No meaningful change since the last analysis.';
}
