import { useEffect, useState } from "react";

import { fmtDayLabel, TZ } from "../lib/format";

const timeFmt = new Intl.DateTimeFormat("es-SV", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Reloj en hora de El Salvador: el satélite da una vuelta por minuto. */
export function LiveClock() {
  const now = useNow();
  const deg = (now.getSeconds() / 60) * 360;
  return (
    <div className="live-clock" title="Hora oficial de El Salvador (UTC-6)">
      <div className="orbit">
        <div className="orbit-core" />
        <div className="orbit-hand" style={{ transform: `rotate(${deg}deg)`, transition: now.getSeconds() === 0 ? "none" : "transform 0.25s" }} />
      </div>
      <div>
        <div className="time">{timeFmt.format(now)}</div>
        <div className="caption">
          {fmtDayLabel(now)}
        </div>
      </div>
    </div>
  );
}
