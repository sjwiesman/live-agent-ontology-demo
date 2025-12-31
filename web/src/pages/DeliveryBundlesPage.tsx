import { useState, useEffect, useMemo } from "react";
import { useZero, useQuery } from "@rocicorp/zero/react";
import { Schema } from "../schema";
import { deliveryBundlesApi, DeliveryBundleEnriched, DeliveryBundleStats } from "../api/client";
import { formatAmount } from "../test/utils";
import {
  Package,
  Truck,
  AlertTriangle,
  CheckCircle2,
  Store,
  Wifi,
  WifiOff,
  TrendingUp,
  GitBranch,
  Layers,
  Info,
  RefreshCw,
} from "lucide-react";

export default function DeliveryBundlesPage() {
  const z = useZero<Schema>();
  const [lastUpdateTime, setLastUpdateTime] = useState<number>(Date.now());
  const [selectedStore, setSelectedStore] = useState<string | undefined>();
  const [showConflictsOnly, setShowConflictsOnly] = useState<boolean | undefined>();
  const [enrichedBundles, setEnrichedBundles] = useState<DeliveryBundleEnriched[]>([]);
  const [stats, setStats] = useState<DeliveryBundleStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showExplanation, setShowExplanation] = useState(false);

  // Real-time data from Zero
  const [bundlesData] = useQuery(z.query.delivery_bundles_mv);
  const [storesData] = useQuery(z.query.stores_mv);

  // Load enriched data from API
  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const [bundlesRes, statsRes] = await Promise.all([
          deliveryBundlesApi.listBundlesEnriched({
            store_id: selectedStore,
            has_conflict: showConflictsOnly,
            limit: 200,
          }),
          deliveryBundlesApi.getStats({ store_id: selectedStore }),
        ]);
        setEnrichedBundles(bundlesRes.data);
        setStats(statsRes.data);
      } catch (error) {
        console.error("Failed to load delivery bundles:", error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedStore, showConflictsOnly]);

  // Update timestamp when real-time data changes
  useEffect(() => {
    if (bundlesData.length > 0) {
      setLastUpdateTime(Date.now());
    }
  }, [bundlesData]);

  // Calculate summary metrics from real-time data
  const realtimeMetrics = useMemo(() => {
    const total = bundlesData.length;
    const valid = bundlesData.filter(b => !b.has_conflict).length;
    const conflicted = bundlesData.filter(b => b.has_conflict).length;
    const maxSize = Math.max(...bundlesData.map(b => b.bundle_size || 2), 0);
    const uniqueStores = new Set(bundlesData.map(b => b.store_id).filter(Boolean)).size;

    return { total, valid, conflicted, maxSize, uniqueStores };
  }, [bundlesData]);

  // Group bundles by store for visualization
  const bundlesByStore = useMemo(() => {
    const grouped: Record<string, DeliveryBundleEnriched[]> = {};
    for (const bundle of enrichedBundles) {
      const storeKey = bundle.store_name || bundle.store_id || 'Unknown';
      if (!grouped[storeKey]) {
        grouped[storeKey] = [];
      }
      grouped[storeKey].push(bundle);
    }
    return grouped;
  }, [enrichedBundles]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Delivery Bundles</h1>
            {z.online ? (
              <span className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-100 rounded-full">
                <Wifi className="h-3 w-3" />
                Real-time
              </span>
            ) : (
              <span className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-100 rounded-full">
                <WifiOff className="h-3 w-3" />
                Connecting...
              </span>
            )}
            <span className="text-xs text-gray-500">
              Last update: {new Date(lastUpdateTime).toLocaleTimeString()}
            </span>
          </div>
          <p className="text-gray-600 mt-1">
            Optimize deliveries by bundling compatible orders together
          </p>
        </div>
        <button
          onClick={() => setShowExplanation(!showExplanation)}
          className="flex items-center gap-2 px-3 py-2 text-sm text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"
        >
          <GitBranch className="h-4 w-4" />
          How Mutual Recursion Works
        </button>
      </div>

      {/* Explanation Panel */}
      {showExplanation && (
        <div className="mb-6 p-4 bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-lg">
          <div className="flex items-start gap-3">
            <Info className="h-5 w-5 text-indigo-600 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-semibold text-indigo-900 mb-2">
                Materialize's WITH MUTUALLY RECURSIVE
              </h3>
              <div className="text-sm text-gray-700 space-y-2">
                <p>
                  Standard SQL's <code className="px-1 bg-white rounded">WITH RECURSIVE</code> only allows a CTE to reference itself.
                  Materialize extends this with <strong>mutual recursion</strong> where multiple CTEs can reference <em>each other</em>.
                </p>
                <p className="font-medium text-indigo-800">The chicken-and-egg problem:</p>
                <ul className="list-disc list-inside ml-2 space-y-1">
                  <li><strong>can_bundle(A, B)</strong> depends on <strong>has_conflict(A, B)</strong></li>
                  <li><strong>has_conflict(A, B)</strong> depends on <strong>can_bundle(A, B)</strong></li>
                </ul>
                <p>
                  This is impossible in standard SQL! Materialize implements true <strong>Datalog semantics</strong>,
                  evaluating all CTEs together until reaching a fixed point.
                </p>
                <p className="text-indigo-700 font-medium">
                  Benefits: Real-time consistency, incremental maintenance, and automatic propagation of changes.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Summary Statistics */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-500">Total Bundles</h3>
            <Layers className="h-5 w-5 text-blue-500" />
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {stats?.total_bundles ?? realtimeMetrics.total}
          </div>
          <p className="text-xs text-gray-500 mt-1">Potential groupings</p>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-500">Valid Bundles</h3>
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          </div>
          <div className="text-2xl font-bold text-green-600">
            {stats?.valid_bundles ?? realtimeMetrics.valid}
          </div>
          <p className="text-xs text-gray-500 mt-1">Ready to combine</p>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-500">Conflicts</h3>
            <AlertTriangle className="h-5 w-5 text-red-500" />
          </div>
          <div className="text-2xl font-bold text-red-600">
            {stats?.conflicted_bundles ?? realtimeMetrics.conflicted}
          </div>
          <p className="text-xs text-gray-500 mt-1">Inventory blocked</p>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-500">Max Bundle Size</h3>
            <Package className="h-5 w-5 text-purple-500" />
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {stats?.max_bundle_size ?? realtimeMetrics.maxSize}
          </div>
          <p className="text-xs text-gray-500 mt-1">Orders together</p>
        </div>

        <div className="bg-white rounded-lg shadow p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-500">Est. Savings</h3>
            <TrendingUp className="h-5 w-5 text-emerald-500" />
          </div>
          <div className="text-2xl font-bold text-emerald-600">
            {stats?.potential_savings_pct ?? 0}%
          </div>
          <p className="text-xs text-gray-500 mt-1">Delivery cost reduction</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-gray-500" />
            <select
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={selectedStore || ''}
              onChange={(e) => setSelectedStore(e.target.value || undefined)}
            >
              <option value="">All Stores</option>
              {storesData.map((store) => (
                <option key={store.store_id} value={store.store_id}>
                  {store.store_name || store.store_id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={showConflictsOnly === true}
                onChange={(e) => setShowConflictsOnly(e.target.checked ? true : undefined)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <AlertTriangle className="h-4 w-4 text-red-500" />
              Conflicts Only
            </label>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={showConflictsOnly === false}
                onChange={(e) => setShowConflictsOnly(e.target.checked ? false : undefined)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Valid Only
            </label>
          </div>

          {isLoading && (
            <div className="ml-auto flex items-center gap-2 text-sm text-gray-500">
              <RefreshCw className="h-4 w-4 animate-spin" />
              Loading...
            </div>
          )}
        </div>
      </div>

      {/* Bundles by Store */}
      <div className="space-y-6">
        {Object.entries(bundlesByStore).map(([storeName, bundles]) => (
          <div key={storeName} className="bg-white rounded-lg shadow">
            <div className="p-4 border-b bg-gray-50 rounded-t-lg">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Store className="h-5 w-5 text-gray-600" />
                  <h3 className="font-semibold text-gray-900">{storeName}</h3>
                  <span className="text-sm text-gray-500">
                    {bundles[0]?.store_zone}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="flex items-center gap-1 text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    {bundles.filter(b => !b.has_conflict).length} valid
                  </span>
                  <span className="flex items-center gap-1 text-red-600">
                    <AlertTriangle className="h-4 w-4" />
                    {bundles.filter(b => b.has_conflict).length} conflicts
                  </span>
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Order A
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Order B
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Bundle Size
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Combined Value
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Conflict
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {bundles.map((bundle, idx) => (
                    <tr
                      key={`${bundle.order_a}-${bundle.order_b}-${idx}`}
                      className={`hover:bg-gray-50 ${bundle.has_conflict ? 'bg-red-50/50' : ''}`}
                    >
                      <td className="px-4 py-3">
                        {bundle.has_conflict ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-700 bg-red-100 rounded-full">
                            <AlertTriangle className="h-3 w-3" />
                            Conflict
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-700 bg-green-100 rounded-full">
                            <CheckCircle2 className="h-3 w-3" />
                            Valid
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-gray-400" />
                          <div>
                            <div className="font-medium text-gray-900">
                              {bundle.order_a_number || bundle.order_a}
                            </div>
                            <div className="text-xs text-gray-500">
                              {bundle.order_a_customer || 'Customer'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Truck className="h-4 w-4 text-gray-400" />
                          <div>
                            <div className="font-medium text-gray-900">
                              {bundle.order_b_number || bundle.order_b}
                            </div>
                            <div className="text-xs text-gray-500">
                              {bundle.order_b_customer || 'Customer'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className="inline-flex items-center justify-center w-8 h-8 text-sm font-bold text-indigo-700 bg-indigo-100 rounded-full">
                          {bundle.bundle_size}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        ${formatAmount((bundle.order_a_total || 0) + (bundle.order_b_total || 0))}
                      </td>
                      <td className="px-4 py-3">
                        {bundle.has_conflict && bundle.conflict_product_name ? (
                          <div className="text-sm">
                            <div className="font-medium text-red-700">
                              {bundle.conflict_product_name}
                            </div>
                            <div className="text-xs text-gray-500">
                              Need {bundle.total_needed}, have {bundle.available_stock}
                            </div>
                          </div>
                        ) : bundle.has_conflict ? (
                          <span className="text-gray-400 text-xs">Inventory conflict</span>
                        ) : (
                          <span className="text-gray-400 text-xs">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* Empty State */}
        {!isLoading && Object.keys(bundlesByStore).length === 0 && (
          <div className="bg-white rounded-lg shadow p-12 text-center">
            <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No Delivery Bundles Found
            </h3>
            <p className="text-gray-500 max-w-md mx-auto">
              Bundles are created when multiple orders from the same store have overlapping
              delivery windows. Try adjusting your filters or check if there are active orders.
            </p>
          </div>
        )}
      </div>

      {/* Footer Explanation */}
      <div className="mt-8 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-start gap-3">
          <GitBranch className="h-5 w-5 text-gray-400 mt-0.5" />
          <div className="text-sm text-gray-600">
            <p className="font-medium text-gray-700 mb-1">About Delivery Bundling</p>
            <p>
              This view uses Materialize's <code className="px-1 bg-white rounded text-xs">WITH MUTUALLY RECURSIVE</code> to
              simultaneously compute bundle candidates and inventory conflicts. The algorithm considers:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1 text-gray-500">
              <li>Orders from the same store with overlapping delivery windows</li>
              <li>Inventory availability across all products in bundled orders</li>
              <li>Transitive conflicts that propagate through bundle chains</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
