import { CoordinateMapping } from './types.js';

/**
 * Maps a pointer coordinate (clientX, clientY) on an HTMLCanvasElement
 * to the native device screen coordinates (x, y) taking into account
 * aspect ratio and bounding client rectangle.
 */
export function mapCanvasCoordinates(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  videoWidth: number,
  videoHeight: number
): CoordinateMapping {
  if (videoWidth <= 0 || videoHeight <= 0) {
    return { x: 0, y: 0 };
  }

  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }

  const offsetX = clientX - rect.left;
  const offsetY = clientY - rect.top;

  // Normalized relative coords (0..1)
  const normX = Math.max(0, Math.min(1, offsetX / rect.width));
  const normY = Math.max(0, Math.min(1, offsetY / rect.height));

  const x = Math.round(normX * videoWidth);
  const y = Math.round(normY * videoHeight);

  return {
    x: Math.max(0, Math.min(videoWidth, x)),
    y: Math.max(0, Math.min(videoHeight, y)),
  };
}
