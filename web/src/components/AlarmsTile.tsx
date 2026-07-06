import { AlertTriangle, Check } from 'lucide-react';
import { Alarm } from '../api/client';

const SEVERITY_STYLES: Record<string, string> = {
  CRITICAL: 'bg-red-900/60 text-red-200 border-red-800',
  WARNING: 'bg-yellow-900/50 text-yellow-200 border-yellow-800',
  INFO: 'bg-gray-800 text-gray-300 border-gray-700',
};

export default function AlarmsTile({ alarms }: { alarms: Alarm[] }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-ups-gold" />
        <h2 className="font-semibold text-white">Active Alarms</h2>
        <span className="text-xs text-gray-500">(historian)</span>
        <span className="ml-auto text-sm font-mono text-gray-400">{alarms.length}</span>
      </div>
      {alarms.length === 0 ? (
        <div className="text-sm text-gray-500 py-4 text-center">No active alarms — all clear.</div>
      ) : (
        <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {alarms.map((a) => (
            <li
              key={a.alarm_id}
              className={`text-xs rounded border px-2 py-1.5 ${SEVERITY_STYLES[a.severity] ?? SEVERITY_STYLES.INFO}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">#{a.alarm_id}</span>
                <span className="font-semibold">{a.alarm_type}</span>
                <span className="font-mono">{a.equipment_id}</span>
                {a.acknowledged && (
                  <span className="ml-auto flex items-center gap-0.5 text-green-300">
                    <Check className="h-3 w-3" /> ack{a.acknowledged_by ? `: ${a.acknowledged_by}` : ''}
                  </span>
                )}
              </div>
              <div className="mt-0.5 opacity-80">{a.message}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
