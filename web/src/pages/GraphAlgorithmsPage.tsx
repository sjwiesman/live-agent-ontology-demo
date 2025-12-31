import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Package,
  Truck,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ArrowRight,
  ArrowLeftRight,
  RefreshCw,
  Layers,
  Store,
  ShoppingCart,
  Zap,
  Database,
  GitBranch,
  Box,
} from 'lucide-react'
import { graphApi, freshmartApi, DeliveryBundle } from '../api/client'

export default function GraphAlgorithmsPage() {
  const [selectedStore, setSelectedStore] = useState<string>('')
  const [showConflictsOnly, setShowConflictsOnly] = useState(false)
  const [animationStep, setAnimationStep] = useState(0)

  // Fetch delivery bundles
  const { data: bundles, isLoading, refetch } = useQuery({
    queryKey: ['delivery-bundles', selectedStore, showConflictsOnly],
    queryFn: async () => {
      const params: { store_id?: string; show_conflicts?: boolean; limit?: number } = { limit: 100 }
      if (selectedStore) params.store_id = selectedStore
      if (showConflictsOnly) params.show_conflicts = true
      const response = await graphApi.listDeliveryBundles(params)
      return response.data
    },
  })

  // Fetch stores for filter
  const { data: stores } = useQuery({
    queryKey: ['stores-list'],
    queryFn: async () => {
      const response = await freshmartApi.listStores()
      return response.data
    },
  })

  // Animation cycle for the mutual recursion diagram
  useEffect(() => {
    const interval = setInterval(() => {
      setAnimationStep((prev) => (prev + 1) % 4)
    }, 2000)
    return () => clearInterval(interval)
  }, [])

  // Calculate stats
  const validBundles = bundles?.filter((b) => !b.has_conflict) || []
  const conflictBundles = bundles?.filter((b) => b.has_conflict) || []
  const totalBundles = bundles?.length || 0
  const uniqueStores = new Set(bundles?.map((b) => b.store_id)).size

  // Group bundles by store for visualization
  const bundlesByStore = bundles?.reduce((acc, bundle) => {
    if (!acc[bundle.store_id]) acc[bundle.store_id] = []
    acc[bundle.store_id].push(bundle)
    return acc
  }, {} as Record<string, DeliveryBundle[]>) || {}

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Hero Section */}
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-cyan-900/20 via-transparent to-transparent" />
        <div className="relative max-w-7xl mx-auto px-6 py-12">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-cyan-500/10 border border-cyan-500/30 rounded-full text-cyan-400 text-sm mb-6">
              <Zap className="h-4 w-4" />
              Materialize WITH MUTUALLY RECURSIVE
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-4">
              Delivery Bundle Optimization
            </h1>
            <p className="text-xl text-slate-400 max-w-3xl mx-auto">
              Real-time conflict detection using <span className="text-cyan-400 font-semibold">mutual recursion</span> —
              a computation pattern impossible in standard SQL
            </p>
          </div>

          {/* The Problem Statement */}
          <div className="grid md:grid-cols-2 gap-6 mb-12">
            <div className="bg-red-950/30 border border-red-500/30 rounded-xl p-6">
              <div className="flex items-center gap-2 text-red-400 mb-4">
                <XCircle className="h-5 w-5" />
                <span className="font-semibold">Standard SQL Limitation</span>
              </div>
              <p className="text-slate-300 text-sm mb-4">
                WITH RECURSIVE only allows a CTE to reference <span className="text-red-400">itself</span>.
                You cannot have two CTEs that depend on each other.
              </p>
              <pre className="bg-slate-950/50 rounded-lg p-3 text-xs text-slate-400 overflow-x-auto">
{`-- ❌ This is ILLEGAL in standard SQL:
WITH RECURSIVE
  bundles AS (
    ... NOT EXISTS (SELECT FROM conflicts) ...
  ),
  conflicts AS (
    ... JOIN bundles ...  -- ERROR!
  )`}
              </pre>
            </div>

            <div className="bg-emerald-950/30 border border-emerald-500/30 rounded-xl p-6">
              <div className="flex items-center gap-2 text-emerald-400 mb-4">
                <CheckCircle className="h-5 w-5" />
                <span className="font-semibold">Materialize Solution</span>
              </div>
              <p className="text-slate-300 text-sm mb-4">
                WITH MUTUALLY RECURSIVE allows CTEs to reference <span className="text-emerald-400">each other</span>,
                evaluated together until a fixed point is reached.
              </p>
              <pre className="bg-slate-950/50 rounded-lg p-3 text-xs text-emerald-400 overflow-x-auto">
{`-- ✅ Materialize supports this:
WITH MUTUALLY RECURSIVE
  bundles AS (
    ... NOT EXISTS (SELECT FROM conflicts) ...
  ),
  conflicts AS (
    ... JOIN bundles ...  -- WORKS!
  )`}
              </pre>
            </div>
          </div>

          {/* Animated Mutual Recursion Diagram */}
          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8 mb-12">
            <h2 className="text-lg font-semibold text-white text-center mb-6">
              How Mutual Recursion Works
            </h2>
            <div className="flex items-center justify-center gap-8">
              {/* Bundle Candidates Box */}
              <div className={`relative transition-all duration-500 ${
                animationStep === 0 || animationStep === 2
                  ? 'scale-110 ring-2 ring-cyan-400'
                  : 'scale-100'
              }`}>
                <div className="bg-gradient-to-br from-cyan-600 to-cyan-800 rounded-xl p-6 w-64">
                  <div className="flex items-center gap-2 text-white mb-3">
                    <Layers className="h-5 w-5" />
                    <span className="font-semibold">bundle_candidates</span>
                  </div>
                  <p className="text-cyan-100 text-xs">
                    Orders that can be delivered together
                  </p>
                  <div className="mt-3 pt-3 border-t border-cyan-500/30 text-xs text-cyan-200">
                    <code>NOT EXISTS (conflicts)</code>
                  </div>
                </div>
                {(animationStep === 1 || animationStep === 2) && (
                  <div className="absolute -bottom-8 left-1/2 transform -translate-x-1/2 text-cyan-400 animate-bounce">
                    ↓ reads from
                  </div>
                )}
              </div>

              {/* Bidirectional Arrow */}
              <div className="flex flex-col items-center gap-2">
                <ArrowLeftRight className={`h-12 w-12 transition-all duration-300 ${
                  animationStep === 1 ? 'text-amber-400 scale-125' :
                  animationStep === 3 ? 'text-cyan-400 scale-125' :
                  'text-slate-500'
                }`} />
                <span className="text-slate-400 text-xs">mutual reference</span>
              </div>

              {/* Inventory Conflicts Box */}
              <div className={`relative transition-all duration-500 ${
                animationStep === 1 || animationStep === 3
                  ? 'scale-110 ring-2 ring-amber-400'
                  : 'scale-100'
              }`}>
                <div className="bg-gradient-to-br from-amber-600 to-amber-800 rounded-xl p-6 w-64">
                  <div className="flex items-center gap-2 text-white mb-3">
                    <AlertTriangle className="h-5 w-5" />
                    <span className="font-semibold">inventory_conflicts</span>
                  </div>
                  <p className="text-amber-100 text-xs">
                    Orders competing for scarce inventory
                  </p>
                  <div className="mt-3 pt-3 border-t border-amber-500/30 text-xs text-amber-200">
                    <code>JOIN bundle_candidates</code>
                  </div>
                </div>
                {(animationStep === 0 || animationStep === 3) && (
                  <div className="absolute -bottom-8 left-1/2 transform -translate-x-1/2 text-amber-400 animate-bounce">
                    ↓ reads from
                  </div>
                )}
              </div>
            </div>

            <div className="mt-12 text-center">
              <div className="inline-flex items-center gap-3 px-6 py-3 bg-slate-700/50 rounded-full">
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
                  <span className="text-slate-300 text-sm">Iteration {animationStep + 1}/4</span>
                </div>
                <ArrowRight className="h-4 w-4 text-slate-500" />
                <span className="text-slate-400 text-sm">Evaluating until fixed point...</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Live Data Section */}
      <div className="max-w-7xl mx-auto px-6 pb-12">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center gap-2 text-cyan-400 mb-2">
              <Truck className="h-5 w-5" />
              <span className="text-sm font-medium">Valid Bundles</span>
            </div>
            <div className="text-3xl font-bold text-white">{validBundles.length}</div>
            <p className="text-slate-500 text-xs mt-1">Ready for delivery</p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center gap-2 text-amber-400 mb-2">
              <AlertTriangle className="h-5 w-5" />
              <span className="text-sm font-medium">Conflicts</span>
            </div>
            <div className="text-3xl font-bold text-white">{conflictBundles.length}</div>
            <p className="text-slate-500 text-xs mt-1">Inventory issues detected</p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center gap-2 text-emerald-400 mb-2">
              <Store className="h-5 w-5" />
              <span className="text-sm font-medium">Stores</span>
            </div>
            <div className="text-3xl font-bold text-white">{uniqueStores}</div>
            <p className="text-slate-500 text-xs mt-1">With active bundles</p>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center gap-2 text-purple-400 mb-2">
              <Database className="h-5 w-5" />
              <span className="text-sm font-medium">Total Pairs</span>
            </div>
            <div className="text-3xl font-bold text-white">{totalBundles}</div>
            <p className="text-slate-500 text-xs mt-1">Order combinations</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <select
            value={selectedStore}
            onChange={(e) => setSelectedStore(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white text-sm focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
          >
            <option value="">All Stores</option>
            {stores?.map((store) => (
              <option key={store.store_id} value={store.store_id}>
                {store.store_name}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showConflictsOnly}
              onChange={(e) => setShowConflictsOnly(e.target.checked)}
              className="rounded border-slate-600 bg-slate-800 text-amber-500 focus:ring-amber-500"
            />
            <span className="text-slate-300 text-sm">Show conflicts only</span>
          </label>

          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        {/* Bundle Visualization by Store */}
        {isLoading ? (
          <div className="text-center py-12">
            <RefreshCw className="h-8 w-8 text-cyan-400 animate-spin mx-auto mb-4" />
            <p className="text-slate-400">Computing bundles with mutual recursion...</p>
          </div>
        ) : totalBundles === 0 ? (
          <div className="text-center py-12 bg-slate-800/30 rounded-xl border border-slate-700">
            <Package className="h-12 w-12 text-slate-600 mx-auto mb-4" />
            <p className="text-slate-400">No bundles found</p>
            <p className="text-slate-500 text-sm">Orders need overlapping delivery windows to bundle</p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(bundlesByStore).map(([storeId, storeBundles]) => {
              const storeName = stores?.find((s) => s.store_id === storeId)?.store_name || storeId
              const storeValidBundles = storeBundles.filter((b) => !b.has_conflict)
              const storeConflicts = storeBundles.filter((b) => b.has_conflict)

              return (
                <div
                  key={storeId}
                  className="bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden"
                >
                  {/* Store Header */}
                  <div className="px-6 py-4 bg-slate-800 border-b border-slate-700 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Store className="h-5 w-5 text-cyan-400" />
                      <span className="font-semibold text-white">{storeName}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-emerald-400">
                        {storeValidBundles.length} valid
                      </span>
                      {storeConflicts.length > 0 && (
                        <span className="text-amber-400">
                          {storeConflicts.length} conflicts
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Bundles Grid */}
                  <div className="p-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {storeBundles.slice(0, 12).map((bundle, idx) => (
                        <div
                          key={`${bundle.order_a}-${bundle.order_b}-${idx}`}
                          className={`relative rounded-lg p-4 border transition-all hover:scale-[1.02] ${
                            bundle.has_conflict
                              ? 'bg-amber-950/30 border-amber-500/30 hover:border-amber-500/50'
                              : 'bg-emerald-950/30 border-emerald-500/30 hover:border-emerald-500/50'
                          }`}
                        >
                          {/* Bundle Status Badge */}
                          <div className="absolute top-3 right-3">
                            {bundle.has_conflict ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-amber-500/20 text-amber-400 rounded-full text-xs">
                                <AlertTriangle className="h-3 w-3" />
                                Conflict
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-500/20 text-emerald-400 rounded-full text-xs">
                                <CheckCircle className="h-3 w-3" />
                                OK
                              </span>
                            )}
                          </div>

                          {/* Order Pair Visualization */}
                          <div className="flex items-center gap-3 mb-3">
                            <div className="flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 py-2">
                              <ShoppingCart className="h-4 w-4 text-cyan-400" />
                              <span className="text-white text-sm font-mono">
                                {bundle.order_a.split(':')[1]?.slice(0, 8) || bundle.order_a.slice(0, 8)}
                              </span>
                            </div>
                            <GitBranch className="h-4 w-4 text-slate-500 rotate-90" />
                            <div className="flex items-center gap-2 bg-slate-800/50 rounded-lg px-3 py-2">
                              <ShoppingCart className="h-4 w-4 text-purple-400" />
                              <span className="text-white text-sm font-mono">
                                {bundle.order_b.split(':')[1]?.slice(0, 8) || bundle.order_b.slice(0, 8)}
                              </span>
                            </div>
                          </div>

                          {/* Bundle Info */}
                          <div className="flex items-center gap-4 text-xs text-slate-400">
                            <span className="flex items-center gap-1">
                              <Box className="h-3 w-3" />
                              Size: {bundle.bundle_size}
                            </span>
                          </div>

                          {/* Conflict Details */}
                          {bundle.has_conflict && bundle.conflict_product && (
                            <div className="mt-3 pt-3 border-t border-amber-500/20">
                              <p className="text-amber-400 text-xs">
                                <span className="font-semibold">Product:</span>{' '}
                                {bundle.conflict_product.split(':')[1] || bundle.conflict_product}
                              </p>
                              <p className="text-amber-300/70 text-xs mt-1">
                                Need {bundle.total_needed} units, only {bundle.available_stock} in stock
                              </p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {storeBundles.length > 12 && (
                      <p className="text-center text-slate-500 text-sm mt-4">
                        +{storeBundles.length - 12} more bundles
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Technical Deep Dive */}
        <div className="mt-12 bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden">
          <div className="px-6 py-4 bg-slate-800 border-b border-slate-700">
            <h2 className="text-lg font-semibold text-white">The Datalog Behind the Magic</h2>
          </div>
          <div className="p-6">
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-cyan-400 font-semibold mb-3">Datalog Rules</h3>
                <pre className="bg-slate-950/50 rounded-lg p-4 text-xs text-slate-300 overflow-x-auto">
{`can_bundle(O1, O2) :-
  same_store(O1, O2),
  compatible_time(O1, O2),
  NOT has_conflict(O1, O2).

can_bundle(O1, O3) :-
  can_bundle(O1, O2),
  can_bundle(O2, O3),
  NOT has_conflict(O1, O3).

has_conflict(O1, O2) :-
  shares_product(O1, O2, P),
  insufficient_stock(P).

has_conflict(O1, O3) :-
  has_conflict(O1, O2),
  can_bundle(O2, O3).`}
                </pre>
              </div>
              <div>
                <h3 className="text-emerald-400 font-semibold mb-3">Why It Matters</h3>
                <ul className="space-y-3 text-sm text-slate-300">
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <span>
                      <strong className="text-white">Chicken-and-egg problem:</strong> Valid bundles depend on conflicts,
                      but conflicts propagate through bundles
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <span>
                      <strong className="text-white">Fixed-point semantics:</strong> Materialize iterates until
                      bundles and conflicts stabilize together
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <span>
                      <strong className="text-white">Incremental updates:</strong> When orders or inventory change,
                      only affected bundles recompute
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    <span>
                      <strong className="text-white">Always consistent:</strong> Bundles and conflicts stay in sync —
                      no race conditions possible
                    </span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
