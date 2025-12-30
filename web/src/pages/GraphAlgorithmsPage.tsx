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
} from 'lucide-react'
import {
  graphApi,
  freshmartApi,
  SupplyChainRisk,
  StoreRiskLevel,
  OrderFulfillmentAnalysis,
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

export default function GraphAlgorithmsPage() {
  const [selectedOrderId, setSelectedOrderId] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'risk' | 'fulfillment'>('risk')
  const [entityTypeFilter, setEntityTypeFilter] = useState<string>('')
  const [riskLevelFilter, setRiskLevelFilter] = useState<string>('')

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
  })

  // Fetch store risk levels
  const { data: storeRisks, isLoading: storeRisksLoading } = useQuery({
    queryKey: ['store-risks'],
    queryFn: async () => {
      const response = await graphApi.listStoreRisks()
      return response.data
    },
  })

  // Fetch orders for fulfillment analysis dropdown
  const { data: orders } = useQuery({
    queryKey: ['orders-for-fulfillment'],
    queryFn: async () => {
      const response = await freshmartApi.listOrders({ status: 'CREATED' })
      return response.data
    },
  })

  // Fetch fulfillment analysis for selected order
  const { data: fulfillmentAnalysis, isLoading: fulfillmentLoading } = useQuery({
    queryKey: ['fulfillment-analysis', selectedOrderId],
    queryFn: async () => {
      if (!selectedOrderId) return null
      const response = await graphApi.analyzeOrderFulfillment(selectedOrderId)
      return response.data
    },
    enabled: !!selectedOrderId,
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

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Graph Algorithms</h1>
        <p className="text-gray-600 mt-1">
          Supply chain risk propagation and split order fulfillment using Materialize WITH MUTUALLY RECURSIVE
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab('risk')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'risk'
                ? 'border-green-500 text-green-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <AlertTriangle className="h-4 w-4 inline mr-2" />
            Risk Propagation
          </button>
          <button
            onClick={() => setActiveTab('fulfillment')}
            className={`py-2 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'fulfillment'
                ? 'border-green-500 text-green-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <GitBranch className="h-4 w-4 inline mr-2" />
            Split Fulfillment
          </button>
        </nav>
      </div>

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
