/**
 * Screenshot sizing and the mapping from image pixels to screen points.
 *
 * The model clicks in the pixel space of the last screenshot it saw. That
 * image is the display scaled down to fit the vision budget, so every
 * coordinate is scaled back up here, and nowhere else.
 */

import type { Display, Rect } from "./native.ts";

/**
 * Largest image worth sending. Past about 1.2 megapixels, or 1568 pixels on
 * the long edge, the API scales the image down again anyway, and the model's
 * coordinates would then be in a space nobody here knows about.
 */
const MAX_PIXELS = 1_200_000;
const MAX_EDGE = 1568;

export function fitImage(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    Math.sqrt(MAX_PIXELS / (width * height)),
    MAX_EDGE / Math.max(width, height),
  );
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

/** A full-display screenshot the model has seen: the frame its coordinates are in. */
export type Frame = { display: Display; width: number; height: number };

/** The frame for a display, sized to the vision budget. */
export function frameFor(display: Display): Frame {
  return { display, ...fitImage(display.width, display.height) };
}

/** Image pixels in `frame` to global screen points. */
export function toScreen(frame: Frame, x: number, y: number): { x: number; y: number } {
  const { display } = frame;
  return {
    x: display.x + (x * display.width) / frame.width,
    y: display.y + (y * display.height) / frame.height,
  };
}

/** Global screen points to image pixels in `frame`, rounded. */
export function toImage(frame: Frame, x: number, y: number): { x: number; y: number } {
  const { display } = frame;
  return {
    x: Math.round(((x - display.x) * frame.width) / display.width),
    y: Math.round(((y - display.y) * frame.height) / display.height),
  };
}

/** Whether an image coordinate lies on the frame. */
export function inFrame(frame: Frame, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= frame.width && y <= frame.height;
}

/**
 * A zoom region from `frame` pixels to display-local points, plus the size to
 * capture it at: the display's native pixels, within the vision budget.
 */
export function zoomRegion(
  frame: Frame,
  region: [number, number, number, number],
): { rect: Rect; width: number; height: number } {
  const [x0, y0, x1, y1] = region;
  if (x1 <= x0 || y1 <= y0) throw new Error("zoom region must have x1 > x0 and y1 > y0");
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  const sx = frame.display.width / frame.width;
  const sy = frame.display.height / frame.height;
  const rect = {
    x: clamp(x0, frame.width) * sx,
    y: clamp(y0, frame.height) * sy,
    width: (clamp(x1, frame.width) - clamp(x0, frame.width)) * sx,
    height: (clamp(y1, frame.height) - clamp(y0, frame.height)) * sy,
  };
  if (rect.width < 1 || rect.height < 1) throw new Error("zoom region is outside the screenshot");
  const native = fitImage(rect.width * frame.display.scale, rect.height * frame.display.scale);
  return { rect, width: Math.max(1, native.width), height: Math.max(1, native.height) };
}
