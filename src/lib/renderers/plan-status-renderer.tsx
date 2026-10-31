import { parsePlan } from "./plan-renderer";

/** The Markdown viewer supplies the interactive checklist directly from source. */
export function PlanStatusRenderer({ content }: { content: string }) {
  const plan = parsePlan(content);
  return (
    <div className="plan-status" role="status" aria-label="Plan status">
      <span>Status: {plan.status}</span>
      {plan.total > 0 && (
        <>
          {" · "}
          <span>
            {plan.done} of {plan.total} steps complete
          </span>
          <progress aria-label="Plan completion" value={plan.done} max={plan.total} />
        </>
      )}
    </div>
  );
}
