/**
 * Typed domain model for the post-capture editor (Phase 5).
 *
 * Annotations are stored in canvas pixel coordinates — the coordinate space
 * after the crop + scale transform is applied. Snapshots drive undo/redo.
 */

export type EditorTool =
  'select' | 'crop' | 'rect' | 'arrow' | 'pen' | 'text' | 'highlight' | 'blur';

export interface Point {
  x: number;
  y: number;
}

export interface RectAnnotation {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
}

export interface ArrowAnnotation {
  kind: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
}

export interface PenAnnotation {
  kind: 'pen';
  points: Point[];
  color: string;
  strokeWidth: number;
}

export interface TextAnnotation {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
}

export interface HighlightAnnotation {
  kind: 'highlight';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface BlurAnnotation {
  kind: 'blur';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export type Annotation =
  | RectAnnotation
  | ArrowAnnotation
  | PenAnnotation
  | TextAnnotation
  | HighlightAnnotation
  | BlurAnnotation;

/** A rectangle in source-image coordinates (the region currently shown). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Immutable snapshot of the editor document, used by undo/redo. */
export interface EditorSnapshot {
  crop: CropRect;
  /** Canvas width in device pixels (after crop + resize). */
  width: number;
  /** Canvas height in device pixels (after crop + resize). */
  height: number;
  annotations: Annotation[];
}

/**
 * Payload handed from the popup to the editor. IndexedDB is used instead of
 * chrome.storage.session because large full-page PNGs exceed the 10MB session
 * quota.
 */
export interface PendingEditPayload {
  id: string;
  dataUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
  timestamp: number;
}
