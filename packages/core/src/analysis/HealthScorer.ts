import type { HealthGrade, HealthScore, HealthScoreBreakdown } from '../types/analysis.types.js';

interface HealthInputs {
  deadCodeRatio: number;
  avgComplexity: number;
  /**
   * Fraction (0-1) of all functions at "critical" complexity (>20, see
   * complexityLevel in BaseParser.ts) - NOT the single highest complexity
   * value in the repo. The old formula (`100 - maxComplexity * 2`) let one
   * outlier function zero out this entire sub-score regardless of repo
   * size: any function past complexity 50 already saturated it, and a
   * codebase of any real size tends to have at least one (a generated-
   * feeling register table, a big switch statement) even when the rest of
   * the code is fine. Confirmed directly on torvalds/linux: a single
   * 1,136-complexity hardware register table function zeroed this score
   * for a 768,117-function repo where the average complexity was 4.4. A
   * ratio - same shape as oversizedFileRatio below - scales with how
   * *prevalent* high-complexity code is instead of its single worst case.
   */
  highComplexityRatio: number;
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
    // Field name kept as `maxComplexity` for backward compatibility with
    // already-stored analysis JSON (same reasoning as `testCoverage`
    // above) - see the highComplexityRatio doc comment on HealthInputs for
    // what this actually measures now.
    maxComplexity: Math.max(0, Math.min(100, 100 - inputs.highComplexityRatio * 100)),
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
