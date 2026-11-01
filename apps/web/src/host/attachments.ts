/** Shared chat attachment reader and KB ingestion (Phase 23.4). */
import { apiFetch } from './api';

export type AttachmentKind = 'pdf' | 'image' | 'document';

export interface ChatAttachment {
  name: string;
  text: string;
  base64: string;
  mediaType: string;
  kind: AttachmentKind;
  kbSaved?: boolean;
}

export const MAX_ATTACHMENT_BYTES = 200_000;
export const MAX_ATTACHMENTS = 5;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export async function readChatFiles(files: FileList | null): Promise<{
  accepted: ChatAttachment[];
  rejected: string[];
}> {
  const accepted: ChatAttachment[] = [];
  const rejected: string[] = [];
  if (!files) return { accepted, rejected };
  for (const file of Array.from(files).slice(0, MAX_ATTACHMENTS)) {
    const isVideo =
      file.type.startsWith('video/') ||
      /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv|mpeg|mpg)$/i.test(file.name);
    if (isVideo) {
      rejected.push(`${file.name} is a video and cannot be uploaded`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(`${file.name} is larger than 200 KB`);
      continue;
    }
    try {
      const buffer =
        typeof file.arrayBuffer === 'function'
          ? await file.arrayBuffer()
          : await new Promise<ArrayBuffer>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as ArrayBuffer);
              reader.onerror = () => reject(reader.error);
              reader.readAsArrayBuffer(file);
            });
      const bytes = new Uint8Array(buffer);
      const text = /^text\/|json|xml|csv|markdown/.test(file.type)
        ? new TextDecoder().decode(bytes)
        : '';
      const kind: AttachmentKind = file.type.startsWith('image/')
        ? 'image'
        : file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
          ? 'pdf'
          : 'document';
      accepted.push({
        name: file.name,
        text,
        base64: bytesToBase64(bytes),
        mediaType: file.type || 'application/octet-stream',
        kind,
      });
    } catch {
      rejected.push(`${file.name} could not be read`);
    }
  }
  return { accepted, rejected };
}

/**
 * Upload attachments as KB sources (default On). Best-effort: a disabled or
 * unavailable KB must never block the chat message.
 */
export async function saveAttachmentsToKb(attachments: ChatAttachment[]): Promise<void> {
  for (const file of attachments) {
    if (file.kbSaved) continue;
    const result = await apiFetch('/api/v1/kb/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'file',
        title: file.name,
        label: 'Chat upload',
        mediaType: file.mediaType,
        contentBase64: file.base64,
      }),
    }).catch(() => null);
    if (result?.ok) file.kbSaved = true;
  }
}
