import { useEffect, useRef, useState } from 'react';
import { Check, Crop, RotateCw, RefreshCcw, X } from 'lucide-react';
import { processChartImage, type CropRect } from '../services/imageProcessor.ts';

interface ImageEditorModalProps {
  sourceDataUrl: string | null;
  onCancel: () => void;
  onReplace: () => void;
  onConfirmSend: (processedDataUrl: string, caption: string) => void;
}

export function ImageEditorModal({
  sourceDataUrl,
  onCancel,
  onReplace,
  onConfirmSend,
}: ImageEditorModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rotation, setRotation] = useState(0);
  const [crop, setCrop] = useState<CropRect>({ x: 0.04, y: 0.06, width: 0.92, height: 0.88 });
  const [caption, setCaption] = useState('');
  const [processing, setProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dragState, setDragState] = useState<{
    mode: 'move' | 'nw' | 'se';
    startX: number;
    startY: number;
    orig: CropRect;
  } | null>(null);

  useEffect(() => {
    setRotation(0);
    setCrop({ x: 0.04, y: 0.06, width: 0.92, height: 0.88 });
    setCaption('');
    setErrorMsg(null);
  }, [sourceDataUrl]);

  useEffect(() => {
    if (!dragState) return;

    function onMove(ev: PointerEvent) {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0 || !dragState) return;

      const dx = (ev.clientX - dragState.startX) / box.width;
      const dy = (ev.clientY - dragState.startY) / box.height;
      const { orig, mode } = dragState;

      if (mode === 'move') {
        const nx = Math.max(0, Math.min(1 - orig.width, orig.x + dx));
        const ny = Math.max(0, Math.min(1 - orig.height, orig.y + dy));
        setCrop({ ...orig, x: nx, y: ny });
      } else if (mode === 'nw') {
        const nx = Math.max(0, Math.min(orig.x + orig.width - 0.15, orig.x + dx));
        const ny = Math.max(0, Math.min(orig.y + orig.height - 0.15, orig.y + dy));
        setCrop({
          x: nx,
          y: ny,
          width: orig.x + orig.width - nx,
          height: orig.y + orig.height - ny,
        });
      } else if (mode === 'se') {
        const nw = Math.max(0.15, Math.min(1 - orig.x, orig.width + dx));
        const nh = Math.max(0.15, Math.min(1 - orig.y, orig.height + dy));
        setCrop({ ...orig, width: nw, height: nh });
      }
    }

    function onUp() {
      setDragState(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragState]);

  if (!sourceDataUrl) return null;

  async function handleConfirm() {
    if (!sourceDataUrl || processing) return;
    setProcessing(true);
    setErrorMsg(null);
    try {
      const result = await processChartImage(sourceDataUrl, crop, rotation);
      onConfirmSend(result.dataUrl, caption.trim());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Falha ao preparar a imagem.');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-slate-100"
      role="dialog"
      aria-modal="true"
      aria-label="Ajustar e recortar fotografia do gráfico"
    >
      {/* Header */}
      <div className="pt-safe flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-slate-300 hover:bg-slate-800"
          aria-label="Cancelar envio"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="font-display text-sm font-semibold">
          Ajustar Fotografia do Gráfico
        </h2>

        <button
          type="button"
          onClick={onReplace}
          className="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-slate-300 hover:bg-slate-800"
        >
          <RefreshCcw className="h-4 w-4" />
          <span>Substituir</span>
        </button>
      </div>

      {/* Crop Canvas Area */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black p-4">
        <div
          ref={containerRef}
          className="relative max-h-full max-w-full select-none overflow-hidden rounded-lg"
        >
          <img
            src={sourceDataUrl}
            alt="Prévia do gráfico capturado"
            style={{ transform: `rotate(${rotation}deg)` }}
            className="max-h-[58dvh] w-auto object-contain transition-transform duration-150"
          />

          {/* Interactive Crop Rectangle Overlay */}
          <div
            onPointerDown={(e) => {
              e.stopPropagation();
              setDragState({ mode: 'move', startX: e.clientX, startY: e.clientY, orig: crop });
            }}
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.width * 100}%`,
              height: `${crop.height * 100}%`,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
            }}
            className="absolute cursor-move touch-none border-2 border-emerald-400"
          >
            {/* Top-left handle */}
            <button
              type="button"
              aria-label="Ajustar canto superior esquerdo"
              onPointerDown={(e) => {
                e.stopPropagation();
                setDragState({ mode: 'nw', startX: e.clientX, startY: e.clientY, orig: crop });
              }}
              className="absolute -left-3 -top-3 h-7 w-7 touch-none rounded-full border-2 border-emerald-400 bg-slate-950"
            />
            {/* Bottom-right handle */}
            <button
              type="button"
              aria-label="Ajustar canto inferior direito"
              onPointerDown={(e) => {
                e.stopPropagation();
                setDragState({ mode: 'se', startX: e.clientX, startY: e.clientY, orig: crop });
              }}
              className="absolute -bottom-3 -right-3 h-7 w-7 touch-none rounded-full border-2 border-emerald-400 bg-slate-950"
            />
          </div>
        </div>
      </div>

      {/* Tools & Send Footer */}
      <div className="pb-safe space-y-3 border-t border-slate-800 bg-slate-950 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              <RotateCw className="h-4 w-4" />
              <span>Girar 90°</span>
            </button>
            <button
              type="button"
              onClick={() => setCrop({ x: 0, y: 0, width: 1, height: 1 })}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              <Crop className="h-4 w-4" />
              <span>Tela Cheia</span>
            </button>
          </div>
          <span className="text-[11px] text-slate-400">
            Arraste para recortar
          </span>
        </div>

        {errorMsg && (
          <p className="text-xs font-medium text-rose-400">{errorMsg}</p>
        )}

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Opcional: informe ativo ou timeframe (ex: BTC 5m)"
            className="min-h-[48px] flex-1 rounded-xl border border-slate-800 bg-slate-900 px-3.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={processing}
            onClick={handleConfirm}
            className="inline-flex min-h-[48px] shrink-0 items-center gap-2 rounded-xl bg-emerald-500 px-5 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            <span>{processing ? 'Preparando...' : 'Analisar'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
