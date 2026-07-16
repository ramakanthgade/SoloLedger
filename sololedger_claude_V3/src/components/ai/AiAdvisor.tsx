import { useEffect, useRef, useState, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/storage/db';
import { streamChatCompletion, AI_MODELS, DEFAULT_AI_MODEL, type ChatMessage } from '@/lib/ai/openrouter';
import { buildTaxContext } from '@/lib/ai/taxContext';
import { getAvailableFys, getCurrentFy, getFyLabel } from '@/lib/utils';
import type { Jurisdiction } from '@/types/transaction';
import { Bot, Mic, MicOff, Send, X, ChevronDown, Sparkles } from 'lucide-react';
import { isSaasMode } from '@/lib/saas/config';
import { fetchPublicConfig } from '@/lib/saas/api';

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

  const sendMessage = async (text: string) => {
    const q = text.trim();
    if (!q || loading || !aiAvailable) return;
    setInput('');
    setError(null);

    const newUserMsg: Message = { role: 'user', content: q };
    const updatedMessages = [...messages, newUserMsg];
    setMessages(updatedMessages);
    setLoading(true);

    const assistantIndex = updatedMessages.length;
    setMessages((prev) => [...prev, { role: 'assistant', content: '', streaming: true }]);

    try {
      const systemPrompt = await buildTaxContext(year);
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
    'flex items-center justify-center rounded-full shadow-xl transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet/40 focus-visible:ring-offset-2';

  if (!aiAvailable) {
    return (
      <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3">
        <span className="hidden rounded-full border border-white/10 bg-elev-2/95 px-3 py-1.5 text-xs font-medium text-low shadow-lg sm:inline">
          AI advisor unavailable
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          title="AI Tax Advisor — not configured on server"
          className={`${fabClass} h-14 w-14 bg-elev-3 ring-2 ring-white/10 hover:bg-elev-3`}
        >
          <Bot className="h-7 w-7 text-low" />
        </button>
        {open && (
          <div className="absolute bottom-16 right-0 w-72 rounded-xl border border-white/10 bg-elev-1 p-4 shadow-xl">
            <p className="text-sm text-low">
              {saas ? (
                <>
                  AI Tax Advisor is disabled or the server OpenRouter key is not set. Ask your admin to enable{' '}
                  <strong className="text-mid">AI Tax Advisor</strong> and add an OpenRouter key in Settings.
                </>
              ) : (
                <>
                  AI Tax Advisor needs an <strong className="text-mid">OpenRouter API key</strong> in Settings → AI
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
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {open && (
        <div className="flex h-[560px] w-[380px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-elev-1 shadow-2xl">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-elev-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-gain" />
              <span className="text-sm font-semibold text-mid">AI Tax Advisor</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                  className="appearance-none rounded border border-white/10 bg-elev-3 py-0.5 pl-2 pr-6 text-xs text-low focus:outline-none"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {getFyLabel(y, jurisdiction)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1 top-1 h-3 w-3 text-low" />
              </div>
              <button onClick={() => setOpen(false)} className="text-low hover:text-mid">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-xs text-low">
                  Ask anything about your crypto taxes. All data stays on your device.
                </p>
                <div className="space-y-1.5">
                  {SUGGESTED_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => void sendMessage(q)}
                      className="block w-full rounded-lg border border-white/10 bg-elev-2 px-3 py-2 text-left text-xs text-low hover:border-violet hover:bg-elev-3"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-violet text-white'
                      : 'bg-elev-2 text-mid'
                  }`}
                >
                  <MessageContent content={msg.content} streaming={msg.streaming} />
                </div>
              </div>
            ))}

            {error && (
              <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
                {error}
              </div>
            )}
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-white/10 p-3">
            <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-elev-2 px-3 py-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your taxes…"
                rows={1}
                className="flex-1 resize-none bg-transparent text-xs text-mid placeholder:text-low focus:outline-none"
                style={{ maxHeight: '80px' }}
              />
              {hasSpeech && (
                <button
                  onClick={toggleVoice}
                  title={listening ? 'Stop recording' : 'Speak your question'}
                  className={`shrink-0 ${listening ? 'text-loss animate-pulse' : 'text-low hover:text-mid'}`}
                >
                  {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
              )}
              <button
                onClick={() => void sendMessage(input)}
                disabled={loading || !input.trim()}
                className="shrink-0 text-gain disabled:text-low hover:text-gain/80"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-right text-[10px] text-low">
              {AI_MODELS.find((m) => m.id === aiModel)?.label ?? aiModel} · OpenRouter
            </p>
          </div>
        </div>
      )}

      {/* FAB — prominent */}
      <div className="flex items-center gap-3">
        {!open && (
          <span className="hidden animate-pulse rounded-full border border-violet/40 bg-gain/10 px-3 py-1.5 text-xs font-semibold text-gain shadow-lg sm:inline">
            <Sparkles className="mr-1 inline h-3.5 w-3.5" />
            Ask AI
          </span>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          title="AI Tax Advisor — ask about your taxes"
          className={`${fabClass} h-16 w-16 ${
            open
              ? 'bg-violet ring-4 ring-violet/30 text-white'
              : 'bg-gradient-to-br from-violet to-blue ring-4 ring-violet/40 text-white hover:scale-105 hover:shadow-2xl hover:shadow-glow'
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
    return <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-low" />;
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
      {streaming && <span className="ml-1 inline-block h-2 w-1 animate-pulse bg-low" />}
    </span>
  );
}
