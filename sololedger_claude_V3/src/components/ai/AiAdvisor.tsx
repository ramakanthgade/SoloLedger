import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getNetworkMode, subscribeNetworkActivity } from '@/lib/networkActivity';
import { db, getSettings, saveSettings } from '@/lib/storage/db';
import { streamChatCompletion, AI_MODELS, DEFAULT_AI_MODEL, type ChatMessage } from '@/lib/ai/openrouter';
import { buildTaxContextFromDb } from '@/lib/ai/taxContext';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';
import { getAvailableFys, getCurrentFy, getFyLabel } from '@/lib/utils';
import type { Jurisdiction } from '@/types/transaction';
import { Bot, Check, Mic, MicOff, Send, ShieldCheck, Upload, X, ChevronDown, Sparkles, AlertTriangle } from 'lucide-react';
import { isSaasMode } from '@/lib/saas/config';
import { fetchPublicConfig } from '@/lib/saas/api';
import { Dialog } from '@/components/ui/Dialog';

const SUGGESTED_QUESTIONS = [
  'What is my total taxable gain this year?',
  'Which assets have the highest unrealized gain?',
  'How much have I paid in 1% TDS?',
  'Should I sell anything before March 31st?',
  'Explain my capital gains in simple terms.',
  'What transactions are still missing a price?'
];

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

// Web Speech API types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
  interface SpeechRecognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((e: SpeechRecognitionEvent) => void) | null;
    onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
  }
}

export function AiAdvisor() {
  const saas = isSaasMode();
  const settingsRow = useLiveQuery(() => db.settings.get('singleton'), []);
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const localAiApiKey = settingsRow?.aiApiKey;
  const aiModel = settingsRow?.aiModel ?? DEFAULT_AI_MODEL;
  const jurisdiction = (settingsRow?.jurisdiction ?? 'IN') as Jurisdiction;

  const [serverAiEnabled, setServerAiEnabled] = useState(!saas);
  const aiAvailable = saas ? serverAiEnabled : Boolean(localAiApiKey);
  const aiApiKey = saas ? 'saas-proxy' : (localAiApiKey ?? '');

  // AI consent (A2) — dual semantics by mode:
  // - Hosted SaaS: ON by default for subscribers (like automatic price
  //   fetching and wallet lookup); only an explicit `false` opts out.
  // - Local/BYOK: privacy-first opt-in — OFF until explicitly granted.
  // Either way, no AI request runs while consent is not granted.
  const consentGranted = saas
    ? settingsRow?.aiConsentGranted !== false
    : Boolean(settingsRow?.aiConsentGranted);

  // Transport disclosure (A1): BYO key talks directly to OpenRouter; a hosted
  // SaaS build with no user key is relayed through SoloLedger. `networkMode`
  // reflects the actual highest state reached this session and flips once a
  // real AI request goes out.
  const expectedMode: 'direct' | 'relay' = saas ? 'relay' : 'direct';
  const networkMode = useSyncExternalStore(subscribeNetworkActivity, getNetworkMode);

  useEffect(() => {
    if (!saas) return;
    fetchPublicConfig()
      .then((c) => setServerAiEnabled(c.aiAdvisorEnabled))
      .catch(() => setServerAiEnabled(false));
  }, [saas]);

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [year, setYear] = useState(getCurrentFy('IN'));

  const availableYears = getAvailableFys(transactions.map((t) => t.timestamp), jurisdiction);

  useEffect(() => {
    setYear(getCurrentFy(jurisdiction));
  }, [jurisdiction]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, 30);
  }, []);

  useEffect(() => {
    if (open) {
      scrollToBottom();
      inputRef.current?.focus();
    }
  }, [open, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const hasSpeech = typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  const toggleVoice = () => {
    if (!hasSpeech) return;
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition!;
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? '';
      setInput((prev) => (prev ? `${prev} ${text}` : text));
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  };

  const grantConsent = async () => {
    const current = await getSettings();
    await saveSettings({ ...current, aiConsentGranted: true });
  };

  const revokeConsent = async () => {
    const current = await getSettings();
    await saveSettings({ ...current, aiConsentGranted: false });
    setMessages([]);
    setInput('');
    setError(null);
  };

  const sendMessage = async (text: string) => {
    const q = text.trim();
    // Consent gate: no data leaves the device until the user has opted in.
    if (!q || loading || !aiAvailable || !consentGranted) return;
    setInput('');
    setError(null);

    const newUserMsg: Message = { role: 'user', content: q };
    const updatedMessages = [...messages, newUserMsg];
    setMessages(updatedMessages);
    setLoading(true);

    const assistantIndex = updatedMessages.length;
    setMessages((prev) => [...prev, { role: 'assistant', content: '', streaming: true }]);

    try {
      const systemPrompt = await buildTaxContextFromDb(year);
      const chatHistory: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...updatedMessages.map((m) => ({ role: m.role, content: m.content }))
      ];

      let accum = '';
      for await (const chunk of streamChatCompletion(aiApiKey, aiModel, chatHistory)) {
        accum += chunk;
        setMessages((prev) => {
          const copy = [...prev];
          copy[assistantIndex] = { role: 'assistant', content: accum, streaming: true };
          return copy;
        });
        scrollToBottom();
      }
      setMessages((prev) => {
        const copy = [...prev];
        copy[assistantIndex] = { role: 'assistant', content: accum, streaming: false };
        return copy;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong.';
      setError(msg);
      setMessages((prev) => prev.filter((_, i) => i !== assistantIndex));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  const years = availableYears.length > 0 ? availableYears : [getCurrentFy(jurisdiction)];

  const fabClass =
    'flex items-center justify-center rounded-full shadow-pop transition-all duration-300 motion-reduce:transition-none motion-reduce:transform-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas';

  if (!aiAvailable) {
    return (
      <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3">
        <span className="hidden rounded-full border border-hi/10 bg-elev-1/95 px-3.5 py-2 text-xs font-semibold text-low shadow-pop sm:inline">
          AI advisor unavailable
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          title="AI Tax Advisor — not configured on server"
          className={`${fabClass} h-14 w-14 border border-hi/10 bg-elev-2 hover:bg-elev-3`}
        >
          <Bot className="h-7 w-7 text-low" />
        </button>
        {open && (
          <div className="absolute bottom-16 right-0 w-72 rounded-2xl border border-hi/10 bg-elev-1 p-4 shadow-pop">
            <p className="text-sm leading-relaxed text-low">
              {saas ? (
                <>
                  AI Tax Advisor is disabled or the server OpenRouter key is not set. Ask your admin to enable{' '}
                  <strong className="text-hi">AI Tax Advisor</strong> and add an OpenRouter key in Settings.
                </>
              ) : (
                <>
                  AI Tax Advisor needs an <strong className="text-hi">OpenRouter API key</strong> in Settings → AI
                  Advisor.
                </>
              )}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
      {open && (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          overlay={false}
          label="AI Tax Advisor"
          className="flex h-[min(620px,calc(100dvh-7rem))] w-[min(400px,calc(100vw-3rem))] flex-col overflow-hidden border-hi/10 bg-elev-1 shadow-pop"
        >
          {/* Header — aurora brand tile + FY/jurisdiction caption (mockup `.dp-head`) */}
          <div className="flex shrink-0 items-center gap-3 border-b border-hi/10 px-4 pb-3 pt-3.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-aurora shadow-glow">
              <Sparkles className="h-[18px] w-[18px] text-on-aurora" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold leading-tight text-hi">AI Tax Advisor</p>
              <p className="mt-0.5 truncate text-[11px] leading-tight text-low">
                {JURISDICTIONS[jurisdiction].label}
                {jurisdiction === 'IN' ? ' · VDA rules' : ''}
              </p>
            </div>
            <div className="relative shrink-0">
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                aria-label="Financial year"
                className="h-8 appearance-none rounded-full border border-hi/10 bg-elev-2 pl-3 pr-7 text-[11px] font-semibold text-mid shadow-xs transition-colors hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {years.map((y) => (
                  <option key={y} value={y}>
                    {getFyLabel(y, jurisdiction)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-low" />
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close AI advisor"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!consentGranted ? (
            <ConsentGate mode={expectedMode} onEnable={grantConsent} onDecline={() => setOpen(false)} />
          ) : (
          <>
          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
            {messages.length === 0 && (
              <div className="space-y-3.5">
                <p className="text-xs leading-relaxed text-low">
                  Ask anything about your crypto taxes. An aggregated summary of your position — not your raw
                  transactions, wallet addresses or hashes — is sent to OpenRouter to answer.
                </p>
                <ModeBadge mode={networkMode === 'local' ? expectedMode : networkMode} />
                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-faint">Suggested</p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTED_QUESTIONS.map((q) => (
                      <button
                        key={q}
                        onClick={() => void sendMessage(q)}
                        className="rounded-full border border-hi/15 bg-elev-1 px-3 py-1.5 text-left text-xs font-semibold text-mid shadow-xs transition-colors hover:border-primary/50 hover:bg-primary/[0.06] hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => void revokeConsent()}
                  className="rounded text-[11px] text-low underline decoration-dotted underline-offset-2 transition-colors hover:text-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  Turn off the AI Advisor &amp; clear this chat
                </button>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={
                    msg.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-primary-solid px-3.5 py-2.5 text-xs font-medium leading-relaxed text-white shadow-xs'
                      : 'max-w-[92%] rounded-2xl rounded-bl-sm border border-hi/10 bg-elev-2 px-3.5 py-2.5 text-xs leading-relaxed text-mid shadow-xs'
                  }
                >
                  <MessageContent content={msg.content} streaming={msg.streaming} />
                </div>
              </div>
            ))}

            {error && (
              <div className="rounded-xl border border-loss/30 bg-loss/10 px-3.5 py-2.5 text-xs leading-relaxed text-loss">
                {error}
              </div>
            )}
          </div>

          {/* Composer (mockup `.composer` + `.dp-foot`) */}
          <div className="shrink-0 border-t border-hi/10 p-3">
            <div className="flex items-end gap-1.5 rounded-2xl border border-hi/15 bg-elev-2 px-2 py-1.5 shadow-xs transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/25">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your taxes…"
                rows={1}
                className="max-h-20 flex-1 resize-none bg-transparent px-2 py-2 text-xs leading-relaxed text-hi placeholder:text-faint focus:outline-none"
              />
              {hasSpeech && (
                <button
                  onClick={toggleVoice}
                  title={listening ? 'Stop recording' : 'Speak your question'}
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${
                    listening ? 'text-loss motion-safe:animate-pulse' : 'text-low hover:bg-elev-3 hover:text-hi'
                  }`}
                >
                  {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
              )}
              <button
                onClick={() => void sendMessage(input)}
                disabled={loading || !input.trim()}
                aria-label="Send message"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-solid text-white shadow-xs transition-colors hover:bg-primary-solid-deep disabled:bg-elev-3 disabled:text-low disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1.5 text-right text-[10px] text-low">
              {AI_MODELS.find((m) => m.id === aiModel)?.label ?? aiModel} · OpenRouter
            </p>
          </div>
          </>
          )}
        </Dialog>
      )}

      {/* FAB — aurora gradient: the app's signature AI moment */}
      <div className="flex items-center gap-3">
        {!open && (
          <span className="hidden items-center gap-1.5 rounded-full border border-primary/30 bg-elev-1/95 px-3.5 py-2 text-xs font-bold text-primary shadow-pop sm:inline-flex">
            <Sparkles className="h-3.5 w-3.5" />
            Ask AI
          </span>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          title="AI Tax Advisor — ask about your taxes"
          className={`${fabClass} h-16 w-16 ${
            open
              ? 'bg-primary-solid text-white ring-4 ring-primary/30'
              : 'bg-aurora text-on-aurora ring-4 ring-primary/40 hover:scale-105 hover:shadow-glow'
          }`}
        >
          {open ? <X className="h-6 w-6" /> : <Bot className="h-7 w-7" />}
        </button>
      </div>
    </div>
  );
}

/** Render message content: preserve newlines and bold **text** */
function MessageContent({ content, streaming }: { content: string; streaming?: boolean }) {
  if (!content && streaming) {
    return <span className="inline-block h-3 w-3 rounded-full bg-low motion-safe:animate-pulse" />;
  }
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {part}
          </span>
        )
      )}
      {streaming && <span className="ml-1 inline-block h-2 w-1 bg-low motion-safe:animate-pulse" />}
    </span>
  );
}

/**
 * Transport disclosure ribbon (A2 + A1) — the panel's signature trust element
 * (mockup `.ribbon`). Shows whether the aggregated summary goes DIRECT to
 * OpenRouter (BYO key) or is RELAYED through SoloLedger (hosted SaaS, no user
 * key). Tones follow the Ember & Slate semantic tokens.
 */
function ModeBadge({ mode }: { mode: 'direct' | 'relay' }) {
  const cfg =
    mode === 'relay'
      ? {
          label: 'Relayed via SoloLedger',
          detail: 'No API key on this SaaS build — the summary is routed through SoloLedger to OpenRouter.',
          cls: 'border-primary/30 bg-primary/[0.07] text-primary',
          dot: 'bg-primary'
        }
      : {
          label: 'Direct to OpenRouter',
          detail: 'Your own OpenRouter key — the summary goes straight to OpenRouter; SoloLedger never sees it.',
          cls: 'border-accent/30 bg-accent/[0.08] text-accent',
          dot: 'bg-accent'
        };
  return (
    <div
      data-testid="ai-mode-badge"
      data-mode={mode}
      className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-[11px] leading-relaxed ${cfg.cls}`}
    >
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${cfg.dot} motion-safe:animate-pulse`} />
      <div className="min-w-0">
        <p className="font-bold">{cfg.label}</p>
        <p className="mt-0.5 text-mid">{cfg.detail}</p>
      </div>
    </div>
  );
}

const CONSENT_SENT = [
  'Your holdings by asset (e.g. 0.5 BTC, 12 ETH)',
  'Aggregate cost basis and realized gains',
  'Totals like taxable gain, TDS paid, income',
  'Your jurisdiction and financial year',
  'The question you type into the advisor'
];

const CONSENT_KEPT = [
  'Raw wallet addresses',
  'Individual transaction hashes',
  'Your exchange API keys or credentials',
  'Line-by-line trade history',
  'Your name, PAN, or contact details'
];

/**
 * First-use consent gate (A2). Names exactly what leaves the device before any
 * AI request runs. Mirrors the approved aurora-ai-consent.html mockup. Enabling
 * requires ticking the explicit consent checkbox.
 */
function ConsentGate({
  mode,
  onEnable,
  onDecline
}: {
  mode: 'direct' | 'relay';
  onEnable: () => void | Promise<void>;
  onDecline: () => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
      <div className="text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-aurora shadow-glow">
          <Bot className="h-6 w-6 text-on-aurora" />
        </div>
        <h3 className="mt-3 text-sm font-bold text-hi">Turn on the AI Advisor?</h3>
        <p className="mt-1 text-xs leading-relaxed text-low">
          The AI Advisor answers questions about your tax position. Because it uses a large language model, some of
          your data has to leave this device. Here's exactly what — and what doesn't.
        </p>
      </div>

      <ModeBadge mode={mode} />

      <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3.5">
        <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-primary">
          <Upload className="h-3.5 w-3.5" /> Sent to the AI — an aggregated summary
        </p>
        <ul className="mt-2 space-y-1.5">
          {CONSENT_SENT.map((item) => (
            <li key={item} className="flex items-start gap-2 text-xs leading-relaxed text-mid">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-gain/30 bg-gain/[0.07] p-3.5">
        <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-gain">
          <ShieldCheck className="h-3.5 w-3.5" /> Never leaves this device
        </p>
        <ul className="mt-2 space-y-1.5">
          {CONSENT_KEPT.map((item) => (
            <li key={item} className="flex items-start gap-2 text-xs leading-relaxed text-mid">
              <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gain" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex gap-2.5 rounded-xl border border-warn/25 bg-warn/[0.07] p-3.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <p className="text-[11px] leading-relaxed text-mid">
          <strong className="text-warn">We won't pretend this is 100% local.</strong> The rest of SoloLedger runs
          entirely on your device — the AI Advisor is the one feature that talks to an outside service, which is why
          it's off until you switch it on.
        </p>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-primary/30 bg-elev-2 p-3.5 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/25">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
        />
        <span className="text-xs leading-relaxed text-mid">
          I understand that enabling the AI Advisor sends an <strong className="text-hi">aggregated financial
          summary</strong> plus my typed question to <strong className="text-hi">OpenRouter</strong>, and I
          explicitly consent. I can turn this off at any time.
        </span>
      </label>

      <div className="flex gap-2">
        <button
          onClick={onDecline}
          className="min-h-11 flex-1 rounded-lg border border-hi/10 bg-elev-1 px-3 py-2 text-xs font-bold text-mid shadow-xs transition-colors hover:border-hi/20 hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          Not now — keep it local
        </button>
        <button
          onClick={() => void onEnable()}
          disabled={!checked}
          className="min-h-11 flex-1 rounded-lg bg-aurora px-3 py-2 text-xs font-bold text-on-aurora shadow-glow transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          Enable AI Advisor
        </button>
      </div>
    </div>
  );
}
