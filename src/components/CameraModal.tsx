import { useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, Upload, X } from 'lucide-react';

interface CameraModalProps {
  open: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string) => void;
  onPickFallbackFile: () => void;
}

export function CameraModal({
  open,
  onClose,
  onCapture,
  onPickFallbackFile,
}: CameraModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setReady(false);
      setErrorMsg(null);
      return;
    }

    let cancelled = false;

    async function startStream() {
      setReady(false);
      setErrorMsg(null);

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setErrorMsg('Câmera ao vivo indisponível neste navegador. Use a captura nativa do aparelho.');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setReady(true);
        }
      } catch {
        if (!cancelled) {
          setErrorMsg(
            'Não foi possível acessar a câmera ao vivo (verifique permissões do aparelho/WebView). Você pode usar a captura direta abaixo.',
          );
        }
      }
    }

    startStream();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [open, facingMode]);

  if (!open) return null;

  function handleShoot() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    onCapture(dataUrl);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Câmera para fotografar gráfico"
    >
      {/* Top Controls */}
      <div className="pt-safe flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent z-10">
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label="Fechar câmera"
        >
          <X className="h-5 w-5" />
        </button>

        <span className="text-sm font-medium text-white/90">
          Enquadre os candles e a escala de preços
        </span>

        <button
          type="button"
          onClick={() => setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
          aria-label="Alternar câmera"
        >
          <RefreshCw className="h-5 w-5" />
        </button>
      </div>

      {/* Live Video Preview */}
      <div className="relative flex-1 overflow-hidden flex items-center justify-center">
        {!errorMsg ? (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="h-full w-full object-cover"
            />
            {/* Alignment Grid Overlay */}
            <div className="pointer-events-none absolute inset-6 rounded-2xl border border-white/30">
              <div className="absolute inset-x-0 top-1/3 border-t border-white/15" />
              <div className="absolute inset-x-0 top-2/3 border-t border-white/15" />
              <div className="absolute inset-y-0 left-1/3 border-l border-white/15" />
              <div className="absolute inset-y-0 left-2/3 border-l border-white/15" />
            </div>
          </>
        ) : (
          <div className="mx-6 max-w-sm rounded-2xl border border-white/15 bg-slate-900/90 p-5 text-center space-y-4">
            <Camera className="mx-auto h-10 w-10 text-slate-300" />
            <p className="text-sm leading-relaxed text-slate-200">{errorMsg}</p>
            <button
              type="button"
              onClick={() => {
                onClose();
                onPickFallbackFile();
              }}
              className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
            >
              <Upload className="h-4 w-4" />
              <span>Abrir Câmera / Foto do Sistema</span>
            </button>
          </div>
        )}
      </div>

      {/* Bottom Shutter Bar */}
      <div className="pb-safe flex items-center justify-around px-6 py-5 bg-gradient-to-t from-black/90 to-transparent">
        <button
          type="button"
          onClick={() => {
            onClose();
            onPickFallbackFile();
          }}
          className="min-h-[44px] rounded-xl bg-white/10 px-4 py-2 text-xs font-medium text-white hover:bg-white/20"
        >
          Câmera do Aparelho
        </button>

        <button
          type="button"
          disabled={!ready}
          onClick={handleShoot}
          aria-label="Tirar fotografia do gráfico"
          className="flex h-[68px] w-[68px] items-center justify-center rounded-full border-4 border-white bg-white/20 transition-transform active:scale-95 disabled:opacity-40"
        >
          <span className="h-[52px] w-[52px] rounded-full bg-white" />
        </button>

        <div className="w-[100px]" aria-hidden="true" />
      </div>
    </div>
  );
}
