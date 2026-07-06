// Typed client for the UPS Live Context Graph API.

const getApiUrl = (): string => {
  const url = import.meta.env.VITE_API_URL;
  if (url && typeof url === 'string' && url.trim() !== '') return url;
  return 'http://localhost:8080';
};

export const API_URL = getApiUrl();

export interface HubHealth {
  facility_id: string;
  name: string;
  city: string;
  state: string;
  scans_last_10m: number;
  active_alarms: number;
  critical_alarms: number;
  equipment_total: number;
  equipment_down: number;
  equipment_degraded: number;
  avg_sorter_throughput_pph: number | null;
  health_status: 'HEALTHY' | 'DEGRADED' | 'CRITICAL';
}

export interface Alarm {
  alarm_id: number;
  equipment_id: string;
  facility_id: string;
  equipment_type: string;
  alarm_type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  raised_at: string;
  acknowledged: boolean;
  acknowledged_by: string | null;
}

export interface PackageContext {
  package_id: string;
  service_level: string;
  status: string;
  promised_delivery: string;
  origin_facility_id: string;
  dest_facility_id: string;
  current_facility_id: string | null;
  current_facility_name: string | null;
  last_scan_ts: string | null;
  last_scan_type: string | null;
  planned_sort_equipment_id: string | null;
  equipment_id: string | null;
  equipment_name: string | null;
  equipment_status: string | null;
  equipment_alarm_count: number;
  equipment_alarm_severity: string | null;
  equipment_alarm_message: string | null;
  trailer_id: string | null;
  trailer_status: string | null;
  tractor_id: string | null;
  tractor_fault_count: number;
  tractor_fault_severity: string | null;
  tractor_fault_codes: string | null;
  equipment_at_risk: boolean;
  tractor_at_risk: boolean;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface FleetRisk {
  vehicle_id: string;
  vehicle_type: string;
  home_facility_id: string;
  status: string;
  odometer_miles: number;
  driver_id: string | null;
  driver_name: string | null;
  active_fault_count: number;
  critical_fault_count: number;
  fault_severity: string | null;
  fault_codes: string | null;
  open_work_orders: number;
  attached_trailer_id: string | null;
  trailer_status: string | null;
  route_id: string | null;
  loaded_package_count: number;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface EquipmentStatus {
  equipment_id: string;
  facility_id: string;
  equipment_type: string;
  name: string;
  status: 'RUNNING' | 'DEGRADED' | 'DOWN';
  belt_speed_fpm: number | null;
  motor_temp_c: number | null;
  vibration_mm_s: number | null;
  throughput_pph: number | null;
  read_rate_pct: number | null;
  latest_reading_ts: string | null;
  active_alarm_count: number;
  alarm_severity: string | null;
  latest_alarm_message: string | null;
}

export interface ThroughputPoint {
  facility_id: string;
  minute: string;
  scan_count: number;
}

export interface DashboardSummary {
  hubs: HubHealth[];
  alarms: Alarm[];
  at_risk_packages: PackageContext[];
  package_risk_counts: Record<string, number>;
  fleet_risk: FleetRisk[];
  equipment: EquipmentStatus[];
  throughput: ThroughputPoint[];
}

export async function fetchDashboardSummary(): Promise<DashboardSummary> {
  const resp = await fetch(`${API_URL}/api/dashboard/summary`);
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}

export async function fetchOntology(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${API_URL}/api/ontology`);
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}

export async function triggerScenario(name: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${API_URL}/api/scenarios/${name}`, { method: 'POST' });
  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  return resp.json();
}
