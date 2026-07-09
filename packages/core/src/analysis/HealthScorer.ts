import type { HealthGrade, HealthScore, HealthScoreBreakdown } from '../types/analysis.types.js';

interface HealthInputs {
  deadCodeRatio: number;
  avgComplexity: number;
  maxComplexity: number;
  testFileRatio: number;
  duplicationRatio: number;
  oversizedFileRatio: number;
}

/**
 * Calculates a 0-100 health score and letter grade for a repository.
 * Each metric is normalized to 0-100 (100 = best) then weighted.
 */
export function calculateHealthScore(inputs: HealthInputs): HealthScore {
  const weights: Record<keyof HealthScoreBreakdown, number> = {
    deadCodeRatio: 0.25,
    avgComplexity: 0.25,
    maxComplexity: 0.15,
    testCoverage: 0.15,
    duplication: 0.10,
    fileSize: 0.10,
  };

  const breakdown: HealthScoreBreakdown = {
    deadCodeRatio: Math.max(0, Math.min(100, 100 - inputs.deadCodeRatio * 100)),
    avgComplexity: Math.max(0, Math.min(100, 100 - (inputs.avgComplexity - 1) * 10)),
    maxComplexity: Math.max(0, Math.min(100, 100 - inputs.maxComplexity * 2)),
    testCoverage: Math.max(0, Math.min(100, inputs.testFileRatio * 200)),
    duplication: Math.max(0, Math.min(100, 100 - inputs.duplicationRatio * 100)),
    fileSize: Math.max(0, Math.min(100, 100 - inputs.oversizedFileRatio * 100)),
  };

  const total = (Object.keys(weights) as Array<keyof HealthScoreBreakdown>).reduce(
    (sum, key) => sum + (breakdown[key] ?? 0) * (weights[key] ?? 0),
    0,
  );

  const score = Math.round(total);
  const grade = scoreToGrade(score);

  return { score, grade, breakdown };
}

function scoreToGrade(score: number): HealthGrade {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}
