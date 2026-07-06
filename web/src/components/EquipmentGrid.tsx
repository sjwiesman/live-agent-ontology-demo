import { Cog } from 'lucide-react';
import { EquipmentStatus } from '../api/client';

const STATUS_CHIP: Record<string, string> = {
  RUNNING: 'bg-green-900/50 border-green-800 text-green-200',
  DEGRADED: 'bg-yellow-900/50 border-yellow-700 text-yellow-200',
  DOWN: 'bg-red-900/60 border-red-700 text-red-200 animate-pulse',
};

function metric(e: EquipmentStatus): string {
  if (e.equipment_type === 'SORTER' && e.throughput_pph != null) {
    return `${Math.round(e.throughput_pph).toLocaleString()} pph`;
  }
  if (e.equipment_type === 'SCANNER' && e.read_rate_pct != null) {
    return `${e.read_rate_pct.toFixed(1)}% read`;
  }
  if (e.belt_speed_fpm != null) {
    return `${Math.round(e.belt_speed_fpm)} fpm`;
  }
  return '—';
}

export default function EquipmentGrid({
  equipment,
  facilityId,
}: {
  equipment: EquipmentStatus[];
  facilityId: string | null;
}) {
  const filtered = facilityId ? equipment.filter((e) => e.facility_id === facilityId) : equipment;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Cog className="h-4 w-4 text-ups-gold" />
        <h2 className="font-semibold text-white">Sortation Equipment</h2>
        <span className="text-xs text-gray-500">(live historian telemetry)</span>
        {facilityId && <span className="ml-auto text-xs font-mono text-gray-400">{facilityId}</span>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {filtered.map((e) => (
          <div
            key={e.equipment_id}
            className={`rounded border px-2 py-1.5 text-xs ${STATUS_CHIP[e.status] ?? STATUS_CHIP.RUNNING}`}
            title={e.latest_alarm_message ?? e.name}
          >
            <div className="font-mono font-medium truncate">{e.equipment_id}</div>
            <div className="flex justify-between opacity-80">
              <span>{metric(e)}</span>
              {e.motor_temp_c != null && <span>{Math.round(e.motor_temp_c)}°C</span>}
            </div>
            {e.active_alarm_count > 0 && (
              <div className="mt-0.5 font-medium">
                {e.active_alarm_count} alarm{e.active_alarm_count > 1 ? 's' : ''}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
