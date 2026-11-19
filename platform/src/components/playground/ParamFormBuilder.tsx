import { useEffect, useState, useCallback } from 'react';
import type { ToolParam } from '@/utils/tools-data';

interface Props {
  params: ToolParam[];
  value: string;
  onChange: (json: string) => void;
}

export function ParamFormBuilder({ params, value, onChange }: Props) {
  const [fields, setFields] = useState<Record<string, string>>(() => {
    try { return JSON.parse(value); } catch { return {}; }
  });

  // Sync from external JSON changes (e.g., Fill Example)
  useEffect(() => {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) {
        setFields(Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v ?? '')])
        ));
      }
    } catch { /* ignore */ }
  }, [value]);

  const handleChange = useCallback((name: string, rawValue: string, type: string) => {
    setFields(prev => {
      const next = { ...prev, [name]: rawValue };

      // Build typed JSON output
      const output: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(next)) {
        if (v === '') continue;
        const paramDef = params.find(p => p.name === k);
        const t = paramDef?.type || type;
        if (t === 'number') output[k] = Number(v);
        else if (t === 'boolean') output[k] = v === 'true';
        else if (t === 'array' || t === 'object') {
          // JSON (e.g. [110679112, 110441965] or {"name": "…"}); a plain list "34, 35" becomes an array.
          try { output[k] = JSON.parse(v); }
          catch { output[k] = t === 'array' ? v.split(',').map(x => x.trim()).filter(Boolean) : v; }
        }
        else output[k] = v;
      }
      onChange(JSON.stringify(output, null, 2));
      return next;
    });
  }, [params, onChange]);

  return (
    <div className="space-y-3">
      {params.map(p => (
        <div key={p.name}>
          <label className="flex items-center gap-1.5 text-sm font-medium text-txt-secondary mb-1">
            <code className="text-brand-700 text-xs">{p.name}</code>
            <span className="text-[10px] text-txt-muted">({p.type})</span>
            {p.required && <span className="text-red-500 text-xs">*</span>}
          </label>
          {p.type === 'boolean' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={fields[p.name] === 'true'}
                onChange={e => handleChange(p.name, String(e.target.checked), p.type)}
                className="w-4 h-4 rounded border-border text-brand-600 focus:ring-brand-500"
              />
              <span className="text-xs text-txt-muted">{p.description}</span>
            </label>
          ) : (
            <>
              <input
                type={p.type === 'number' ? 'number' : 'text'}
                value={fields[p.name] || ''}
                onChange={e => handleChange(p.name, e.target.value, p.type)}
                placeholder={p.description}
                className="w-full px-3 py-1.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
              />
              <p className="text-[11px] text-txt-muted mt-0.5">{p.description}</p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
