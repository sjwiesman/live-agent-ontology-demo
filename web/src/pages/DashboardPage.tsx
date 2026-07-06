import { useState } from 'react';
import { Package, Zap } from 'lucide-react';
import { fetchDashboardSummary, triggerScenario } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import AlarmsTile from '../components/AlarmsTile';
import AtRiskPackagesTile from '../components/AtRiskPackagesTile';
import EquipmentGrid from '../components/EquipmentGrid';
import FleetRiskTile from '../components/FleetRiskTile';
import HubHealthTile from '../components/HubHealthTile';
import OntologyPanel from '../components/OntologyPanel';

const SCENARIOS = [
  { name: 'conveyor_jam', label: 'Jam a sorter' },
  { name: 'tractor_fault', label: 'Tractor engine fault' },
  { name: 'scanner_degraded', label: 'Degrade a scanner' },
];

export default function DashboardPage() {
  const { data, error } = usePolling(fetchDashboardSummary, 2000);
  const [selectedHub, setSelectedHub] = useState<string | null>(null);
  const [firing, setFiring] = useState<string | null>(null);

  const fire = async (name: string) => {
    setFiring(name);
    try {
      await triggerScenario(name);
    } catch (e) {
      console.error('scenario failed', e);
    } finally {
      setTimeout(() => setFiring(null), 1500);
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded bg-ups-brown border border-ups-gold flex items-center justify-center">
            <Package className="h-5 w-5 text-ups-gold" />
          </div>
          <div>
            <h1 className="font-bold text-white leading-tight">UPS Hub Operations</h1>
            <div className="text-xs text-gray-500">
              Live context graph · SQL Server historian → Materialize → copilot
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500 hidden md:inline">Break something:</span>
          {SCENARIOS.map((s) => (
            <button
              key={s.name}
              onClick={() => fire(s.name)}
              disabled={firing !== null}
              className="text-xs px-3 py-1.5 rounded border border-amber-700 bg-amber-950/50 text-amber-200 hover:bg-amber-900/50 disabled:opacity-50 flex items-center gap-1 transition-colors"
            >
              <Zap className="h-3 w-3" />
              {firing === s.name ? 'firing…' : s.label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-800 bg-red-950/50 text-red-200 text-sm px-3 py-2">
          API unreachable: {error} — is the stack up? (make up)
        </div>
      )}

      {/* Hub health row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(data?.hubs ?? []).map((hub) => (
          <button
            key={hub.facility_id}
            onClick={() =>
              setSelectedHub(selectedHub === hub.facility_id ? null : hub.facility_id)
            }
            className={`text-left ${selectedHub === hub.facility_id ? 'ring-2 ring-ups-gold rounded-lg' : ''}`}
          >
            <HubHealthTile hub={hub} throughput={data?.throughput ?? []} />
          </button>
        ))}
      </div>

      {/* Detail tiles */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <AlarmsTile
          alarms={(data?.alarms ?? []).filter((a) => !selectedHub || a.facility_id === selectedHub)}
        />
        <AtRiskPackagesTile
          packages={(data?.at_risk_packages ?? []).filter(
            (p) => !selectedHub || p.current_facility_id === selectedHub,
          )}
          riskCounts={data?.package_risk_counts ?? {}}
        />
        <FleetRiskTile vehicles={data?.fleet_risk ?? []} />
      </div>

      <EquipmentGrid equipment={data?.equipment ?? []} facilityId={selectedHub} />

      <OntologyPanel />

      <footer className="text-xs text-gray-600 pb-4">
        Every tile reads Materialize serving indexes (point lookups, ~ms). The graph is fed by SQL
        Server CDC and is a few seconds behind the simulator at most. Click a hub to filter.
      </footer>
    </div>
  );
}
