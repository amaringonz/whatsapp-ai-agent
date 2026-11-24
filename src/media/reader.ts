import type { CustomerBlock, DocumentBlock, ImageMediaType, TextBlock } from '../agent/types.js';
import type { QueuedMessage } from '../store/types.js';
import { MediaTooLargeError, type MediaDownloader } from '../whatsapp/client.js';
import type { MediaRef } from '../whatsapp/webhook.js';
import type { Transcriber } from './transcriber.js';

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const AUDIO_MAX_BYTES = 16 * 1024 * 1024;
export const TEXT_MAX_CHARS = 60_000;

const IMAGE_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set<string>(['text/plain', 'text/csv', 'text/markdown', 'application/json']);

const text = (value: string): TextBlock => ({ type: 'text', text: value });
const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
const quoted = (value?: string) => (value ? `: "${value}"` : '');
const mime = (value?: string) => value?.split(';')[0]?.trim().toLowerCase();

function adNote(value: string): string {
  return value.match(/\n\[Came from an ad[^\n]*\]$/)?.[0] ?? '';
}

export function compact(blocks: CustomerBlock[]): string | CustomerBlock[] {
  const merged: CustomerBlock[] = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (block.type === 'text' && last?.type === 'text') {
      last.text = `${last.text}\n${block.text}`;
    } else {
      merged.push(block.type === 'text' ? { ...block } : block);
    }
  }
  if (merged.every((block) => block.type === 'text')) {
    return merged.map((block) => (block as TextBlock).text).join('\n');
  }
  return merged;
}

export class MediaReader {
  constructor(
    private readonly options: {
      downloader?: MediaDownloader;
      transcriber?: Transcriber;
      language?: string;
    } = {},
  ) {}

  async read(items: QueuedMessage[]): Promise<string | CustomerBlock[]> {
    const blocks: CustomerBlock[] = [];
    for (const item of items) blocks.push(...(await this.readOne(item)));
    return compact(blocks);
  }

  private async readOne(item: QueuedMessage): Promise<CustomerBlock[]> {
    const { media } = item;
    if (!media || !this.options.downloader) return [text(item.text)];
    try {
      const blocks = await this.readMedia(media);
      if (!blocks) return [text(item.text)];
      const note = adNote(item.text);
      return note ? [...blocks, text(note.trim())] : blocks;
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        return [
          text(`[The customer sent a ${media.type} that is too large to open. Ask them for a smaller one or to tell you what it shows.]`),
        ];
      }
      console.warn(`Could not read ${media.type} ${media.id}`, error);
      return [text(item.text)];
    }
  }

  private async readMedia(media: MediaRef): Promise<CustomerBlock[] | undefined> {
    switch (media.type) {
      case 'image':
        return this.image(media);
      case 'document':
        return this.document(media);
      case 'audio':
        return this.audio(media);
      default:
        return undefined;
    }
  }

  private async image(media: MediaRef): Promise<CustomerBlock[] | undefined> {
    if (media.mimeType && !IMAGE_TYPES.has(mime(media.mimeType)!)) return undefined;
    const file = await this.options.downloader!.downloadMedia(media.id, IMAGE_MAX_BYTES);
    const type = mime(file.mimeType) ?? '';
    if (!IMAGE_TYPES.has(type)) return undefined;
    return [
      { type: 'image', source: { type: 'base64', media_type: type as ImageMediaType, data: base64(file.data) } },
      text(`[Photo from the customer${quoted(media.caption)}]`),
    ];
  }

  private async document(media: MediaRef): Promise<CustomerBlock[] | undefined> {
    const declared = mime(media.mimeType);
    if (declared && declared !== 'application/pdf' && !TEXT_TYPES.has(declared)) return undefined;
    const file = await this.options.downloader!.downloadMedia(media.id, DOCUMENT_MAX_BYTES);
    const type = mime(file.mimeType) ?? declared ?? '';
    const title = media.filename;
    const label = text(`[Document from the customer${title ? ` "${title}"` : ''}${media.caption ? ` with the note "${media.caption}"` : ''}]`);

    let document: DocumentBlock | undefined;
    if (type === 'application/pdf') {
      document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64(file.data) } };
    } else if (TEXT_TYPES.has(type)) {
      const content = new TextDecoder().decode(file.data).slice(0, TEXT_MAX_CHARS);
      document = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: content } };
    }
    if (!document) return undefined;
    if (title) document.title = title;
    return [document, label];
  }

  private async audio(media: MediaRef): Promise<CustomerBlock[] | undefined> {
    if (!this.options.transcriber) return undefined;
    const file = await this.options.downloader!.downloadMedia(media.id, AUDIO_MAX_BYTES);
    const transcript = await this.options.transcriber.transcribe(file.data, file.mimeType, this.options.language);
    if (!transcript) return [text('[The customer sent a voice note with no words you could make out. Ask them kindly to write it.]')];
    return [text(`[Voice note, transcribed] ${transcript}`)];
  }
}

export function stripAttachments<T extends { role: string; content: unknown }>(history: T[]): T[] {
  return history.map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const blocks = message.content as { type: string }[];
    if (!blocks.some((block) => block.type === 'image' || block.type === 'document')) return message;
    const replaced: CustomerBlock[] = blocks.map((block) => {
      if (block.type === 'image') return text('[The photo is no longer attached]');
      if (block.type === 'document') {
        const title = (block as DocumentBlock).title;
        return text(`[The document${title ? ` "${title}"` : ''} is no longer attached]`);
      }
      return block as CustomerBlock;
    });
    return { ...message, content: compact(replaced) };
  });
}
