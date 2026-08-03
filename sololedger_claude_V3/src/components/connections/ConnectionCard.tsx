import { AlertTriangle, Loader2, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { BrandIcon } from './brandIcons';
import { CardMenu, type CardMenuItem } from './CardMenu';
import type { ConnectionCardData } from './connectionModel';

interface ConnectionCardProps {
  card: ConnectionCardData;
  /** Kebab items; omit for cards without a menu (manual entry). */
  menuItems?: CardMenuItem[];
  /** When set, the whole card acts as a button (manual entry → add another). */
  onClick?: () => void;
  /**
   * When set (and no whole-card onClick), the card body opens the
   * per-connection detail view. The kebab menu and rename slot stop
   * propagation so their clicks never trigger this.
   */
  onOpenDetail?: () => void;
  /** Allows the workspace shell to restore focus to this exact card after Back. */
  elementRef?: React.Ref<HTMLElement>;
  /** Inline rename slot replacing the title/subtitle block (wallet cards). */
  renaming?: React.ReactNode;
}

/**
 * One source card on the Connections home (mockup `.ccard`): real brand
 * logo, name + identifier line, kind tags, and a footer with the honest
 * sync state (Synced / Needs attention / Watching / Imported) next to the
 * last-sync line and transaction count. No invented health metrics.
 */
export function ConnectionCard({ card, menuItems, onClick, onOpenDetail, elementRef, renaming }: ConnectionCardProps) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        <BrandIcon id={card.iconId} fallback={card.iconFallback} size={40} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            // Rename input/save/cancel must not bubble into a detail open.
            <span className="block" onClick={(e) => e.stopPropagation()}>
              {renaming}
            </span>
          ) : (
            <>
              <p className="truncate text-[15px] font-bold leading-5 text-hi">{card.title}</p>
              <p className="mt-0.5 truncate font-mono text-xs text-low">{card.subtitle}</p>
            </>
          )}
        </div>
        {menuItems && menuItems.length > 0 && (
          // The kebab keeps working when the card body is clickable.
          <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <CardMenu label={`${card.title} actions`} items={menuItems} />
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {card.tags.map((tag) => (
          <Badge key={tag} tone="neutral">
            {tag}
          </Badge>
        ))}
      </div>

      <div className="flex items-end justify-between gap-3 border-t border-hi/10 pt-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-mid">
            {card.status.label === 'Syncing' && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden="true" />
            )}
            {card.metaLine}
          </p>
          {card.syncChip && (
            <p
              className="mt-1.5 inline-flex w-fit items-center rounded-md border border-hi/10 bg-elev-3 px-2 py-0.5 font-mono text-[11px] leading-4 text-low"
              data-testid="sync-chip"
            >
              {card.syncChip}
            </p>
          )}
          {card.txLine && <p className="mt-0.5 text-xs text-low">{card.txLine}</p>}
          {card.error && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-loss">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="line-clamp-2">{card.error}</span>
            </p>
          )}
        </div>
        <Badge tone={card.status.tone}>{card.status.label}</Badge>
      </div>
    </>
  );

  const shell =
    'flex flex-col gap-3 rounded-2xl border border-hi/10 bg-elev-2 p-4 shadow-card transition-shadow hover:shadow-card-hover';

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          shell,
          'w-full text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
        )}
      >
        {body}
      </button>
    );
  }
  if (onOpenDetail) {
    return (
      <article
        ref={elementRef}
        role="button"
        tabIndex={0}
        aria-label={`Open ${card.title} details`}
        onClick={onOpenDetail}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenDetail();
          }
        }}
        className={cn(
          shell,
          'cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
        )}
        data-testid={`connection-card-${card.id}`}
      >
        {body}
      </article>
    );
  }
  return <article className={shell}>{body}</article>;
}

/** The dashed "Add data" card that closes the grid (mockup `.ccard.add`). */
export function AddDataCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-[164px] flex-col items-start justify-center gap-3 rounded-2xl border border-dashed border-hi/20 bg-elev-1 p-4 text-left',
        'transition-colors hover:border-primary/50 hover:bg-primary/[0.04]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60'
      )}
    >
      <span className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
        <Plus className="h-5 w-5" aria-hidden="true" />
      </span>
      <span>
        <span className="block text-[15px] font-bold text-hi">Add data</span>
        <span className="mt-1 block text-xs leading-relaxed text-low">
          Exchange, wallet app, blockchain, a file, or one transaction by hand.
        </span>
      </span>
    </button>
  );
}
