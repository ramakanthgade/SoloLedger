import { useEffect, useRef, useState, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/storage/db';
import { streamChatCompletion, AI_MODELS, DEFAULT_AI_MODEL, type ChatMessage } from '@/lib/ai/openrouter';
import { buildTaxContext } from '@/lib/ai/taxContext';
import { getAvailableFys, getCurrentFy, getFyLabel } from '@/lib/utils';
import type { Jurisdiction } from '@/types/transaction';
import { Bot, Mic, MicOff, Send, X, ChevronDown } from 'lucide-react';

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
  const settingsRow = useLiveQuery(() => db.settings.get('singleton'), []);
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const aiApiKey = settingsRow?.aiApiKey;
  const aiModel = settingsRow?.aiModel ?? DEFAULT_AI_MODEL;
  const jurisdiction = (settingsRow?.jurisdiction ?? 'IN') as Jurisdiction;

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
    if (!q || loading || !aiApiKey) return;
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

  if (!aiApiKey) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <button
          onClick={() => setOpen((o) => !o)}
          title="AI Tax Advisor — add OpenRouter API key in Settings to enable"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-ink-700 shadow-lg ring-1 ring-ink-600 transition hover:bg-ink-600"
        >
          <Bot className="h-6 w-6 text-mist-400" />
        </button>
        {open && (
          <div className="absolute bottom-16 right-0 w-72 rounded-xl border border-ink-600 bg-ink-900 p-4 shadow-xl">
            <p className="text-sm text-mist-300">
              AI Tax Advisor needs an{' '}
              <strong className="text-mist">OpenRouter API key</strong>.
            </p>
            <p className="mt-2 text-xs text-mist-400">
              Go to <strong>Settings → AI Advisor</strong> and paste your key from{' '}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer"
                className="text-violet underline"
              >
                openrouter.ai/keys
              </a>
              . Your existing credits there work immediately.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
      {open && (
        <div className="flex h-[560px] w-[380px] flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-ink-700 bg-ink-800 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-violet" />
              <span className="text-sm font-semibold text-mist">AI Tax Advisor</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                  className="appearance-none rounded border border-ink-600 bg-ink-700 py-0.5 pl-2 pr-6 text-xs text-mist-300 focus:outline-none"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {getFyLabel(y, jurisdiction)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1 top-1 h-3 w-3 text-mist-400" />
              </div>
              <button onClick={() => setOpen(false)} className="text-mist-400 hover:text-mist">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-xs text-mist-400">
                  Ask anything about your crypto taxes. All data stays on your device.
                </p>
                <div className="space-y-1.5">
                  {SUGGESTED_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => void sendMessage(q)}
                      className="block w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-left text-xs text-mist-300 hover:border-violet hover:bg-ink-700"
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
                      : 'bg-ink-800 text-mist-200'
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
          <div className="shrink-0 border-t border-ink-700 p-3">
            <div className="flex items-end gap-2 rounded-xl border border-ink-600 bg-ink-800 px-3 py-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about your taxes…"
                rows={1}
                className="flex-1 resize-none bg-transparent text-xs text-mist placeholder:text-mist-400 focus:outline-none"
                style={{ maxHeight: '80px' }}
              />
              {hasSpeech && (
                <button
                  onClick={toggleVoice}
                  title={listening ? 'Stop recording' : 'Speak your question'}
                  className={`shrink-0 ${listening ? 'text-loss animate-pulse' : 'text-mist-400 hover:text-mist'}`}
                >
                  {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
              )}
              <button
                onClick={() => void sendMessage(input)}
                disabled={loading || !input.trim()}
                className="shrink-0 text-violet disabled:text-mist-400 hover:text-violet/80"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-1 text-right text-[10px] text-mist-400">
              {AI_MODELS.find((m) => m.id === aiModel)?.label ?? aiModel} · OpenRouter
            </p>
          </div>
        </div>
      )}

      {/* FAB */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="AI Tax Advisor"
        className={`flex h-14 w-14 items-center justify-center rounded-full shadow-lg ring-1 transition ${
          open ? 'bg-violet ring-violet/40 text-white' : 'bg-ink-700 ring-ink-600 text-violet hover:bg-ink-600'
        }`}
      >
        {open ? <X className="h-5 w-5" /> : <Bot className="h-6 w-6" />}
      </button>
    </div>
  );
}

/** Render message content: preserve newlines and bold **text** */
function MessageContent({ content, streaming }: { content: string; streaming?: boolean }) {
  if (!content && streaming) {
    return <span className="inline-block h-3 w-3 animate-pulse rounded-full bg-mist-400" />;
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
      {streaming && <span className="ml-1 inline-block h-2 w-1 animate-pulse bg-mist-400" />}
    </span>
  );
}
