import { Activity, AlertTriangle, Wrench } from 'lucide-react';
import { HubHealth, ThroughputPoint } from '../api/client';
import ThroughputSparkline from './ThroughputSparkline';

const STATUS_STYLES: Record<HubHealth['health_status'], string> = {
  HEALTHY: 'border-green-700 bg-green-950/40',
  DEGRADED: 'border-yellow-600 bg-yellow-950/40',
  CRITICAL: 'border-red-700 bg-red-950/40',
};

const STATUS_BADGE: Record<HubHealth['health_status'], string> = {
  HEALTHY: 'bg-green-800 text-green-200',
  DEGRADED: 'bg-yellow-700 text-yellow-100',
  CRITICAL: 'bg-red-800 text-red-100 animate-pulse',
};

export default function HubHealthTile({
  hub,
  throughput,
}: {
  hub: HubHealth;
  throughput: ThroughputPoint[];
}) {
  return (
    <div className={`rounded-lg border p-4 ${STATUS_STYLES[hub.health_status]}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="font-semibold text-white">{hub.name}</div>
          <div className="text-xs text-gray-400">
            {hub.facility_id} · {hub.city}, {hub.state}
          </div>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[hub.health_status]}`}>
          {hub.health_status}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="flex items-center gap-1 text-gray-400 text-xs">
            <Activity className="h-3 w-3" /> scans/10m
          </div>
          <div className="font-mono text-white">{hub.scans_last_10m.toLocaleString()}</div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-gray-400 text-xs">
            <AlertTriangle className="h-3 w-3" /> alarms
          </div>
          <div className="font-mono text-white">
            {hub.active_alarms}
            {hub.critical_alarms > 0 && (
              <span className="text-red-400 text-xs ml-1">({hub.critical_alarms} crit)</span>
            )}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1 text-gray-400 text-xs">
            <Wrench className="h-3 w-3" /> equip down
          </div>
          <div className="font-mono text-white">
            {hub.equipment_down}
            <span className="text-gray-500 text-xs">/{hub.equipment_total}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-end justify-between">
        <div>
          <div className="text-xs text-gray-400">avg sorter throughput</div>
          <div className="font-mono text-white text-sm">
            {hub.avg_sorter_throughput_pph != null
              ? `${Math.round(hub.avg_sorter_throughput_pph).toLocaleString()} pph`
              : '—'}
          </div>
        </div>
        <ThroughputSparkline points={throughput} facilityId={hub.facility_id} />
      </div>
    </div>
  );
}
