import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  Info,
  Store,
  ShoppingCart,
  User,
  Truck,
  Package,
  GitBranch,
  RefreshCw,
  Users,
  TrendingUp,
  Layers,
  Link,
  Zap,
} from 'lucide-react'
import {
  graphApi,
  freshmartApi,
  SupplyChainRisk,
  CustomerCohort,
  InfluenceScore,
  DeliveryBundle,
} from '../api/client'

const riskColors: Record<string, string> = {
  CRITICAL: 'bg-red-100 text-red-800 border-red-300',
  HIGH: 'bg-orange-100 text-orange-800 border-orange-300',
  MEDIUM: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  LOW: 'bg-green-100 text-green-800 border-green-300',
}

const riskIcons: Record<string, typeof AlertTriangle> = {
  CRITICAL: AlertCircle,
  HIGH: AlertTriangle,
  MEDIUM: Info,
  LOW: CheckCircle,
}

const entityIcons: Record<string, typeof Store> = {
  Store: Store,
  Order: ShoppingCart,
  Customer: User,
  DeliveryTask: Truck,
}

function RiskBadge({ level }: { level: string }) {
  const Icon = riskIcons[level] || Info
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${riskColors[level] || 'bg-gray-100 text-gray-800'}`}>
      <Icon className="h-3 w-3" />
      {level}
    </span>
  )
}

function EntityIcon({ type }: { type: string }) {
  const Icon = entityIcons[type] || Package
  return <Icon className="h-4 w-4" />
}

type TabType = 'risk' | 'fulfillment' | 'cohorts' | 'influence' | 'bundles'

export default function GraphAlgorithmsPage() {
  const [selectedOrderId, setSelectedOrderId] = useState<string>('')
  const [activeTab, setActiveTab] = useState<TabType>('cohorts')
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('')
  const [riskLevelFilter, setRiskLevelFilter] = useState<string>('')
  const [influenceTypeFilter, setInfluenceTypeFilter] = useState<string>('')
  const [bundleStoreFilter, setBundleStoreFilter] = useState<string>('')
  const [showConflictsOnly, setShowConflictsOnly] = useState<boolean>(false)

  // Fetch supply chain risks
  const { data: risks, isLoading: risksLoading, refetch: refetchRisks } = useQuery({
    queryKey: ['supply-chain-risks', entityTypeFilter, riskLevelFilter],
    queryFn: async () => {
      const params: { entity_type?: string; risk_level?: string } = {}
      if (entityTypeFilter) params.entity_type = entityTypeFilter
      if (riskLevelFilter) params.risk_level = riskLevelFilter
      const response = await graphApi.listRisks(params)
      return response.data
    },
    enabled: activeTab === 'risk',
  })

  // Fetch store risk levels
  const { data: storeRisks, isLoading: storeRisksLoading } = useQuery({
    queryKey: ['store-risks'],
    queryFn: async () => {
      const response = await graphApi.listStoreRisks()
      return response.data
    },
    enabled: activeTab === 'risk',
  })

  // Fetch orders for fulfillment analysis dropdown
  const { data: orders } = useQuery({
    queryKey: ['orders-for-fulfillment'],
    queryFn: async () => {
      const response = await freshmartApi.listOrders({ status: 'CREATED' })
      return response.data
    },
    enabled: activeTab === 'fulfillment',
  })

  // Fetch fulfillment analysis for selected order
  const { data: fulfillmentAnalysis, isLoading: fulfillmentLoading } = useQuery({
    queryKey: ['fulfillment-analysis', selectedOrderId],
    queryFn: async () => {
      if (!selectedOrderId) return null
      const response = await graphApi.analyzeOrderFulfillment(selectedOrderId)
      return response.data
    },
    enabled: !!selectedOrderId && activeTab === 'fulfillment',
  })

  // Fetch customer cohorts
  const { data: cohorts, isLoading: cohortsLoading, refetch: refetchCohorts } = useQuery({
    queryKey: ['customer-cohorts'],
    queryFn: async () => {
      const response = await graphApi.listCustomerCohorts({ limit: 50 })
      return response.data
    },
    enabled: activeTab === 'cohorts',
  })

  // Fetch influence scores
  const { data: influenceScores, isLoading: influenceLoading, refetch: refetchInfluence } = useQuery({
    queryKey: ['influence-scores', influenceTypeFilter],
    queryFn: async () => {
      const params: { entity_type?: string; limit?: number } = { limit: 50 }
      if (influenceTypeFilter) params.entity_type = influenceTypeFilter
      const response = await graphApi.listInfluenceScores(params)
      return response.data
    },
    enabled: activeTab === 'influence',
  })

  // Fetch delivery bundles
  const { data: bundles, isLoading: bundlesLoading, refetch: refetchBundles } = useQuery({
    queryKey: ['delivery-bundles', bundleStoreFilter, showConflictsOnly],
    queryFn: async () => {
      const params: { store_id?: string; show_conflicts?: boolean; limit?: number } = { limit: 100 }
      if (bundleStoreFilter) params.store_id = bundleStoreFilter
      if (showConflictsOnly) params.show_conflicts = true
      const response = await graphApi.listDeliveryBundles(params)
      return response.data
    },
    enabled: activeTab === 'bundles',
  })

  // Fetch stores for bundle filter
  const { data: stores } = useQuery({
    queryKey: ['stores-for-bundles'],
    queryFn: async () => {
      const response = await freshmartApi.listStores()
      return response.data
    },
    enabled: activeTab === 'bundles',
  })

  // Group risks by entity type
  const risksByType = (risks || []).reduce((acc, risk) => {
    if (!acc[risk.entity_type]) acc[risk.entity_type] = []
    acc[risk.entity_type].push(risk)
    return acc
  }, {} as Record<string, SupplyChainRisk[]>)

  // Count risks by level
  const riskCounts = (risks || []).reduce((acc, risk) => {
    acc[risk.risk_level] = (acc[risk.risk_level] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  // Group cohorts by unique customer pairs
  const cohortPairs = (cohorts || []).reduce((acc, cohort) => {
    const key = [cohort.customer_a, cohort.customer_b].sort().join('|')
    if (!acc.has(key)) {
      acc.set(key, cohort)
    }
    return acc
  }, new Map<string, CustomerCohort>())

  // Split influence scores by type
  const customerScores = (influenceScores || []).filter(s => s.entity_type === 'customer')
  const productScores = (influenceScores || []).filter(s => s.entity_type === 'product')

  // Count bundle conflicts
  const conflictCount = (bundles || []).filter(b => b.has_conflict).length
  const totalBundles = (bundles || []).length

  const tabs: { id: TabType; label: string; icon: typeof AlertTriangle; description: string }[] = [
    { id: 'cohorts', label: 'Customer Cohorts', icon: Users, description: 'Bidirectional Reachability (SCC)' },
    { id: 'influence', label: 'Influence Scores', icon: TrendingUp, description: 'PageRank-style Mutual Scoring' },
    { id: 'bundles', label: 'Delivery Bundles', icon: Layers, description: 'Conflict Detection' },
    { id: 'risk', label: 'Risk Propagation', icon: AlertTriangle, description: 'Transitive Risk' },
    { id: 'fulfillment', label: 'Split Fulfillment', icon: GitBranch, description: 'Multi-Store Coverage' },
  ]

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Graph Algorithms</h1>
        <p className="text-gray-600 mt-1">
          Mutually recursive datalog-style algorithms using Materialize <code className="bg-gray-100 px-1 rounded">WITH MUTUALLY RECURSIVE</code>
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-6 overflow-x-auto">
          {tabs.map(({ id, label, icon: Icon, description }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`py-2 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === id
                  ? 'border-green-500 text-green-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              <Icon className="h-4 w-4 inline mr-2" />
              {label}
              <span className="block text-xs font-normal text-gray-400">{description}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Customer Cohorts Tab */}
      {activeTab === 'cohorts' && (
        <div className="space-y-6">
          {/* Explanation */}
          <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg p-4 border border-purple-200">
            <div className="flex items-start gap-3">
              <Users className="h-6 w-6 text-purple-600 mt-1" />
              <div>
                <h3 className="font-semibold text-purple-900">Bidirectional Reachability (Strongly Connected Components)</h3>
                <p className="text-sm text-purple-700 mt-1">
                  Finds customers who can reach each other through shared product purchases. Uses <strong>two mutually recursive CTEs</strong>:
                  <code className="mx-1 bg-purple-100 px-1 rounded">forward_reach</code> and <code className="bg-purple-100 px-1 rounded">backward_reach</code>
                  that reference each other to compute bidirectional paths.
                </p>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center gap-2 text-purple-600 mb-2">
                <Users className="h-5 w-5" />
                <span className="font-medium">Customer Pairs</span>
              </div>
              <p className="text-3xl font-bold">{cohortPairs.size}</p>
              <p className="text-sm text-gray-500">bidirectionally connected</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center gap-2 text-indigo-600 mb-2">
                <Link className="h-5 w-5" />
                <span className="font-medium">Avg Distance</span>
              </div>
              <p className="text-3xl font-bold">
                {cohorts && cohorts.length > 0
                  ? (cohorts.reduce((sum, c) => sum + c.min_distance, 0) / cohorts.length).toFixed(1)
                  : '-'}
              </p>
              <p className="text-sm text-gray-500">hops between pairs</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center gap-2 text-green-600 mb-2">
                <Zap className="h-5 w-5" />
                <span className="font-medium">Algorithm</span>
              </div>
              <p className="text-lg font-bold">Mutual Recursion</p>
              <p className="text-sm text-gray-500">forward ↔ backward reach</p>
            </div>
          </div>

          {/* Cohort Network Visualization */}
          <div className="bg-white rounded-lg shadow">
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Customer Cohort Network</h2>
                <p className="text-sm text-gray-500">Customers connected through shared purchase patterns</p>
              </div>
              <button
                onClick={() => refetchCohorts()}
                className="p-2 text-gray-500 hover:text-gray-700"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              {cohortsLoading ? (
                <p className="text-gray-500">Computing bidirectional reachability...</p>
              ) : cohorts?.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No customer cohorts found</p>
                  <p className="text-sm">Customers need shared purchase history to form cohorts</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer A</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Connection</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer B</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Forward Hops</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Backward Hops</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Min Distance</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {Array.from(cohortPairs.values()).map((cohort, idx) => (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4 text-purple-500" />
                              <span className="text-sm font-mono">{cohort.customer_a}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-center">
                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-800 rounded-full text-xs">
                              <span>↔</span>
                              {cohort.connection_type}
                            </span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <User className="h-4 w-4 text-indigo-500" />
                              <span className="text-sm font-mono">{cohort.customer_b}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-center">
                            <span className="text-sm text-gray-600">{cohort.forward_hops} →</span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-center">
                            <span className="text-sm text-gray-600">← {cohort.backward_hops}</span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-center">
                            <span className="inline-flex items-center justify-center h-6 w-6 bg-gray-100 rounded-full text-sm font-medium">
                              {cohort.min_distance}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Algorithm Explanation */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-medium mb-2">Mutually Recursive SQL Pattern</h3>
            <pre className="text-xs bg-gray-800 text-green-400 p-3 rounded overflow-x-auto">
{`WITH MUTUALLY RECURSIVE
  forward_reach(from_cust, to_cust, hops) AS (
    -- Base: direct connections
    SELECT customer_id, other_customer, 1 FROM customer_product_edges
    UNION
    -- Recursive: extend path if backward path exists
    SELECT f.from_cust, e.other_customer, f.hops + 1
    FROM forward_reach f
    JOIN customer_product_edges e ON e.customer_id = f.to_cust
    WHERE f.hops < 5
      AND EXISTS (SELECT 1 FROM backward_reach b  -- ← MUTUAL REFERENCE
                  WHERE b.from_cust = f.from_cust)
  ),
  backward_reach(from_cust, to_cust, hops) AS (
    -- Base: direct connections (reversed)
    SELECT other_customer, customer_id, 1 FROM customer_product_edges
    UNION
    -- Recursive: extend path if forward path exists
    SELECT b.from_cust, e.customer_id, b.hops + 1
    FROM backward_reach b
    JOIN customer_product_edges e ON e.other_customer = b.to_cust
    WHERE b.hops < 5
      AND EXISTS (SELECT 1 FROM forward_reach f  -- ← MUTUAL REFERENCE
                  WHERE f.from_cust = b.from_cust)
  )
SELECT ... FROM forward_reach f JOIN backward_reach b ...`}
            </pre>
          </div>
        </div>
      )}

      {/* Influence Scores Tab */}
      {activeTab === 'influence' && (
        <div className="space-y-6">
          {/* Explanation */}
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-lg p-4 border border-amber-200">
            <div className="flex items-start gap-3">
              <TrendingUp className="h-6 w-6 text-amber-600 mt-1" />
              <div>
                <h3 className="font-semibold text-amber-900">PageRank-Style Mutual Scoring</h3>
                <p className="text-sm text-amber-700 mt-1">
                  Computes influence scores where <strong>customer scores depend on product scores</strong> and vice versa.
                  Uses two CTEs (<code className="mx-1 bg-amber-100 px-1 rounded">customer_score</code> and
                  <code className="ml-1 bg-amber-100 px-1 rounded">product_score</code>) that iterate together until convergence.
                </p>
              </div>
            </div>
          </div>

          {/* Filter */}
          <div className="flex gap-4">
            <select
              value={influenceTypeFilter}
              onChange={(e) => setInfluenceTypeFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              <option value="">All Entities</option>
              <option value="customer">Customers Only</option>
              <option value="product">Products Only</option>
            </select>
            <button
              onClick={() => refetchInfluence()}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md flex items-center gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>

          {/* Side by Side Comparison */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Customer Scores */}
            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b border-gray-200 bg-amber-50">
                <div className="flex items-center gap-2">
                  <User className="h-5 w-5 text-amber-600" />
                  <h2 className="text-lg font-semibold text-amber-900">Customer Influence</h2>
                </div>
                <p className="text-sm text-amber-700">Derived from products they purchase</p>
              </div>
              <div className="p-4">
                {influenceLoading ? (
                  <p className="text-gray-500">Computing influence scores...</p>
                ) : customerScores.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">No customer scores available</p>
                ) : (
                  <div className="space-y-3">
                    {customerScores.slice(0, 10).map((score, idx) => (
                      <div key={score.entity_id} className="flex items-center gap-3">
                        <span className="text-sm font-medium text-gray-400 w-6">{idx + 1}</span>
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-mono">{score.entity_id}</span>
                            <span className="text-sm font-bold text-amber-600">
                              {score.influence_score.toFixed(4)}
                            </span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-amber-500 rounded-full"
                              style={{
                                width: `${Math.min(100, score.influence_score * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Product Scores */}
            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b border-gray-200 bg-orange-50">
                <div className="flex items-center gap-2">
                  <Package className="h-5 w-5 text-orange-600" />
                  <h2 className="text-lg font-semibold text-orange-900">Product Quality</h2>
                </div>
                <p className="text-sm text-orange-700">Derived from customers who purchase them</p>
              </div>
              <div className="p-4">
                {influenceLoading ? (
                  <p className="text-gray-500">Computing quality scores...</p>
                ) : productScores.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">No product scores available</p>
                ) : (
                  <div className="space-y-3">
                    {productScores.slice(0, 10).map((score, idx) => (
                      <div key={score.entity_id} className="flex items-center gap-3">
                        <span className="text-sm font-medium text-gray-400 w-6">{idx + 1}</span>
                        <div className="flex-1">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-mono">{score.entity_id}</span>
                            <span className="text-sm font-bold text-orange-600">
                              {score.influence_score.toFixed(4)}
                            </span>
                          </div>
                          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-orange-500 rounded-full"
                              style={{
                                width: `${Math.min(100, score.influence_score * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Algorithm Explanation */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-medium mb-2">PageRank-Style Mutual Recursion</h3>
            <pre className="text-xs bg-gray-800 text-green-400 p-3 rounded overflow-x-auto">
{`WITH MUTUALLY RECURSIVE
  customer_score(customer_id, score, iteration) AS (
    -- Base: equal initial scores
    SELECT customer_id, 1.0 / COUNT(*) OVER (), 0 FROM customers
    UNION
    -- Recursive: score from products purchased
    SELECT cs.customer_id,
           0.15 + 0.85 * AVG(ps.score),  -- PageRank damping
           cs.iteration + 1
    FROM customer_score cs
    JOIN purchases p ON p.customer_id = cs.customer_id
    JOIN product_score ps ON ps.product_id = p.product_id  -- ← MUTUAL REFERENCE
    WHERE cs.iteration < 10
    GROUP BY cs.customer_id, cs.iteration
  ),
  product_score(product_id, score, iteration) AS (
    -- Base: equal initial scores
    SELECT product_id, 1.0 / COUNT(*) OVER (), 0 FROM products
    UNION
    -- Recursive: score from customers who purchased
    SELECT ps.product_id,
           0.15 + 0.85 * AVG(cs.score),  -- PageRank damping
           ps.iteration + 1
    FROM product_score ps
    JOIN purchases p ON p.product_id = ps.product_id
    JOIN customer_score cs ON cs.customer_id = p.customer_id  -- ← MUTUAL REFERENCE
    WHERE ps.iteration < 10
    GROUP BY ps.product_id, ps.iteration
  )
SELECT * FROM customer_score WHERE iteration = 10 ...`}
            </pre>
          </div>
        </div>
      )}

      {/* Delivery Bundles Tab */}
      {activeTab === 'bundles' && (
        <div className="space-y-6">
          {/* Explanation */}
          <div className="bg-gradient-to-r from-cyan-50 to-blue-50 rounded-lg p-4 border border-cyan-200">
            <div className="flex items-start gap-3">
              <Layers className="h-6 w-6 text-cyan-600 mt-1" />
              <div>
                <h3 className="font-semibold text-cyan-900">Delivery Bundle Conflict Detection</h3>
                <p className="text-sm text-cyan-700 mt-1">
                  Finds orders that can be bundled for delivery and detects inventory conflicts.
                  Uses mutually recursive CTEs where <code className="mx-1 bg-cyan-100 px-1 rounded">bundle_candidates</code>
                  excludes pairs from <code className="bg-cyan-100 px-1 rounded">inventory_conflicts</code>, which itself
                  expands through bundles.
                </p>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center gap-2 text-cyan-600 mb-2">
                <Layers className="h-5 w-5" />
                <span className="font-medium">Total Bundles</span>
              </div>
              <p className="text-3xl font-bold">{totalBundles}</p>
              <p className="text-sm text-gray-500">order pairs found</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center gap-2 text-green-600 mb-2">
                <CheckCircle className="h-5 w-5" />
                <span className="font-medium">No Conflict</span>
              </div>
              <p className="text-3xl font-bold">{totalBundles - conflictCount}</p>
              <p className="text-sm text-gray-500">safe to bundle</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center gap-2 text-red-600 mb-2">
                <AlertCircle className="h-5 w-5" />
                <span className="font-medium">Conflicts</span>
              </div>
              <p className="text-3xl font-bold">{conflictCount}</p>
              <p className="text-sm text-gray-500">inventory issues</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4">
              <div className="flex items-center gap-2 text-blue-600 mb-2">
                <Store className="h-5 w-5" />
                <span className="font-medium">Stores</span>
              </div>
              <p className="text-3xl font-bold">{stores?.length || 0}</p>
              <p className="text-sm text-gray-500">with bundles</p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-4">
            <select
              value={bundleStoreFilter}
              onChange={(e) => setBundleStoreFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
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
                className="rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span className="text-sm">Show conflicts only</span>
            </label>
            <button
              onClick={() => refetchBundles()}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md flex items-center gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>

          {/* Bundles Table */}
          <div className="bg-white rounded-lg shadow">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-lg font-semibold">Delivery Bundle Analysis</h2>
            </div>
            <div className="overflow-x-auto">
              {bundlesLoading ? (
                <div className="p-4 text-gray-500">Analyzing delivery bundles...</div>
              ) : bundles?.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <Layers className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No bundles found</p>
                  <p className="text-sm">Orders need shared stores and time windows to bundle</p>
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order A</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Order B</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Store</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Bundle Size</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Conflict Details</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {bundles?.map((bundle, idx) => (
                      <tr
                        key={idx}
                        className={`hover:bg-gray-50 ${bundle.has_conflict ? 'bg-red-50' : ''}`}
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <ShoppingCart className="h-4 w-4 text-cyan-500" />
                            <span className="text-sm font-mono">{bundle.order_a}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <ShoppingCart className="h-4 w-4 text-blue-500" />
                            <span className="text-sm font-mono">{bundle.order_b}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <Store className="h-4 w-4 text-gray-400" />
                            <span className="text-sm font-mono">{bundle.store_id}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center">
                          <span className="inline-flex items-center justify-center h-6 w-6 bg-gray-100 rounded-full text-sm font-medium">
                            {bundle.bundle_size}
                          </span>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-center">
                          {bundle.has_conflict ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-red-100 text-red-800 rounded-full text-xs font-medium">
                              <AlertCircle className="h-3 w-3" />
                              CONFLICT
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-1 bg-green-100 text-green-800 rounded-full text-xs font-medium">
                              <CheckCircle className="h-3 w-3" />
                              OK
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {bundle.has_conflict && bundle.conflict_product ? (
                            <span className="text-red-600">
                              {bundle.conflict_product}: need {bundle.total_needed}, have {bundle.available_stock}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Algorithm Explanation */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-medium mb-2">Conflict Detection via Mutual Recursion</h3>
            <pre className="text-xs bg-gray-800 text-green-400 p-3 rounded overflow-x-auto">
{`WITH MUTUALLY RECURSIVE
  bundle_candidates(order_a, order_b, store_id, size) AS (
    -- Base: orders from same store, overlapping windows
    SELECT o1.order_id, o2.order_id, o1.store_id, 2
    FROM orders o1 JOIN orders o2 ON o1.store_id = o2.store_id
    WHERE o1.order_id < o2.order_id
      AND o1.delivery_window && o2.delivery_window
      AND NOT EXISTS (  -- ← MUTUAL REFERENCE: exclude conflicts
          SELECT 1 FROM inventory_conflicts ic
          WHERE ic.order_a = o1.order_id AND ic.order_b = o2.order_id
      )
    ...
  ),
  inventory_conflicts(order_a, order_b, product, needed, available) AS (
    -- Base: direct conflicts
    SELECT bc.order_a, bc.order_b, li.product_id, total_qty, stock
    FROM bundle_candidates bc  -- ← MUTUAL REFERENCE: check bundles
    JOIN line_items li ON li.order_id IN (bc.order_a, bc.order_b)
    JOIN inventory i ON i.store_id = bc.store_id AND i.product_id = li.product_id
    WHERE total_qty > stock
    UNION
    -- Recursive: conflicts propagate through bundles
    SELECT bc.order_a, bc.order_b, ic.product, ic.needed, ic.available
    FROM inventory_conflicts ic
    JOIN bundle_candidates bc ON bc.order_b = ic.order_a  -- ← MUTUAL REFERENCE
  )
SELECT * FROM bundle_candidates bc LEFT JOIN inventory_conflicts ic ...`}
            </pre>
          </div>
        </div>
      )}

      {/* Risk Propagation Tab */}
      {activeTab === 'risk' && (
        <div className="space-y-6">
          {/* Risk Summary */}
          <div className="grid grid-cols-4 gap-4">
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((level) => (
              <div
                key={level}
                className={`p-4 rounded-lg border ${riskColors[level]} cursor-pointer ${
                  riskLevelFilter === level ? 'ring-2 ring-offset-2 ring-gray-500' : ''
                }`}
                onClick={() => setRiskLevelFilter(riskLevelFilter === level ? '' : level)}
              >
                <div className="flex items-center justify-between">
                  <RiskBadge level={level} />
                  <span className="text-2xl font-bold">{riskCounts[level] || 0}</span>
                </div>
                <p className="text-sm mt-2">entities at {level.toLowerCase()} risk</p>
              </div>
            ))}
          </div>

          {/* Store Risk Levels */}
          <div className="bg-white rounded-lg shadow">
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Store Risk Levels (Risk Sources)</h2>
              <button
                onClick={() => refetchRisks()}
                className="p-2 text-gray-500 hover:text-gray-700"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4">
              {storeRisksLoading ? (
                <p className="text-gray-500">Loading store risks...</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                  {storeRisks?.map((store) => (
                    <div
                      key={store.store_id}
                      className={`p-4 rounded-lg border ${riskColors[store.risk_level] || 'bg-gray-50'}`}
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <Store className="h-4 w-4" />
                        <span className="font-medium truncate">{store.store_name}</span>
                      </div>
                      <div className="text-sm space-y-1">
                        <p>Status: {store.store_status}</p>
                        <p>Active Orders: {store.active_orders}</p>
                        <p>Capacity: {store.store_capacity_orders_per_hour}/hr</p>
                      </div>
                      <div className="mt-2">
                        <RiskBadge level={store.risk_level} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-4">
            <select
              value={entityTypeFilter}
              onChange={(e) => setEntityTypeFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              <option value="">All Entity Types</option>
              <option value="Store">Store</option>
              <option value="Order">Order</option>
              <option value="Customer">Customer</option>
              <option value="DeliveryTask">DeliveryTask</option>
            </select>
            <select
              value={riskLevelFilter}
              onChange={(e) => setRiskLevelFilter(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              <option value="">All Risk Levels</option>
              <option value="CRITICAL">Critical</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
          </div>

          {/* Risk Propagation Results */}
          <div className="bg-white rounded-lg shadow">
            <div className="px-4 py-3 border-b border-gray-200">
              <h2 className="text-lg font-semibold">Propagated Risks</h2>
              <p className="text-sm text-gray-500">
                Risks propagate from stores → orders → customers/tasks using datalog-style rules
              </p>
            </div>
            <div className="overflow-x-auto">
              {risksLoading ? (
                <div className="p-4 text-gray-500">Loading risks...</div>
              ) : risks?.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500" />
                  <p className="font-medium">No risks detected</p>
                  <p className="text-sm">All stores are operating within normal capacity</p>
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entity ID</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Risk Level</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Distance</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Risk Sources</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {risks?.map((risk, idx) => (
                      <tr key={`${risk.entity_id}-${idx}`} className="hover:bg-gray-50">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <EntityIcon type={risk.entity_type} />
                            <span className="text-sm font-medium">{risk.entity_type}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 font-mono">
                          {risk.entity_id}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <RiskBadge level={risk.risk_level} />
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                          {risk.risk_distance} hop{risk.risk_distance !== 1 ? 's' : ''}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 font-mono">
                          {risk.risk_sources?.join(', ') || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Split Fulfillment Tab */}
      {activeTab === 'fulfillment' && (
        <div className="space-y-6">
          {/* Order Selection */}
          <div className="bg-white rounded-lg shadow p-4">
            <h2 className="text-lg font-semibold mb-4">Order Fulfillment Analysis</h2>
            <p className="text-sm text-gray-600 mb-4">
              Select an order to analyze whether it can be fulfilled from its primary store,
              or if split fulfillment from multiple stores is needed.
            </p>
            <select
              value={selectedOrderId}
              onChange={(e) => setSelectedOrderId(e.target.value)}
              className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">Select an order...</option>
              {orders?.map((order) => (
                <option key={order.order_id} value={order.order_id}>
                  {order.order_number} - {order.customer_name} ({order.store_name})
                </option>
              ))}
            </select>
          </div>

          {/* Fulfillment Analysis */}
          {selectedOrderId && (
            <div className="bg-white rounded-lg shadow">
              <div className="px-4 py-3 border-b border-gray-200">
                <h2 className="text-lg font-semibold">Fulfillment Analysis</h2>
              </div>
              <div className="p-4">
                {fulfillmentLoading ? (
                  <p className="text-gray-500">Analyzing order fulfillment...</p>
                ) : fulfillmentAnalysis ? (
                  <div className="space-y-6">
                    {/* Summary */}
                    <div className={`p-4 rounded-lg ${
                      fulfillmentAnalysis.can_fulfill_from_primary
                        ? 'bg-green-50 border border-green-200'
                        : 'bg-yellow-50 border border-yellow-200'
                    }`}>
                      <div className="flex items-center gap-2">
                        {fulfillmentAnalysis.can_fulfill_from_primary ? (
                          <>
                            <CheckCircle className="h-5 w-5 text-green-600" />
                            <span className="font-medium text-green-800">
                              Order can be fulfilled from primary store
                            </span>
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="h-5 w-5 text-yellow-600" />
                            <span className="font-medium text-yellow-800">
                              Split fulfillment required
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Order Details */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className="text-sm text-gray-500">Order</p>
                        <p className="font-medium">{fulfillmentAnalysis.order_number}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Primary Store</p>
                        <p className="font-medium">{fulfillmentAnalysis.primary_store_name}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Total Products</p>
                        <p className="font-medium">{fulfillmentAnalysis.total_products}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Fulfillable from Primary</p>
                        <p className="font-medium">
                          {fulfillmentAnalysis.fulfillable_products} / {fulfillmentAnalysis.total_products}
                        </p>
                      </div>
                    </div>

                    {/* Missing Products */}
                    {fulfillmentAnalysis.missing_products.length > 0 && (
                      <div>
                        <h3 className="font-medium mb-2">Missing Products at Primary Store</h3>
                        <div className="flex flex-wrap gap-2">
                          {fulfillmentAnalysis.missing_products.map((productId) => (
                            <span
                              key={productId}
                              className="px-2 py-1 bg-red-100 text-red-800 rounded text-sm font-mono"
                            >
                              {productId}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Split Options */}
                    {fulfillmentAnalysis.split_options.length > 0 && (
                      <div>
                        <h3 className="font-medium mb-2">Split Fulfillment Options</h3>
                        <div className="space-y-3">
                          {fulfillmentAnalysis.split_options.map((option, idx) => (
                            <div
                              key={idx}
                              className="p-3 bg-blue-50 border border-blue-200 rounded-lg"
                            >
                              <div className="flex items-center gap-2 mb-2">
                                <Package className="h-4 w-4 text-blue-600" />
                                <span className="font-medium text-blue-800 font-mono">
                                  {option.product_id}
                                </span>
                              </div>
                              <div className="flex items-center gap-4 text-sm">
                                <span>
                                  <strong>Stores:</strong> {option.store_ids.join(' + ')}
                                </span>
                                <span>
                                  <strong>Total Stock:</strong> {option.total_stock}
                                </span>
                                <span>
                                  <strong>Store Count:</strong> {option.store_count}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-500">No analysis available</p>
                )}
              </div>
            </div>
          )}

          {/* How It Works */}
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-medium mb-2">How Split Fulfillment Works</h3>
            <p className="text-sm text-gray-600 mb-2">
              Uses Materialize <code className="bg-gray-200 px-1 rounded">WITH MUTUALLY RECURSIVE</code> to find
              all combinations of stores that can fulfill a product:
            </p>
            <pre className="text-xs bg-gray-800 text-green-400 p-3 rounded overflow-x-auto">
{`WITH MUTUALLY RECURSIVE
  coverage(product_id, store_set, total_stock, store_count) AS (
    -- Base: single store coverage
    SELECT product_id, store_id, stock_level, 1
    FROM store_product_coverage WHERE stock_level > 0
    UNION
    -- Recursive: combine stores
    SELECT c.product_id,
           c.store_set || ', ' || s.store_id,
           c.total_stock + s.stock_level,
           c.store_count + 1
    FROM coverage c JOIN store_product_coverage s ...
  )`}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
