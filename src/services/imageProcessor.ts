export interface CropRect {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  width: number; // normalized 0..1
  height: number; // normalized 0..1
}

const MAX_DIMENSION = 1280;
const MAX_BYTES = 650 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export function validateImageFile(file: File): string | null {
  if (file.type && !ALLOWED_TYPES.has(file.type.toLowerCase()) && !file.type.startsWith('image/')) {
    return 'Arquivo inválido. Selecione uma fotografia (JPEG, PNG ou WebP).';
  }
  if (file.size > 25 * 1024 * 1024) {
    return 'A imagem selecionada é muito grande (limite de 25 MB antes da compressão).';
  }
  return null;
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Falha ao ler arquivo de imagem.'));
      }
    };
    reader.onerror = () => reject(new Error('Erro ao carregar imagem selecionada.'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não foi possível decodificar a fotografia.'));
    img.src = src;
  });
}

function encodeCanvasWithinLimit(canvas: HTMLCanvasElement): string {
  let quality = 0.85;
  let output = canvas.toDataURL('image/jpeg', quality);
  while (output.length > MAX_BYTES * 1.37 && quality > 0.58) {
    quality -= 0.06;
    output = canvas.toDataURL('image/jpeg', quality);
  }
  return output;
}

export async function processChartImage(
  sourceDataUrl: string,
  cropRect: CropRect = { x: 0, y: 0, width: 1, height: 1 },
  rotationDeg = 0,
): Promise<{ dataUrl: string; width: number; height: number; sizeKb: number }> {
  const img = await loadImageElement(sourceDataUrl);

  // First render rotated full image to offscreen canvas
  const normalizedRot = ((rotationDeg % 360) + 360) % 360;
  const swapDims = normalizedRot === 90 || normalizedRot === 270;
  const rotWidth = swapDims ? img.naturalHeight : img.naturalWidth;
  const rotHeight = swapDims ? img.naturalWidth : img.naturalHeight;

  const rotCanvas = document.createElement('canvas');
  rotCanvas.width = rotWidth;
  rotCanvas.height = rotHeight;
  const rotCtx = rotCanvas.getContext('2d');
  if (!rotCtx) throw new Error('Contexto gráfico indisponível no navegador.');

  rotCtx.save();
  rotCtx.translate(rotWidth / 2, rotHeight / 2);
  rotCtx.rotate((normalizedRot * Math.PI) / 180);
  rotCtx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  rotCtx.restore();

  // Compute crop region in pixels
  const sx = Math.max(0, Math.round(cropRect.x * rotWidth));
  const sy = Math.max(0, Math.round(cropRect.y * rotHeight));
  const sw = Math.max(32, Math.min(rotWidth - sx, Math.round(cropRect.width * rotWidth)));
  const sh = Math.max(32, Math.min(rotHeight - sy, Math.round(cropRect.height * rotHeight)));

  // Smart scale preserving candle & price-axis legibility up to 1600px max side
  const scale = Math.min(1, MAX_DIMENSION / Math.max(sw, sh));
  const targetW = Math.max(1, Math.round(sw * scale));
  const targetH = Math.max(1, Math.round(sh * scale));

  const outCanvas = document.createElement('canvas');
  outCanvas.width = targetW;
  outCanvas.height = targetH;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Contexto gráfico indisponível no navegador.');

  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(rotCanvas, sx, sy, sw, sh, 0, 0, targetW, targetH);

  const dataUrl = encodeCanvasWithinLimit(outCanvas);
  const approxBytes = Math.round((dataUrl.length * 3) / 4);

  return {
    dataUrl,
    width: targetW,
    height: targetH,
    sizeKb: Math.max(1, Math.round(approxBytes / 1024)),
  };
}
