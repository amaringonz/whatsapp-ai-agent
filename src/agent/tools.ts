import type { BusinessConfig } from '../config/business.js';
import type { BookingOrigin, BookingProvider } from '../booking/types.js';
import type { HandoffReason } from '../notify/types.js';
import type { ToolSpec } from './types.js';

export interface HandoffRequest {
  reason: HandoffReason;
  summary: string;
  lead: Record<string, string>;
}

export interface ToolContext {
  contact: string;
  config: BusinessConfig;
  booking?: BookingProvider;
  onHandoff(request: HandoffRequest): Promise<void>;
  onLead(lead: Record<string, string>): void;
  origin?: BookingOrigin;
  canBook?(): Promise<boolean>;
  onBooked?(): Promise<void>;
}

const reasons: HandoffReason[] = ['completed', 'urgent', 'requested_human', 'out_of_scope'];

function bookingFieldsSchema(config: BusinessConfig) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of config.booking?.fields ?? []) {
    properties[field.name] = field.options
      ? {
          type: 'string',
          enum: field.options.map((item) => item.value),
          description: `${field.description} Options: ${field.options.map((item) => `${item.value} = ${item.label}`).join('; ')}`,
        }
      : { type: 'string', description: field.description };
    if (field.required) required.push(field.name);
  }
  return { properties, required };
}

export function toolSpecs(config: BusinessConfig, bookingAvailable: boolean): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: 'hand_off',
      description:
        'Pass the conversation to the business owner and stop answering in this chat. Use it when the goal is completed, when something is urgent, when the customer asks for a person or when you do not have the answer.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', enum: reasons },
          summary: { type: 'string', description: 'Two to four sentences for the owner.' },
          lead: {
            type: 'object',
            description: 'What you learned about the customer, such as name, business, need or budget.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['reason', 'summary'],
        additionalProperties: false,
      },
    },
  ];

  if (config.booking?.enabled && bookingAvailable) {
    const fields = bookingFieldsSchema(config);
    tools.push(
      {
        name: 'get_availability',
        description: 'List the days and times that are free to book right now.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'book_appointment',
        description: 'Book an appointment once the customer confirmed the day, the time and their details.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Customer full name.' },
            date: { type: 'string', description: 'Day as returned by get_availability (YYYY-MM-DD).' },
            time: { type: 'string', description: 'Time as returned by get_availability (HH:MM).' },
            ...fields.properties,
          },
          required: ['name', 'date', 'time', ...fields.required],
          additionalProperties: false,
        },
      },
    );
  }
  return tools;
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => typeof item === 'string' && item.trim())
      .map(([key, item]) => [key, String(item).trim().slice(0, 500)]),
  );
}

export async function runTool(name: string, input: unknown, context: ToolContext): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>;

  if (name === 'hand_off') {
    const reason = reasons.includes(args.reason as HandoffReason) ? (args.reason as HandoffReason) : 'out_of_scope';
    const lead = asRecord(args.lead);
    context.onLead(lead);
    await context.onHandoff({ reason, summary: String(args.summary ?? '').slice(0, 2000), lead });
    return 'The owner was notified and will continue this chat. Send one short closing message and stop.';
  }

  if (!context.booking) return 'Booking is not available. Hand off the conversation instead.';

  if (name === 'get_availability') {
    const days = await context.booking.availability();
    const free = days.filter((day) => day.slots.length);
    if (!free.length) return 'There are no free times right now. Offer to hand off the conversation.';
    return free
      .map((day) => `${day.label} (${day.date}): ${day.slots.map((slot) => `${slot.label} [${slot.time}]`).join(', ')}`)
      .join('\n');
  }

  if (name === 'book_appointment') {
    if (context.canBook && !(await context.canBook())) {
      return 'This customer already booked the maximum number of appointments for this week. Do not book again; offer to hand off the conversation.';
    }
    const { name: customer, date, time, ...rest } = args;
    const fields = asRecord(rest);
    context.onLead({ name: String(customer ?? ''), ...fields });
    const result = await context.booking.book({
      name: String(customer ?? ''),
      phone: context.contact,
      date: String(date ?? ''),
      time: String(time ?? ''),
      fields,
      source: 'whatsapp',
      ...(context.origin ? { origin: context.origin } : {}),
    });
    if (result.ok) {
      await context.onBooked?.();
      return `Booked. Reference ${result.id}. ${result.summary}`.trim();
    }
    if (result.reason === 'slot_taken') return `That time was just taken. ${result.message} Call get_availability again.`;
    return `Could not book: ${result.message}`;
  }

  return `Unknown tool ${name}.`;
}
