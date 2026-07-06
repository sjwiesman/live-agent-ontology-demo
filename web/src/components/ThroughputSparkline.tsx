import { ThroughputPoint } from '../api/client';

/** Tiny inline SVG sparkline of scans/minute for one facility. */
export default function ThroughputSparkline({
  points,
  facilityId,
}: {
  points: ThroughputPoint[];
  facilityId: string;
}) {
  const series = points
    .filter((p) => p.facility_id === facilityId)
    .sort((a, b) => a.minute.localeCompare(b.minute))
    // The current (partial) minute always looks like a dip; drop it.
    .slice(0, -1)
    .map((p) => p.scan_count);

  if (series.length < 2) {
    return <div className="h-8 text-xs text-gray-600 flex items-center">collecting…</div>;
  }

  const w = 120;
  const h = 32;
  const max = Math.max(...series, 1);
  const step = w / (series.length - 1);
  const pathPoints = series
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
    .join(' ');

  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        points={pathPoints}
        fill="none"
        stroke="#FFB500"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
