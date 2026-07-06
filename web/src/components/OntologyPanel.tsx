import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Network } from 'lucide-react';
import { fetchOntology } from '../api/client';

interface OntologyClass {
  name: string;
  domain: string;
  description: string;
  id_example?: string;
  backed_by: { table: string; live_views: string[] };
}

interface OntologyRelationship {
  name: string;
  from: string;
  to: string;
  via: string;
  note?: string;
}

const DOMAIN_COLORS: Record<string, string> = {
  sortation: 'border-red-800 bg-red-950/30',
  package_flow: 'border-amber-700 bg-amber-950/30',
  fleet: 'border-blue-800 bg-blue-950/30',
};

/** The ontology, rendered from the same document the copilot loads via
 * get_context_graph() — what you see is literally what the agent sees. */
export default function OntologyPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [classes, setClasses] = useState<OntologyClass[]>([]);
  const [relationships, setRelationships] = useState<OntologyRelationship[]>([]);

  useEffect(() => {
    fetchOntology()
      .then((o) => {
        setClasses((o.classes as OntologyClass[]) ?? []);
        setRelationships((o.relationships as OntologyRelationship[]) ?? []);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 p-4 text-left hover:bg-gray-800/50 transition-colors"
      >
        {isOpen ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <Network className="h-4 w-4 text-ups-gold" />
        <span className="font-semibold text-white">The Ontology</span>
        <span className="text-xs text-gray-500">
          {classes.length} entity classes · {relationships.length} relationships — exactly what the copilot loads via get_context_graph()
        </span>
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {classes.map((c) => (
              <div key={c.name} className={`rounded border p-2 text-xs ${DOMAIN_COLORS[c.domain] ?? 'border-gray-700'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">{c.name}</span>
                  <span className="text-gray-500">{c.domain}</span>
                </div>
                <div className="mt-1 text-gray-400">{c.description}</div>
                <div className="mt-1 font-mono text-gray-500">
                  {c.backed_by.table}
                  {c.backed_by.live_views.length > 0 && <> → {c.backed_by.live_views.join(', ')}</>}
                </div>
              </div>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-white mb-2">Relationships (the graph edges)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
              {relationships.map((r) => (
                <div key={r.name} className="text-xs text-gray-400 font-mono" title={r.note}>
                  <span className="text-gray-200">{r.from}</span>
                  <span className="text-ups-gold"> —{r.name}→ </span>
                  <span className="text-gray-200">{r.to}</span>
                  {r.note && <span className="text-amber-500"> ★</span>}
                </div>
              ))}
            </div>
            <div className="mt-2 text-xs text-gray-600">★ cross-silo edges — the reason this is a graph, not three dashboards</div>
          </div>
        </div>
      )}
    </div>
  );
}
