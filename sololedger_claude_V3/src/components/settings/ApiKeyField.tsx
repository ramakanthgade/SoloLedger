import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, Pencil, Trash2 } from 'lucide-react';

function mask(key: string): string {
  if (key.length <= 10) return '•'.repeat(key.length);
  return `${key.slice(0, 5)}${'•'.repeat(6)}${key.slice(-4)}`;
}

interface Props {
  label: React.ReactNode;
  value: string | undefined;
  onSave: (value: string) => void;
  onDelete: () => void;
  placeholder?: string;
}

export function ApiKeyField({ label, value, onSave, onDelete, placeholder }: Props) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(!value);

  const save = () => {
    if (!draft.trim()) return;
    onSave(draft.trim());
    setDraft('');
    setEditing(false);
  };

  return (
    <div className="space-y-1.5">
      <label className="block text-xs text-low">{label}</label>
      {!editing && value ? (
        <div className="flex items-center gap-2 rounded-full border border-violet/30 bg-violet/10 px-3 py-1.5">
          <span className="flex-1 font-mono text-sm text-mid" title="Masked for security — the full key is stored locally">
            {mask(value)}
          </span>
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            className="flex items-center gap-1 text-xs text-gain hover:underline"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1 text-xs text-loss hover:underline"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            className="block w-full rounded-full border border-white/10 bg-elev-2 px-3 py-1.5 text-sm text-mid focus:border-violet focus:outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            autoFocus={editing && !!value}
          />
          <Button variant="secondary" className="shrink-0 gap-1 text-xs" onClick={save} disabled={!draft.trim()}>
            <Check className="h-3.5 w-3.5" /> Save
          </Button>
        </div>
      )}
    </div>
  );
}
