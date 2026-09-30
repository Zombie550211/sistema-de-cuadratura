import type { SVGProps } from "react";

const base = (d: string) =>
  function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
        <path d={d} />
      </svg>
    );
  };

export const IconHome = base("M3 11.5 12 4l9 7.5M5 10v10h14V10");
export const IconUsers = base("M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8");
export const IconCalendar = base("M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2");
export const IconUpload = base("M12 16V4M7 9l5-5 5 5M4 16v4h16v-4");
export const IconClock = base("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2");
export const IconShield = base("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10");
export const IconLogout = base("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9");
export const IconPlus = base("M12 5v14M5 12h14");
export const IconX = base("M18 6 6 18M6 6l12 12");
export const IconChevronLeft = base("m15 18-6-6 6-6");
export const IconChevronRight = base("m9 18 6-6-6-6");
export const IconFile = base("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6");
export const IconLink = base("M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7");
