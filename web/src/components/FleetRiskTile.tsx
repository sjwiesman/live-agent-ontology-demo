import { Truck } from 'lucide-react';
import { FleetRisk } from '../api/client';

const RISK_BADGE: Record<string, string> = {
  HIGH: 'bg-red-800 text-red-100',
  MEDIUM: 'bg-yellow-700 text-yellow-100',
};

export default function FleetRiskTile({ vehicles }: { vehicles: FleetRisk[] }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Truck className="h-4 w-4 text-ups-gold" />
        <h2 className="font-semibold text-white">Fleet Risk</h2>
        <span className="ml-auto text-sm font-mono text-gray-400">{vehicles.length} flagged</span>
      </div>
      {vehicles.length === 0 ? (
        <div className="text-sm text-gray-500 py-4 text-center">No vehicles with active faults.</div>
      ) : (
        <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {vehicles.map((v) => (
            <li key={v.vehicle_id} className="text-xs rounded border border-gray-800 bg-gray-950 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="font-mono text-white">{v.vehicle_id}</span>
                <span className={`px-1.5 py-0.5 rounded-full font-medium ${RISK_BADGE[v.risk_level] ?? 'bg-gray-700'}`}>
                  {v.risk_level}
                </span>
                <span className="text-gray-500">{v.vehicle_type}</span>
                {v.open_work_orders > 0 && (
                  <span className="ml-auto text-green-300">{v.open_work_orders} WO open</span>
                )}
              </div>
              <div className="mt-0.5 text-gray-400">
                {v.fault_codes ? `faults: ${v.fault_codes}` : 'no active faults'}
                {v.driver_name ? ` · driver ${v.driver_name}` : ''}
              </div>
              {v.attached_trailer_id && (
                <div className="mt-0.5 text-gray-500">
                  trailer {v.attached_trailer_id} ({v.trailer_status ?? '—'}) ·{' '}
                  <span className={v.loaded_package_count > 0 && v.risk_level === 'HIGH' ? 'text-red-300' : ''}>
                    {v.loaded_package_count} packages loaded
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
