export interface Slot {
  time: string;
  label: string;
}

export interface Day {
  date: string;
  label: string;
  slots: Slot[];
}

export interface BookingRequest {
  name: string;
  phone: string;
  date: string;
  time: string;
  fields: Record<string, string>;
  source: 'whatsapp';
  origin?: BookingOrigin;
}

export interface BookingOrigin {
  source: string;
  medium: string;
  campaign?: string;
  content?: string;
  clickId?: string;
}

export type BookingResult =
  | { ok: true; id: string; summary: string }
  | { ok: false; reason: 'slot_taken' | 'invalid' | 'unavailable'; message: string };

export interface BookingProvider {
  availability(): Promise<Day[]>;
  book(request: BookingRequest): Promise<BookingResult>;
}
