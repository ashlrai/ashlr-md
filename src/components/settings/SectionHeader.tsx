import type { ReactNode } from "react";

/** Icon + title row that heads each settings section. */
export function SectionHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="settings-section-header">
      <span className="settings-section-icon">{icon}</span>
      <h3 className="settings-section-title">{title}</h3>
    </div>
  );
}
