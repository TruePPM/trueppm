/**
 * Cloud-file preview-type presentation (issue 571, ADR-0163).
 *
 * Mirrors the server's `PREVIEW_TYPE_VALUES` (registry.py). The server classifies
 * an unfurled file URL onto one of these; the web layer maps each onto a house
 * file-type icon (#1739 — replaced the earlier Unicode glyphs, which rendered
 * inconsistently across platforms) and a human label for the type chip. The map
 * MUST stay exhaustive — an unknown key falls back to the generic file icon so a
 * new server value never renders blank.
 */

import type { ComponentType } from 'react';
import {
  FileIcon,
  FileImageIcon,
  FilePdfIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  PresentationIcon,
  type IconProps,
} from '@/components/Icons';

export type PreviewType =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'pdf'
  | 'folder'
  | 'file';

const PREVIEW_TYPE_ICON: Record<PreviewType, ComponentType<IconProps>> = {
  document: FileTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  presentation: PresentationIcon,
  image: FileImageIcon,
  pdf: FilePdfIcon,
  folder: FolderIcon,
  file: FileIcon,
};

const PREVIEW_TYPE_LABEL: Record<PreviewType, string> = {
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  image: 'Image',
  pdf: 'PDF',
  folder: 'Folder',
  file: 'File',
};

/** House icon for a preview type; falls back to the generic file icon for any
 *  unknown key (keeps the placeholder/chip exhaustive against future values). */
export function previewTypeIcon(type: string): ComponentType<IconProps> {
  return PREVIEW_TYPE_ICON[type as PreviewType] ?? PREVIEW_TYPE_ICON.file;
}

/** Human label for the type chip; falls back to the generic 'File'. */
export function previewTypeLabel(type: string): string {
  return PREVIEW_TYPE_LABEL[type as PreviewType] ?? PREVIEW_TYPE_LABEL.file;
}
