import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';

export function isNativeAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function captureNativePhoto(): Promise<string | null> {
  if (!isNativeAndroid()) return null;
  const photo = await Camera.getPhoto({
    quality: 90,
    allowEditing: false,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Camera,
    correctOrientation: true,
  });
  return photo.dataUrl || null;
}

export async function pickNativeGalleryPhoto(): Promise<string | null> {
  if (!isNativeAndroid()) return null;
  const photo = await Camera.getPhoto({
    quality: 90,
    allowEditing: false,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Photos,
    correctOrientation: true,
  });
  return photo.dataUrl || null;
}
