import { useCallback, useEffect, useRef, useState } from 'react';
import {
  claimAccountOwnershipPrompt,
  createCsvAccountIdentity,
  db,
  updateAccountOwnership
} from '@/lib/storage/db';
import type { AccountIdentityRow } from '@/lib/accounts/accountIdentity';
import { Button } from '@/components/ui/button';
import { SourceOwnershipDialog, type SourceOwnershipDecision } from './SourceOwnershipDialog';

interface CsvAccountRequest {
  parserId: string | null;
  fileName: string;
  accounts: AccountIdentityRow[];
}

export class CsvAccountSelectionCancelledError extends Error {}

export function useCsvAccountSelection() {
  const [request, setRequest] = useState<CsvAccountRequest | null>(null);
  const [newAccountLabel, setNewAccountLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ownershipAccount, setOwnershipAccount] = useState<AccountIdentityRow | null>(null);
  const resolver = useRef<((accountIdentityId: string) => void) | null>(null);
  const rejecter = useRef<((reason: Error) => void) | null>(null);
  const requesting = useRef(false);
  const selecting = useRef(false);
  const requestGeneration = useRef(0);

  useEffect(() => () => {
    requestGeneration.current += 1;
    rejecter.current?.(new CsvAccountSelectionCancelledError('CSV account selection was cancelled.'));
    resolver.current = null;
    rejecter.current = null;
  }, []);

  const complete = useCallback((accountIdentityId: string) => {
    const resolve = resolver.current;
    resolver.current = null;
    rejecter.current = null;
    setOwnershipAccount(null);
    setRequest(null);
    selecting.current = false;
    resolve?.(accountIdentityId);
  }, []);

  const cancelRequest = useCallback(() => {
    requestGeneration.current += 1;
    const reject = rejecter.current;
    resolver.current = null;
    rejecter.current = null;
    requesting.current = false;
    selecting.current = false;
    setOwnershipAccount(null);
    setRequest(null);
    setError(null);
    setNewAccountLabel('');
    reject?.(new CsvAccountSelectionCancelledError('CSV account selection was cancelled.'));
  }, []);

  const requestAccount = useCallback(async (parserId: string | null, fileName: string): Promise<string> => {
    if (requesting.current || resolver.current) {
      throw new Error('Choose an account for the current file before importing another one.');
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    requesting.current = true;
    try {
      const accounts = (await db.accountIdentities.where('kind').equals('csv').toArray())
        .sort((a, b) => {
          const aMatch = a.parserId === (parserId ?? undefined) ? 0 : 1;
          const bMatch = b.parserId === (parserId ?? undefined) ? 0 : 1;
          return aMatch - bMatch || (a.label ?? a.id).localeCompare(b.label ?? b.id);
        });
      if (requestGeneration.current !== generation) {
        throw new CsvAccountSelectionCancelledError('CSV account selection was cancelled.');
      }
      setError(null);
      setNewAccountLabel('');
      setRequest({ parserId, fileName, accounts });
      return await new Promise<string>((resolve, reject) => {
        resolver.current = resolve;
        rejecter.current = reject;
      });
    } finally {
      if (requestGeneration.current === generation) requesting.current = false;
    }
  }, []);

  const selectAccount = useCallback(async (account: AccountIdentityRow) => {
    if (selecting.current) return;
    const generation = requestGeneration.current;
    selecting.current = true;
    setError(null);
    try {
      const claim = await claimAccountOwnershipPrompt(account.id);
      if (requestGeneration.current !== generation) return;
      if (claim.claimed) setOwnershipAccount(claim.account);
      else complete(account.id);
    } catch (reason) {
      if (requestGeneration.current !== generation) return;
      selecting.current = false;
      setError(reason instanceof Error ? reason.message : 'Could not select this account.');
    }
  }, [complete]);

  const createAccount = useCallback(async () => {
    if (!request || !newAccountLabel.trim()) return;
    const generation = requestGeneration.current;
    setError(null);
    try {
      const account = await createCsvAccountIdentity(request.parserId, newAccountLabel.trim());
      if (requestGeneration.current !== generation) return;
      await selectAccount(account);
    } catch (reason) {
      if (requestGeneration.current !== generation) return;
      setError(reason instanceof Error ? reason.message : 'Could not create the account.');
    }
  }, [newAccountLabel, request, selectAccount]);

  const finishOwnership = useCallback(async (decision: SourceOwnershipDecision) => {
    if (!ownershipAccount) return;
    const generation = requestGeneration.current;
    if (decision !== 'unknown') {
      await updateAccountOwnership(
        ownershipAccount.id,
        { status: decision, origin: 'user' },
        ownershipAccount.lifecycleRevision
      );
      if (requestGeneration.current !== generation) return;
    }
    complete(ownershipAccount.id);
  }, [complete, ownershipAccount]);

  const cancelOwnership = useCallback(() => {
    selecting.current = false;
    setOwnershipAccount(null);
  }, []);

  return {
    request,
    newAccountLabel,
    error,
    ownershipAccount,
    busy: request !== null || ownershipAccount !== null,
    requestAccount,
    selectAccount,
    createAccount,
    finishOwnership,
    cancelOwnership,
    cancelRequest,
    setNewAccountLabel
  };
}

export function CsvAccountSelection({ flow }: { flow: ReturnType<typeof useCsvAccountSelection> }) {
  const { request, ownershipAccount } = flow;
  return (
    <>
      <SourceOwnershipDialog
        open={ownershipAccount !== null}
        mode="prompt"
        accountLabel={ownershipAccount?.label ?? 'this file account'}
        sourceDescription={`${request?.parserId ?? 'CSV'} · recurring file account`}
        onDecision={flow.finishOwnership}
        onCancel={flow.cancelOwnership}
      />
      {request && (
        <section className="rounded-2xl border border-primary/30 bg-elev-2 p-4" aria-labelledby="csv-account-title">
          <h3 id="csv-account-title" className="text-sm font-bold text-hi">Which account is this file for?</h3>
          <p className="mt-1 text-xs leading-relaxed text-low">
            Detected {request.parserId ?? 'an unknown CSV format'} in {request.fileName}.
            Choose the same account for recurring exports; the file itself is still deduplicated by content.
          </p>
          {request.accounts.length > 0 && (
            <div className="mt-3 grid gap-2">
              {request.accounts.map((account) => (
                <Button key={account.id} variant="secondary" className="min-h-11 justify-start" onClick={() => void flow.selectAccount(account)}>
                  {account.label ?? 'Unnamed account'} · {account.id.slice(-8)}
                </Button>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <label className="flex-1 text-xs font-semibold text-mid">
              Create another account
              <input
                value={flow.newAccountLabel}
                onChange={(event) => flow.setNewAccountLabel(event.target.value)}
                placeholder="e.g. Main Binance account"
                className="mt-1 h-11 w-full rounded-lg border border-hi/10 bg-elev-1 px-3 text-sm text-hi focus:border-primary focus:outline-none"
              />
            </label>
            <Button className="min-h-11 self-end" disabled={!flow.newAccountLabel.trim()} onClick={() => void flow.createAccount()}>
              Create and continue
            </Button>
          </div>
          {flow.error && <p role="alert" className="mt-2 text-sm text-loss">{flow.error}</p>}
        </section>
      )}
    </>
  );
}
