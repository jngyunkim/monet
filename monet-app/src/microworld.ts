export type MicroworldStepLike = { state: Record<string, string> };

export type MicroworldStateRow = {
  key: string;
  before: string | null;
  value: string | null;
  changed: boolean;
};

/** Build the state panel for one step while preserving removed values so the
 * reader can see the complete transition instead of only the final snapshot. */
export function microworldStateRows(
  steps: MicroworldStepLike[],
  stepIndex: number,
): MicroworldStateRow[] {
  if (steps.length === 0) return [];
  const index = Math.max(0, Math.min(stepIndex, steps.length - 1));
  const current = steps[index].state;
  const previous = index === 0 ? {} : steps[index - 1].state;
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();

  return keys.map((key) => {
    const before = previous[key] ?? null;
    const value = current[key] ?? null;
    return { key, before, value, changed: index === 0 || before !== value };
  });
}
