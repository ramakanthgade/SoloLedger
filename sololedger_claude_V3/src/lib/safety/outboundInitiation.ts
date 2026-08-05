export type OutboundInitiationState = 'wallet_initiated' | 'spoofed_outbound_log' | 'unverified';

export interface OutboundInitiationEvidence {
  watchedAddress: string;
  transferFrom?: string;
  topLevelSender?: string;
  nonce?: number | string | null;
  expectedNonce?: number | string | null;
  initiatorAddress?: string;
}

export function resolveOutboundInitiation(evidence: OutboundInitiationEvidence): OutboundInitiationState {
  const watched = evidence.watchedAddress.trim().toLowerCase();
  if (!watched || evidence.transferFrom?.trim().toLowerCase() !== watched) return 'unverified';
  const sender = evidence.topLevelSender?.trim().toLowerCase();
  const initiator = evidence.initiatorAddress?.trim().toLowerCase();
  if ((sender && sender !== watched) || (initiator && initiator !== watched)) return 'spoofed_outbound_log';
  // A provider's top-level sender is useful contradiction evidence, but is not
  // sufficient proof by itself. Require an independently normalized initiator
  // and nonce expectation before an outbound-looking log may affect custody.
  if (sender !== watched || initiator !== watched || evidence.expectedNonce == null || evidence.nonce == null) {
    return 'unverified';
  }
  if (String(evidence.expectedNonce) !== String(evidence.nonce)) {
    return 'spoofed_outbound_log';
  }
  return 'wallet_initiated';
}
