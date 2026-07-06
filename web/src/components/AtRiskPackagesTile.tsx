import { PackageX } from 'lucide-react';
import { PackageContext } from '../api/client';

const RISK_BADGE: Record<string, string> = {
  HIGH: 'bg-red-800 text-red-100',
  MEDIUM: 'bg-yellow-700 text-yellow-100',
};

function riskReason(p: PackageContext): string {
  const reasons: string[] = [];
  if (p.equipment_at_risk && p.equipment_id) {
    reasons.push(`${p.equipment_id} ${p.equipment_alarm_severity ?? ''} alarm`.trim());
  }
  if (p.tractor_at_risk && p.tractor_id) {
    reasons.push(`tractor ${p.tractor_id} fault ${p.tractor_fault_codes ?? ''}`.trim());
  }
  if (reasons.length === 0 && p.tractor_fault_count > 0 && p.tractor_id) {
    reasons.push(`tractor ${p.tractor_id} fault`);
  }
  return reasons.join(' + ') || 'upstream dependency unhealthy';
}

export default function AtRiskPackagesTile({
  packages,
  riskCounts,
}: {
  packages: PackageContext[];
  riskCounts: Record<string, number>;
}) {
  const high = riskCounts.HIGH ?? 0;
  const medium = riskCounts.MEDIUM ?? 0;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center gap-2 mb-3">
        <PackageX className="h-4 w-4 text-ups-gold" />
        <h2 className="font-semibold text-white">At-Risk Packages</h2>
        <span className="ml-auto text-sm font-mono text-gray-400">
          <span className="text-red-400">{high} high</span> · <span className="text-yellow-400">{medium} med</span>
        </span>
      </div>
      {packages.length === 0 ? (
        <div className="text-sm text-gray-500 py-4 text-center">
          No packages at risk. Trigger a scenario to see the graph react.
        </div>
      ) : (
        <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {packages.map((p) => (
            <li key={p.package_id} className="text-xs rounded border border-gray-800 bg-gray-950 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-white">{p.package_id}</span>
                <span className={`px-1.5 py-0.5 rounded-full font-medium ${RISK_BADGE[p.risk_level] ?? 'bg-gray-700'}`}>
                  {p.risk_level}
                </span>
                <span className="ml-auto text-gray-500">{p.status}</span>
              </div>
              <div className="mt-0.5 text-gray-400">
                {p.current_facility_id ?? '—'} → {p.dest_facility_id} · {riskReason(p)}
              </div>
              <div className="mt-0.5 text-gray-600">
                promise {new Date(p.promised_delivery).toLocaleTimeString('en-US', { hour12: false })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
