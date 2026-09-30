import { useState } from "react";

import { SECTION_LABEL, type Employee, type TeamGroup } from "../lib/api";
import { IconChevronDown, IconHouse, IconSim, IconUserTie } from "./Icons";

/** Teams plegados. Se recuerdan en este navegador para no reabrirlos en cada visita. */
export function useCollapsedTeams(storageKey: string) {
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* sin almacenamiento: se pliega solo en esta visita */
      }
      return next;
    });
  return { isOpen: (key: string) => !closed.has(key), toggle };
}

export function SectionBanner({ group }: { group: TeamGroup<Employee> }) {
  if (!group.team) return null;
  const Icon = group.team.section === "lineas" ? IconSim : IconHouse;
  return (
    <div className="section-banner">
      <Icon width={14} height={14} /> {SECTION_LABEL[group.team.section]}
    </div>
  );
}

export function TeamHeader({
  group,
  open,
  onToggle,
  extra,
}: {
  group: TeamGroup<Employee>;
  open: boolean;
  onToggle: () => void;
  extra?: string;
}) {
  const name = group.team?.name ?? "Sin team";
  const count = group.items.length;
  return (
    <div className={`team-head-in${open ? "" : " closed"}`}>
      <button type="button" className="team-toggle" onClick={onToggle} aria-expanded={open} aria-label={`Mostrar u ocultar ${name}`}>
        <IconChevronDown width={14} height={14} />
      </button>
      <span className="team-name">{name}</span>
      {group.team && (
        <span className={`team-sup${group.supervisor ? "" : " none"}`}>
          <IconUserTie width={13} height={13} /> {group.supervisor ? group.supervisor.full_name : "Sin supervisor asignado"}
        </span>
      )}
      <span className="team-meta">
        {count} agente{count === 1 ? "" : "s"}
        {extra && ` · ${extra}`}
      </span>
    </div>
  );
}
