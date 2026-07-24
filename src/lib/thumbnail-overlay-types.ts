/**
 * Overlay shapes shared by the renderer and the UI.
 *
 * Split out of `thumbnail-overlay.ts` because that module is
 * `server-only` (it loads a native canvas binding), while the Thumbnails
 * tab needs the zone list and the spec type to render its controls.
 */

import { DEFAULT_ASPECT, type AspectChoice } from "./image-provider-types";

export type TextZone =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "left"
  | "right";

export const TEXT_ZONES: TextZone[] = [
  "top-left",
  "top-center",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];

export type OverlaySpec = {
  text: string;
  zone: TextZone;
  /**
   * Frame shape this overlay was drawn for. Stored with the spec rather
   * than looked up from the run, so a re-render years later still lands
   * on the same canvas as the background it is drawn onto.
   */
  aspect: AspectChoice;
  /** Fill colour. Defaults to white, which survives most backgrounds. */
  color: string;
  /** Outline colour; ignored when `stroke` is false. */
  strokeColor: string;
  stroke: boolean;
  shadow: boolean;
  uppercase: boolean;
  /** Fraction of the frame height the text block may occupy, 0.1–0.6. */
  maxHeightRatio: number;
};

export const DEFAULT_OVERLAY: Omit<OverlaySpec, "text"> = {
  zone: "bottom-left",
  aspect: DEFAULT_ASPECT,
  color: "#FFFFFF",
  strokeColor: "#000000",
  stroke: true,
  shadow: true,
  uppercase: true,
  maxHeightRatio: 0.34,
};

/** Normalises whatever the model proposed into a valid zone. */
export function coerceZone(v: unknown): TextZone {
  return TEXT_ZONES.includes(v as TextZone) ? (v as TextZone) : "bottom-left";
}
