/**
 * Breadcrumb.tsx — a slim path bar under the title/tab chrome showing where the
 * current document lives. Deep paths collapse their middle with an ellipsis.
 * Hidden in zen mode (see reading.css).
 */

import { Fragment, useMemo } from "react";
import { useDocumentStore } from "../../store/documentStore";

const ELLIPSIS = "…";

export function Breadcrumb() {
  const path = useDocumentStore((s) => s.path);

  const crumbs = useMemo(() => {
    if (!path) return null;
    const sep = path.includes("\\") ? "\\" : "/";
    const parts = path.split(sep).filter(Boolean);
    if (parts.length === 0) return null;
    const file = parts[parts.length - 1];
    const dirs = parts.slice(0, -1);
    // Collapse very deep paths: first › … › parent-of-parent › parent › file.
    const shown =
      dirs.length > 3
        ? [dirs[0], ELLIPSIS, dirs[dirs.length - 2], dirs[dirs.length - 1]]
        : dirs;
    // Precompute stable, unique keys here so the render has no index-based keys.
    const dirCrumbs = shown.map((seg, i) => ({ seg, key: `${i}:${seg}` }));
    return { dirCrumbs, file };
  }, [path]);

  if (!crumbs) return null;

  return (
    <nav className="breadcrumb" aria-label="Document path">
      {crumbs.dirCrumbs.map(({ seg, key }) => (
        <Fragment key={key}>
          <span
            className={`breadcrumb-seg${seg === ELLIPSIS ? " breadcrumb-ellipsis" : ""}`}
            title={seg === ELLIPSIS ? undefined : seg}
          >
            {seg}
          </span>
          <span className="breadcrumb-sep" aria-hidden="true">
            ›
          </span>
        </Fragment>
      ))}
      <span className="breadcrumb-seg is-file" title={crumbs.file}>
        {crumbs.file}
      </span>
    </nav>
  );
}
