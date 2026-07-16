import { useEffect, useRef, useState } from 'react';
import { User, LogOut, Settings, CreditCard, Shield } from 'lucide-react';
import { useAuth } from '@/lib/saas/authContext';
import { formatPlanLabel, formatTxLimit } from '@/lib/saas/plans';
import { cn } from '@/lib/utils';

type ProfileModalProps = {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
};

export function ProfileModal({ open, onClose, onOpenSettings }: ProfileModalProps) {
  const { user, logout, saas } = useAuth();

  if (!open || !user) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/30 p-4 pt-16" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-white/10 bg-elev-2 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/10 pb-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-violet/15 text-gain">
            <User className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold text-mid">{user.email}</p>
            <p className="text-xs capitalize text-low">
              {user.role === 'admin' ? 'Administrator · Unlimited' : `${formatPlanLabel(user.plan)} plan`}
            </p>
          </div>
        </div>

        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-low">Role</dt>
            <dd className="font-medium capitalize text-mid">{user.role}</dd>
          </div>
              {user.role !== 'admin' && (
            <>
              <div className="flex justify-between gap-4">
                <dt className="text-low">Subscription</dt>
                <dd className="font-medium capitalize text-mid">{user.subscriptionStatus}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-low">Transaction limit</dt>
                <dd className="font-medium text-mid">{formatTxLimit(user.txLimit)} / year</dd>
              </div>
              {user.subscriptionExpiresAt && (
                <div className="flex justify-between gap-4">
                  <dt className="text-low">Renews / expires</dt>
                  <dd className="font-medium text-mid">
                    {new Date(user.subscriptionExpiresAt).toLocaleDateString()}
                  </dd>
                </div>
              )}
            </>
          )}
          {user.role === 'admin' && (
            <div className="flex items-center gap-2 rounded-lg bg-violet/10 px-3 py-2 text-xs text-gain">
              <Shield className="h-3.5 w-3.5" />
              Full access — manage API keys in Settings
            </div>
          )}
        </dl>

        <div className="mt-5 flex flex-col gap-2">
          {onOpenSettings && (
            <button
              type="button"
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-mid hover:bg-elev-3"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              <Settings className="h-4 w-4" />
              {user.role === 'admin' ? 'Settings & API keys' : 'Settings & subscription'}
            </button>
          )}
          {saas && user.role !== 'admin' && onOpenSettings && (
            <button
              type="button"
              className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-mid hover:bg-elev-3"
              onClick={() => {
                onClose();
                onOpenSettings();
              }}
            >
              <CreditCard className="h-4 w-4" />
              Billing & plans
            </button>
          )}
          <button
            type="button"
            className="flex items-center gap-2 rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-sm text-loss hover:bg-loss/15"
            onClick={() => {
              onClose();
              logout();
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export function UserProfileMenu({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { user, saas } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!saas || !user) return null;

  const initial = user.email.charAt(0).toUpperCase();

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold transition-colors',
          'border-white/20 bg-white/10 text-white hover:bg-white/20'
        )}
        title={user.email}
        aria-label="Open profile menu"
      >
        {initial}
      </button>
      <ProfileModal open={open} onClose={() => setOpen(false)} onOpenSettings={onOpenSettings} />
    </div>
  );
}
