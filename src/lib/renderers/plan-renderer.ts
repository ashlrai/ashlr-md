import { frontmatterText } from "../frontmatter";
import { taskMarks } from "../tasklist";

/** Read original source so checklist write-back offsets remain valid. */
export function parsePlan(content: string) {
  const steps = taskMarks(content).flatMap((mark, index) =>
    mark ? [{ ...mark, line: index + 1 }] : [],
  );
  const done = steps.filter((step) => step.checked).length;
  const status =
    frontmatterText(content, "status") ||
    (steps.length > 0 && done === steps.length
      ? "complete"
      : done > 0
        ? "in progress"
        : "pending");
  return { steps, done, total: steps.length, status };
}
