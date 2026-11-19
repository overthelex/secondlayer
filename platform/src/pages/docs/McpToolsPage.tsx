import { useState } from 'react';
import { Search, ChevronDown, ChevronRight } from 'lucide-react';
import { tools, categories, categoryColors } from '@/utils/tools-data';
import { CodeBlock } from '@/components/CodeBlock';

export function McpToolsPage() {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  const filtered = tools.filter((tool) => {
    const matchesSearch = !search ||
      tool.name.toLowerCase().includes(search.toLowerCase()) ||
      tool.description.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !selectedCategory || tool.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-txt-primary">MCP Tools Reference</h1>
        <p className="text-sm text-txt-muted mt-1">
          {tools.length} інструментів доступних через SecondLayer API
        </p>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-txt-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Пошук інструментів..."
            className="w-full pl-9 pr-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
              !selectedCategory ? 'bg-brand-600 text-white' : 'bg-surface-tertiary text-txt-muted hover:text-txt-primary'
            }`}
          >
            Всі ({tools.length})
          </button>
          {categories.map((cat) => {
            const count = tools.filter(t => t.category === cat).length;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                  selectedCategory === cat ? 'bg-brand-600 text-white' : 'bg-surface-tertiary text-txt-muted hover:text-txt-primary'
                }`}
              >
                {cat} ({count})
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        {filtered.map((tool) => {
          const isExpanded = expandedTool === tool.name;
          const hasDetails = tool.params || tool.example;

          return (
            <div key={tool.name} className={`bg-white rounded-xl border transition-colors ${isExpanded ? 'border-brand-300' : 'border-border hover:border-brand-200'}`}>
              <div className={`p-4 ${hasDetails ? 'cursor-pointer' : ''}`} onClick={() => hasDetails && setExpandedTool(isExpanded ? null : tool.name)}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {hasDetails && (isExpanded ? <ChevronDown size={14} className="text-brand-600" /> : <ChevronRight size={14} className="text-txt-muted" />)}
                      <code className="text-sm font-mono font-medium text-brand-700">{tool.name}</code>
                      {tool.name === 'get_legal_advice' && <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">Main</span>}
                    </div>
                    <p className="text-sm text-txt-secondary mt-1">{tool.description}</p>
                    {tool.cost && <p className="text-xs text-txt-muted mt-1">Вартість: {tool.cost} за виклик за прайсом, плюс націнка тарифу</p>}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${categoryColors[tool.category] || 'bg-gray-50 text-gray-700'}`}>
                    {tool.category}
                  </span>
                </div>
              </div>

              {isExpanded && hasDetails && (
                <div className="px-4 pb-4 space-y-4 border-t border-border-light pt-4">
                  {tool.params && (
                    <div>
                      <h4 className="text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">Параметри</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-xs text-txt-muted">
                              <th className="pb-1 pr-4">Назва</th>
                              <th className="pb-1 pr-4">Тип</th>
                              <th className="pb-1 pr-4">Обов.</th>
                              <th className="pb-1">Опис</th>
                            </tr>
                          </thead>
                          <tbody>
                            {tool.params.map((p) => (
                              <tr key={p.name} className="border-t border-border-light">
                                <td className="py-1.5 pr-4"><code className="text-xs font-mono text-brand-700">{p.name}</code></td>
                                <td className="py-1.5 pr-4 text-xs text-txt-muted">{p.type}</td>
                                <td className="py-1.5 pr-4 text-xs">{p.required ? <span className="text-red-600">Так</span> : <span className="text-txt-muted">Ні</span>}</td>
                                <td className="py-1.5 text-xs text-txt-secondary">{p.description}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  {tool.example && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <div>
                        <h4 className="text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">Запит</h4>
                        <CodeBlock code={tool.example.request} title="JSON" />
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">Відповідь</h4>
                        <CodeBlock code={tool.example.response} title="JSON" />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-8"><p className="text-sm text-txt-muted">Інструменти не знайдено</p></div>
      )}

      <div className="text-xs text-txt-muted text-center pt-4">Показано {filtered.length} з {tools.length} інструментів</div>
    </div>
  );
}
