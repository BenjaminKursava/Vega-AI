import type { Attachment } from '../types';

// Images are downscaled before storing/sending: conversations persist to
// localStorage (~5 MB quota), and vision models don't need more pixels.
const MAX_IMAGE_DIMENSION = 1024;
const JPEG_QUALITY = 0.85;
const MAX_TEXT_FILE_BYTES = 200 * 1024;
export const MAX_ATTACHMENTS = 6;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'log',
  'ini', 'toml', 'conf', 'env', 'js', 'jsx', 'ts', 'tsx', 'py', 'php', 'html',
  'css', 'scss', 'sql', 'sh', 'bat', 'ps1', 'rs', 'go', 'java', 'c', 'cpp', 'h',
]);

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function isTextLike(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/x-yaml'].includes(file.type)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(file.name));
}

async function imageToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

function attachmentId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface ProcessFilesResult {
  attachments: Attachment[];
  /** Human-readable reasons for files that could not be attached. */
  rejected: string[];
}

export async function filesToAttachments(
  files: Iterable<File>,
  existingCount: number,
): Promise<ProcessFilesResult> {
  const attachments: Attachment[] = [];
  const rejected: string[] = [];
  let count = existingCount;

  for (const file of files) {
    if (count >= MAX_ATTACHMENTS) {
      rejected.push(`${file.name}: limit of ${MAX_ATTACHMENTS} attachments`);
      continue;
    }
    if (file.type.startsWith('image/')) {
      try {
        const dataUrl = await imageToDataUrl(file);
        attachments.push({
          id: attachmentId(),
          kind: 'image',
          name: file.name || 'image',
          mime: 'image/jpeg',
          size: file.size,
          dataUrl,
        });
        count++;
      } catch {
        rejected.push(`${file.name}: could not read image`);
      }
    } else if (isTextLike(file)) {
      if (file.size > MAX_TEXT_FILE_BYTES) {
        rejected.push(`${file.name}: text files up to ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB`);
        continue;
      }
      try {
        const text = await file.text();
        attachments.push({
          id: attachmentId(),
          kind: 'text',
          name: file.name,
          mime: file.type || 'text/plain',
          size: file.size,
          text,
        });
        count++;
      } catch {
        rejected.push(`${file.name}: could not read file`);
      }
    } else {
      rejected.push(`${file.name}: only images and text files are supported`);
    }
  }

  return { attachments, rejected };
}

export function dataUrlToBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/** Inline a text attachment into the prompt sent to the model. The stored
 *  message keeps only the chip; the model sees the full file content. */
export function attachmentPromptBlock(a: Attachment): string {
  return `\n\n[Attached file: ${a.name}]\n\`\`\`\n${a.text ?? ''}\n\`\`\``;
}
