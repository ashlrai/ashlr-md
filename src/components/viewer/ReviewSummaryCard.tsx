/**
 * ReviewSummaryCard.tsx
 *
 * A scannable summary header shown above the Markdown body when a document is
 * detected as an agent review/findings report (see lib/reviewDoc.ts). It shows
 * severity counts as color-coded badges, the total finding count, and the
 * average confidence when present.
 *
 * Purely presentational + driven by the {@link ReviewSummary} that
 * `detectReviewDoc` returns. Rendered only when detection succeeds, so ordinary
 * documents are completely unaffected.
 */

import GithubSlugger from "github-slugger";
import { useMemo } from "react";
import { smoothScrollBehavior } from "../../lib/motion";
import {
  type ReviewSummary,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  type Severity,
} from "../../lib/reviewDoc";

interface ReviewSummaryCardProps {
  summary: ReviewSummary;
}

/**
 * Build a slug for a finding title that matches the id `rehype-slug` writes for
 * the corresponding heading, so the badge can scroll to it. We slug each
 * finding title with the same github-slugger the renderer/outline use; if a
 * finding isn't a heading there may be no target, in which case the chip simply
 * isn't a link.
 *
 * Note: this can't perfectly mirror every rendered heading id (only headings
 * get ids, and the document has other headings competing for the slugger's
 * dedupe counter). We therefore only link findings whose title is non-empty and
 * accept best-effort anchoring; a miss just leaves a non-scrolling chip.
 */
function useFindingAnchors(summary: ReviewSummary): Map<number, string> {
  return useMemo(() => {
    const slugger = new GithubSlugger();
    // Keyed by source line, which is unique per finding (the parser emits at
    // most one finding per line).
    const map = new Map<number, string>();
    for (const f of summary.findings) {
      if (!f.title) continue;
      map.set(f.line, slugger.slug(f.title));
    }
    return map;
  }, [summary]);
}

function scrollToSlug(slug: string) {
  const el = document.getElementById(slug);
  if (el) {
    el.scrollIntoView({ behavior: smoothScrollBehavior(), block: "start" });
    // Briefly flag the target so the user sees where they landed.
    el.classList.add("review-finding-flash");
    window.setTimeout(() => el.classList.remove("review-finding-flash"), 1200);
  }
}

export function ReviewSummaryCard({ summary }: ReviewSummaryCardProps) {
  const anchors = useFindingAnchors(summary);
  const present = SEVERITY_ORDER.filter(
    (s): s is Severity => (summary.counts[s] ?? 0) > 0,
  );

  return (
    <aside
      className="review-card"
      aria-label={`Review summary: ${summary.total} findings`}
    >
      <div className="review-card__head">
        <span className="review-card__icon" aria-hidden="true">
          ⬡
        </span>
        <span className="review-card__title">Review</span>
        <span className="review-card__total">
          {summary.total} {summary.total === 1 ? "finding" : "findings"}
        </span>
        {summary.averageConfidence !== undefined && (
          <span
            className="review-card__confidence"
            title="Average confidence across findings"
          >
            {summary.averageConfidence}% confidence
          </span>
        )}
      </div>

      <ul className="review-card__badges">
        {present.map((sev) => (
          <li key={sev}>
            <span
              className="review-badge"
              data-severity={sev}
              title={`${summary.counts[sev]} ${SEVERITY_LABEL[sev]}`}
            >
              <span className="review-badge__count">{summary.counts[sev]}</span>
              <span className="review-badge__label">{SEVERITY_LABEL[sev]}</span>
            </span>
          </li>
        ))}
      </ul>

      <ol className="review-card__findings">
        {summary.findings.map((f) => {
          const slug = anchors.get(f.line);
          const label = f.title || SEVERITY_LABEL[f.severity];
          return (
            <li key={f.line} className="review-card__finding">
              <span
                className="review-card__finding-dot"
                data-severity={f.severity}
                aria-hidden="true"
              />
              {slug ? (
                <a
                  className="review-card__finding-link"
                  href={`#${slug}`}
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToSlug(slug);
                  }}
                >
                  {label}
                </a>
              ) : (
                <span className="review-card__finding-text">{label}</span>
              )}
              {f.confidence !== undefined && (
                <span className="review-card__finding-conf">{f.confidence}%</span>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
