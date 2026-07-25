import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Check, KeyRound, Pencil, Trash2 } from 'lucide-react';

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

/**
 * Ember & Slate API-key row: saved keys show as a masked mono chip on an
 * inset well with quiet Edit/Delete actions; editing swaps in the standard
 * `.sl-input` control + secondary Save. Behavior (mask, save-on-trim,
 * autofocus-when-editing) is unchanged.
 */
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
      <label className="block text-xs font-semibold text-low">{label}</label>
      {!editing && value ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-hi/10 bg-elev-3/60 py-1.5 pl-3 pr-1.5">
          <KeyRound className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden="true" />
          <span
            className="flex-1 truncate font-mono text-xs text-mid"
            title="Masked for security — the full key is stored locally"
          >
            {mask(value)}
          </span>
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            className="inline-flex h-8 items-center gap-1 rounded-[10px] px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-8 items-center gap-1 rounded-[10px] px-2.5 text-xs font-semibold text-loss transition-colors hover:bg-loss/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-loss/50"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" /> Delete
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            className="sl-input h-10 flex-1"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            autoFocus={editing && !!value}
          />
          <Button variant="secondary" size="sm" className="h-10 shrink-0 gap-1" onClick={save} disabled={!draft.trim()}>
            <Check className="h-3.5 w-3.5" aria-hidden="true" /> Save
          </Button>
        </div>
      )}
    </div>
  );
}
