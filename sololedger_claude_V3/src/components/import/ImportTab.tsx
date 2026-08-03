import { ConnectionsHome } from '@/components/connections/ConnectionsHome';
import type { SourceNavigationIntent } from '@/lib/navigationIntent';

/**
 * ImportTab — the shell's "Connections" tab (tab id stays 'import').
 * The old mode-pill hub (Guided import / File upload / Manual entry /
 * Wallet lookup / Auto-sync) is replaced by the Connections v2 home; each
 * mode now lives in the Add-data drawer:
 * - Guided import  → drawer guided mode (ConnectionWizard)
 * - File upload    → What › A file (FileImportFlow), or an exchange card's
 *   "Import file" kebab action
 * - Manual entry   → What › Manual entry (ManualEntryForm)
 * - Wallet lookup  → What › Wallet app / Blockchain address (WalletAddressForm)
 * - Auto-sync      → What › Exchange account › an API exchange
 *   (ExchangeConnectStep)
 */
export function ImportTab({ navigationIntent, onNavigationIntentAcknowledged, onNavigationBack }: {
  navigationIntent?: SourceNavigationIntent;
  onNavigationIntentAcknowledged?: (id: string) => void;
  onNavigationBack?: () => void;
} = {}) {
  return <ConnectionsHome navigationIntent={navigationIntent} onNavigationIntentAcknowledged={onNavigationIntentAcknowledged} onNavigationBack={onNavigationBack} />;
}
