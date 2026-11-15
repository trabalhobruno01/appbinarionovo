import { useCallback, useEffect, useRef, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import {
  Camera,
  Image as ImageIcon,
  Menu,
  MessageSquarePlus,
  Moon,
  RotateCcw,
  SendHorizontal,
  Sun,
  X,
} from 'lucide-react';
import type { ChatMessage, Conversation } from '../shared/types.ts';
import { AnalysisCard } from './components/AnalysisCard.tsx';
import { CameraModal } from './components/CameraModal.tsx';
import { HistorySidebar } from './components/HistorySidebar.tsx';
import { ImageEditorModal } from './components/ImageEditorModal.tsx';
import { SignalAuditModal } from './components/SignalAuditModal.tsx';
import {
  analyzeChartRequest,
  deleteRemoteConversation,
  fetchBrasiliaTime,
  fetchRemoteConversations,
  saveRemoteConversation,
  sendChatFollowUp,
} from './services/api.ts';
import {
  captureNativePhoto,
  isNativeAndroid,
  pickNativeGalleryPhoto,
} from './services/camera.ts';
import { fileToDataUrl, validateImageFile } from './services/imageProcessor.ts';
import {
  deleteLocalConversation,
  getSavedTheme,
  loadLocalConversations,
  saveLocalConversation,
  saveTheme,
} from './services/storage.ts';

function formatClientBrt(unixMs: number): { dateBrt: string; timeBrt: string; shortTimeBrt: string; isoBrt: string } {
  const date = new Date(unixMs);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const dateBrt = `${parts.day}/${parts.month}/${parts.year}`;
  const timeBrt = `${hour}:${parts.minute}:${parts.second}`;
  return {
    dateBrt,
    timeBrt,
    shortTimeBrt: `${hour}:${parts.minute}`,
    isoBrt: `${parts.year}-${parts.month}-${parts.day}T${timeBrt}-03:00`,
  };
}

function createEmptyConversation(offsetMs: number): Conversation {
  const nowBrt = formatClientBrt(Date.now() + offsetMs);
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    title: 'Nova Análise',
    lastAsset: null,
    lastTimeframe: null,
    createdAtIso: nowBrt.isoBrt,
    updatedAtIso: nowBrt.isoBrt,
    updatedAtBrt: `${nowBrt.dateBrt} ${nowBrt.shortTimeBrt}`,
    messages: [],
  };
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => getSavedTheme());
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [liveTimeBrt, setLiveTimeBrt] = useState(() => formatClientBrt(Date.now()).timeBrt);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string>('');
  const [draftConv, setDraftConv] = useState<Conversation>(() => createEmptyConversation(0));

  const [inputText, setInputText] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [processingMode, setProcessingMode] = useState<'image' | 'text'>('image');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pendingRawImage, setPendingRawImage] = useState<string | null>(null);
  const [zoomedImageUrl, setZoomedImageUrl] = useState<string | null>(null);
  const [uiNotice, setUiNotice] = useState<string | null>(null);

  const cameraFallbackInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inFlightRef = useRef(false);

  const activeConversation =
    conversations.find((c) => c.id === activeConvId) || draftConv;

  // Apply light/dark theme to <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveTheme(theme);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'dark' ? '#0B0F17' : '#F8FAFC');
    }
  }, [theme]);

  const clockOffsetRef = useRef(0);

  // Synchronize Brasília time with server & tick every second (zero Gemini calls; paused when minimized)
  useEffect(() => {
    let active = true;
    async function syncClock() {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await fetchBrasiliaTime();
        if (!active) return;
        const offset = res.unixMs - Date.now();
        clockOffsetRef.current = offset;
        setClockOffsetMs(offset);
        setLiveTimeBrt(formatClientBrt(Date.now() + offset).timeBrt);
      } catch {
        // Keep current offset
      }
    }
    syncClock();
    const resyncTimer = setInterval(syncClock, 60_000);
    const tickTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setLiveTimeBrt(formatClientBrt(Date.now() + clockOffsetRef.current).timeBrt);
    }, 1000);

    const onVisibility = () => {
      if (!document.hidden) {
        setLiveTimeBrt(formatClientBrt(Date.now() + clockOffsetRef.current).timeBrt);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      clearInterval(resyncTimer);
      clearInterval(tickTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Load persisted conversations (IndexedDB + remote sync)
  useEffect(() => {
    let mounted = true;
    async function loadHistory() {
      const local = await loadLocalConversations();
      if (!mounted) return;
      if (local.length > 0) {
        setConversations(local);
        setActiveConvId(local[0].id);
      }
      const remote = await fetchRemoteConversations();
      if (!mounted || remote.length === 0) return;

      // Merge remote and local by updatedAtIso
      const mergedMap = new Map<string, Conversation>();
      for (const c of [...remote, ...local]) {
        const existing = mergedMap.get(c.id);
        if (!existing || c.updatedAtIso > existing.updatedAtIso) {
          mergedMap.set(c.id, c);
        }
      }
      const merged = Array.from(mergedMap.values()).sort((a, b) =>
        b.updatedAtIso.localeCompare(a.updatedAtIso),
      );
      setConversations(merged);
      if (local.length === 0 && merged.length > 0) {
        setActiveConvId(merged[0].id);
      }
    }
    loadHistory();
    return () => {
      mounted = false;
    };
  }, []);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation.messages.length, isAnalyzing]);

  // Live elapsed timer while AI request is running
  useEffect(() => {
    if (!isAnalyzing) {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [isAnalyzing]);

  // Android WebView hardware back button support
  useEffect(() => {
    let listenerHandle: { remove: () => Promise<void> } | null = null;
    try {
      CapacitorApp.addListener('backButton', ({ canGoBack }) => {
        if (zoomedImageUrl) {
          setZoomedImageUrl(null);
        } else if (auditOpen) {
          setAuditOpen(false);
        } else if (pendingRawImage) {
          setPendingRawImage(null);
        } else if (cameraOpen) {
          setCameraOpen(false);
        } else if (historyOpen) {
          setHistoryOpen(false);
        } else if (canGoBack) {
          window.history.back();
        } else {
          CapacitorApp.exitApp();
        }
      }).then((handle) => {
        listenerHandle = handle;
      });
    } catch {
      // Not running inside Capacitor native shell
    }

    return () => {
      listenerHandle?.remove().catch(() => {});
    };
  }, [zoomedImageUrl, auditOpen, pendingRawImage, cameraOpen, historyOpen]);

  const persistConversation = useCallback(async (conv: Conversation, syncRemote = true) => {
    setConversations((prev) => {
      const next = [conv, ...prev.filter((c) => c.id !== conv.id)].sort((a, b) =>
        b.updatedAtIso.localeCompare(a.updatedAtIso),
      );
      return next;
    });
    setActiveConvId(conv.id);
    await saveLocalConversation(conv);
    if (syncRemote) {
      void saveRemoteConversation(conv);
    }
  }, []);

  const handleNewChat = useCallback(() => {
    const fresh = createEmptyConversation(clockOffsetMs);
    setDraftConv(fresh);
    setActiveConvId('');
    setInputText('');
    setUiNotice(null);
  }, [clockOffsetMs]);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== id);
        if (activeConvId === id) {
          if (filtered.length > 0) {
            setActiveConvId(filtered[0].id);
          } else {
            const fresh = createEmptyConversation(clockOffsetMs);
            setDraftConv(fresh);
            setActiveConvId('');
          }
        }
        return filtered;
      });
      await deleteLocalConversation(id);
      await deleteRemoteConversation(id);
    },
    [activeConvId, clockOffsetMs],
  );

  const handleOpenCamera = async () => {
    setUiNotice(null);
    if (isNativeAndroid()) {
      try {
        const dataUrl = await captureNativePhoto();
        if (dataUrl) {
          setPendingRawImage(dataUrl);
        }
        return;
      } catch {
        // Fallback to WebRTC / file input if Capacitor permission denied
      }
    }
    setCameraOpen(true);
  };

  const handleOpenGallery = async () => {
    setUiNotice(null);
    if (isNativeAndroid()) {
      try {
        const dataUrl = await pickNativeGalleryPhoto();
        if (dataUrl) {
          setPendingRawImage(dataUrl);
        }
        return;
      } catch {
        // Fallback to file input
      }
    }
    galleryInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const validationError = validateImageFile(file);
    if (validationError) {
      setUiNotice(validationError);
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      setPendingRawImage(dataUrl);
    } catch (err) {
      setUiNotice(err instanceof Error ? err.message : 'Erro ao abrir fotografia.');
    }
  };

  const handleSendImageForAnalysis = async (processedDataUrl: string, caption: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPendingRawImage(null);
    setUiNotice(null);
    setProcessingMode('image');
    setIsAnalyzing(true);

    const nowBrt = formatClientBrt(Date.now() + clockOffsetMs);
    const photoTimestamp = `${nowBrt.dateBrt} ${nowBrt.timeBrt}`;

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      text: caption || 'Analisar fotografia do gráfico',
      imageDataUrl: processedDataUrl,
      photoCapturedAtBrt: photoTimestamp,
      createdAtIso: nowBrt.isoBrt,
      createdAtBrt: `${nowBrt.shortTimeBrt} BRT`,
    };

    const baseConv = activeConversation;
    const convWithUser: Conversation = {
      ...baseConv,
      updatedAtIso: nowBrt.isoBrt,
      updatedAtBrt: `${nowBrt.dateBrt} ${nowBrt.shortTimeBrt}`,
      messages: [...baseConv.messages, userMsg],
    };

    // Save locally without waiting for remote /api/conversations upload before calling /api/analyze
    void persistConversation(convWithUser, false);

    try {
      const result = await analyzeChartRequest({
        imageDataUrl: processedDataUrl,
        userMessage: caption || undefined,
        photoReceivedAtBrt: photoTimestamp,
        history: baseConv.messages,
      });

      const syncedOffset = result.timeSync.unixMs - Date.now();
      setClockOffsetMs(syncedOffset);

      const assetLabel = result.analysis.asset || convWithUser.lastAsset || 'Gráfico Financeiro';
      const tfLabel = result.analysis.timeframe || convWithUser.lastTimeframe;

      const aiMsg: ChatMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        text: result.analysis.formattedReport,
        analysis: result.analysis,
        marketQuote: result.marketQuote,
        createdAtIso: result.timeSync.isoBrt,
        createdAtBrt: `${result.timeSync.shortTimeBrt} BRT`,
      };

      const updatedConv: Conversation = {
        ...convWithUser,
        title:
          convWithUser.title === 'Nova Análise' || convWithUser.messages.length <= 1
            ? `${assetLabel}${tfLabel ? ` · ${tfLabel}` : ''}`
            : convWithUser.title,
        lastAsset: result.analysis.asset || convWithUser.lastAsset,
        lastTimeframe: result.analysis.timeframe || convWithUser.lastTimeframe,
        updatedAtIso: result.timeSync.isoBrt,
        updatedAtBrt: `${result.timeSync.dateBrt} ${result.timeSync.shortTimeBrt}`,
        messages: [...convWithUser.messages, aiMsg],
      };

      await persistConversation(updatedConv);
    } catch (err) {
      const failTime = formatClientBrt(Date.now() + clockOffsetMs);
      const errMsg: ChatMessage = {
        id: `msg_${Date.now()}_err`,
        role: 'assistant',
        text:
          err instanceof Error
            ? `Não foi possível concluir a análise: ${err.message}`
            : 'Falha de comunicação com o servidor de análise.',
        createdAtIso: failTime.isoBrt,
        createdAtBrt: `${failTime.shortTimeBrt} BRT`,
        error: true,
      };
      await persistConversation({
        ...convWithUser,
        messages: [...convWithUser.messages, errMsg],
      });
    } finally {
      setIsAnalyzing(false);
      inFlightRef.current = false;
    }
  };

  const handleSendText = async (overrideText?: string) => {
    const text = (overrideText ?? inputText).trim();
    if (!text || inFlightRef.current) return;

    inFlightRef.current = true;
    if (!overrideText) setInputText('');
    setUiNotice(null);
    setProcessingMode('text');
    setIsAnalyzing(true);

    const nowBrt = formatClientBrt(Date.now() + clockOffsetMs);
    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      text,
      createdAtIso: nowBrt.isoBrt,
      createdAtBrt: `${nowBrt.shortTimeBrt} BRT`,
    };

    const convWithUser: Conversation = {
      ...activeConversation,
      updatedAtIso: nowBrt.isoBrt,
      updatedAtBrt: `${nowBrt.dateBrt} ${nowBrt.shortTimeBrt}`,
      messages: [...activeConversation.messages, userMsg],
    };

    void persistConversation(convWithUser, false);

    try {
      const res = await sendChatFollowUp({
        messages: convWithUser.messages,
        userMessage: text,
        lastAsset: convWithUser.lastAsset,
        lastTimeframe: convWithUser.lastTimeframe,
      });

      const syncedOffset = res.timeSync.unixMs - Date.now();
      setClockOffsetMs(syncedOffset);

      const aiMsg: ChatMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        text: res.replyText,
        analysis: res.analysis,
        marketQuote: res.marketQuote,
        createdAtIso: res.timeSync.isoBrt,
        createdAtBrt: `${res.timeSync.shortTimeBrt} BRT`,
      };

      const nextAsset = res.analysis?.asset || res.marketQuote?.displayName || convWithUser.lastAsset;
      const nextTf = res.analysis?.timeframe || convWithUser.lastTimeframe;
      const fallbackTitle = text.length > 38 ? `${text.slice(0, 38)}…` : text;
      const nextTitle =
        convWithUser.title === 'Nova Análise'
          ? nextAsset
            ? `${nextAsset}${nextTf ? ` · ${nextTf}` : ''}`
            : fallbackTitle
          : convWithUser.title;

      await persistConversation({
        ...convWithUser,
        title: nextTitle,
        lastAsset: res.analysis?.asset || (res.marketQuote?.available ? res.marketQuote.symbol : convWithUser.lastAsset),
        lastTimeframe: nextTf,
        updatedAtIso: res.timeSync.isoBrt,
        updatedAtBrt: `${res.timeSync.dateBrt} ${res.timeSync.shortTimeBrt}`,
        messages: [...convWithUser.messages, aiMsg],
      });
    } catch (err) {
      const failTime = formatClientBrt(Date.now() + clockOffsetMs);
      const errMsg: ChatMessage = {
        id: `msg_${Date.now()}_err`,
        role: 'assistant',
        text:
          err instanceof Error
            ? `Falha ao consultar resposta: ${err.message}`
            : 'Erro ao processar sua pergunta.',
        createdAtIso: failTime.isoBrt,
        createdAtBrt: `${failTime.shortTimeBrt} BRT`,
        error: true,
      };
      await persistConversation({
        ...convWithUser,
        messages: [...convWithUser.messages, errMsg],
      });
    } finally {
      setIsAnalyzing(false);
      inFlightRef.current = false;
    }
  };

  const handleRetryLastMessage = () => {
    const msgs = activeConversation.messages;
    const lastUserMsg = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;

    if (lastUserMsg.imageDataUrl) {
      handleSendImageForAnalysis(lastUserMsg.imageDataUrl, lastUserMsg.text);
    } else {
      handleSendText(lastUserMsg.text);
    }
  };

  const latestAssistantId = [...activeConversation.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && !m.error)?.id;

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-slate-50 text-slate-900 dark:bg-[#0B0F17] dark:text-slate-100">
      {/* Hidden native/WebView file inputs */}
      <input
        ref={cameraFallbackInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileSelected}
        className="hidden"
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelected}
        className="hidden"
      />

      {/* History Sidebar / Mobile Drawer */}
      <HistorySidebar
        open={historyOpen}
        conversations={conversations}
        activeId={activeConversation.id}
        onSelect={(id) => setActiveConvId(id)}
        onNewChat={handleNewChat}
        onDelete={handleDeleteConversation}
        onOpenAudit={() => setAuditOpen(true)}
        onClose={() => setHistoryOpen(false)}
      />

      {/* Main Chat Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact 56px Top Bar */}
        <header className="pt-safe flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white/90 px-3 backdrop-blur-md sm:px-5 dark:border-slate-800/90 dark:bg-[#0B0F17]/90">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label="Abrir histórico de conversas"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="font-display text-base font-bold tracking-tight whitespace-nowrap shrink-0">
              ChartPulse AI
            </h1>
          </div>

          <div className="flex items-center gap-1 sm:gap-2">
            <div
              className="font-mono-tabular text-xs font-medium text-slate-600 dark:text-slate-400 whitespace-nowrap px-2"
              title="Horário oficial sincronizado de Brasília"
            >
              {liveTimeBrt} BRT
            </div>

            <button
              type="button"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={handleNewChat}
              aria-label="Nova conversa"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <MessageSquarePlus className="h-5 w-5" />
            </button>
          </div>
        </header>

        {/* Scrollable Chat Messages */}
        <main className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
          <div className="mx-auto flex max-w-3xl flex-col space-y-5">
            {activeConversation.messages.length === 0 ? (
              <div className="flex min-h-[60dvh] flex-col items-center justify-center text-center px-3">
                <h2 className="font-display max-w-md text-2xl font-bold tracking-tight text-balance text-slate-900 sm:text-3xl dark:text-slate-100">
                  Fotografe o gráfico para analisar agora
                </h2>
                <p className="mt-2.5 max-w-md text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  Aponte a câmera para a tela do computador ou celular. A IA avalia os candles, consulta a cotação atual e indica compra, venda ou aguardar no horário de Brasília.
                </p>

                <div className="mt-7 flex w-full max-w-sm flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={handleOpenCamera}
                    className="flex min-h-[52px] flex-1 items-center justify-center gap-2.5 rounded-2xl bg-emerald-500 px-5 text-sm font-semibold text-slate-950 transition-transform hover:bg-emerald-400 active:scale-[0.98]"
                  >
                    <Camera className="h-5 w-5" />
                    <span>Fotografar Gráfico</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleOpenGallery}
                    className="flex min-h-[52px] flex-1 items-center justify-center gap-2.5 rounded-2xl border border-slate-300 bg-white px-5 text-sm font-semibold text-slate-900 transition-transform hover:bg-slate-100 active:scale-[0.98] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                  >
                    <ImageIcon className="h-5 w-5" />
                    <span>Galeria</span>
                  </button>
                </div>
              </div>
            ) : (
              activeConversation.messages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    <div
                      className={`max-w-[92%] sm:max-w-[85%] rounded-2xl ${
                        isUser
                          ? 'bg-slate-900 text-white p-3.5 dark:bg-slate-800'
                          : msg.error
                            ? 'border border-rose-500/40 bg-rose-500/10 p-4 text-rose-700 dark:text-rose-300'
                            : 'w-full border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-[#131924]'
                      }`}
                    >
                      {msg.imageDataUrl && (
                        <button
                          type="button"
                          onClick={() => setZoomedImageUrl(msg.imageDataUrl || null)}
                          className="mb-2.5 block overflow-hidden rounded-xl border border-white/10"
                          aria-label="Ampliar fotografia enviada"
                        >
                          <img
                            src={msg.imageDataUrl}
                            alt="Fotografia do gráfico enviada"
                            referrerPolicy="no-referrer"
                            className="max-h-64 w-auto object-contain"
                          />
                        </button>
                      )}

                      {msg.analysis ? (
                        <div className="space-y-3">
                          {msg.text &&
                            !msg.text.startsWith('DECISÃO:') &&
                            !msg.text.startsWith('SINAL EXPIRADO') && (
                              <p className="text-sm leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-line">
                                {msg.text}
                              </p>
                            )}
                          <AnalysisCard
                            analysis={msg.analysis}
                            marketQuote={msg.marketQuote}
                            showQuickActions={msg.id === latestAssistantId}
                            onQuickFollowUp={(q) => handleSendText(q)}
                            disabled={isAnalyzing}
                          />
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-sm leading-relaxed whitespace-pre-line">
                            {msg.text}
                          </p>
                          {msg.error && (
                            <button
                              type="button"
                              onClick={handleRetryLastMessage}
                              disabled={isAnalyzing}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              <span>Tentar Novamente</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <span className="mt-1 px-1 font-mono-tabular text-[11px] text-slate-500 dark:text-slate-400">
                      {isUser ? 'Você' : 'Analista IA'} · {msg.createdAtBrt}
                    </span>
                  </div>
                );
              })
            )}

            {isAnalyzing && (
              <div className="flex items-start">
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 dark:border-slate-800 dark:bg-[#131924] dark:text-slate-300">
                  <span>
                    {processingMode === 'image'
                      ? 'Analisando candles da imagem, consultando cotação e sincronizando horário de Brasília...'
                      : 'Consultando cotação atual e gerando resposta...'}
                  </span>
                  {elapsedSec > 0 && (
                    <span className="ml-2 font-mono-tabular text-xs text-slate-400">
                      {elapsedSec}s
                    </span>
                  )}
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </main>

        {/* Notice banner if validation error occurs */}
        {uiNotice && (
          <div className="mx-auto mb-1 flex max-w-3xl items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">
            <span>{uiNotice}</span>
            <button
              type="button"
              onClick={() => setUiNotice(null)}
              aria-label="Fechar aviso"
              className="p-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Bottom Thumb-Zone Composer */}
        <footer className="pb-safe shrink-0 border-t border-slate-200 bg-white/95 px-2.5 pt-2.5 backdrop-blur-md sm:px-4 dark:border-slate-800/90 dark:bg-[#0B0F17]/95">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendText();
            }}
            className="mx-auto flex max-w-3xl items-end gap-1.5 sm:gap-2"
          >
            <button
              type="button"
              onClick={handleOpenCamera}
              disabled={isAnalyzing}
              aria-label="Fotografar gráfico com a câmera"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-500 text-slate-950 transition-transform hover:bg-emerald-400 active:scale-95 disabled:opacity-50"
            >
              <Camera className="h-5 w-5" />
            </button>

            <button
              type="button"
              onClick={handleOpenGallery}
              disabled={isAnalyzing}
              aria-label="Selecionar fotografia da galeria"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-100 text-slate-700 transition-transform hover:bg-slate-200 active:scale-95 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <ImageIcon className="h-5 w-5" />
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={isAnalyzing}
              placeholder="Pergunte sobre a análise ou envie foto..."
              className="h-12 min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-100 px-4 text-sm text-slate-900 placeholder:text-slate-500 focus:border-emerald-500 focus:bg-white focus:outline-none disabled:opacity-60 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:bg-slate-900"
            />

            <button
              type="submit"
              disabled={isAnalyzing || !inputText.trim()}
              aria-label="Enviar mensagem"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white transition-transform hover:bg-slate-800 active:scale-95 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
            >
              <SendHorizontal className="h-5 w-5" />
            </button>
          </form>
        </footer>
      </div>

      {/* In-App Rear Camera Modal */}
      <CameraModal
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(dataUrl) => {
          setCameraOpen(false);
          setPendingRawImage(dataUrl);
        }}
        onPickFallbackFile={() => cameraFallbackInputRef.current?.click()}
      />

      {/* Image Crop, Rotate & Replace Modal */}
      <ImageEditorModal
        sourceDataUrl={pendingRawImage}
        onCancel={() => setPendingRawImage(null)}
        onReplace={() => {
          setPendingRawImage(null);
          handleOpenCamera();
        }}
        onConfirmSend={handleSendImageForAnalysis}
      />

      {/* Fullscreen Photo Lightbox */}
      {zoomedImageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4"
          onClick={() => setZoomedImageUrl(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Visualizar fotografia ampliada"
        >
          <button
            type="button"
            onClick={() => setZoomedImageUrl(null)}
            aria-label="Fechar visualização"
            className="absolute right-4 top-4 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={zoomedImageUrl}
            alt="Fotografia ampliada do gráfico"
            referrerPolicy="no-referrer"
            className="max-h-[90dvh] max-w-full rounded-lg object-contain"
          />
        </div>
      )}
      {/* Independent Signal Validation & Backtest Modal */}
      <SignalAuditModal open={auditOpen} onClose={() => setAuditOpen(false)} />
    </div>
  );
}
