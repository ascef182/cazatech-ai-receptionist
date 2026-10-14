import { z } from 'zod';

// Estrutura conforme a referência oficial do webhook "messages" da WhatsApp Business Platform.
// Campos desconhecidos são preservados (looseObject) para não quebrar quando a Meta adicionar campos.

const TextSchema = z.looseObject({ body: z.string().max(65_536) });

const AudioSchema = z.looseObject({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  voice: z.boolean().optional(),
  url: z.string().optional(), // em rollout gradual pela Meta; não dependemos dele
});

export const InboundMessageSchema = z.looseObject({
  from: z.string().min(3).max(32),
  id: z.string().min(1).max(256),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: TextSchema.optional(),
  audio: AudioSchema.optional(),
});

export const StatusSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().regex(/^\d+$/).optional(),
  recipient_id: z.string().optional(),
  errors: z.array(z.looseObject({ code: z.number().optional(), title: z.string().optional() })).optional(),
});

export const ChangeValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp'),
  metadata: z.looseObject({
    display_phone_number: z.string().optional(),
    phone_number_id: z.string().min(1),
  }),
  contacts: z
    .array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string().optional() }).optional() }))
    .optional(),
  messages: z.array(InboundMessageSchema).optional(),
  statuses: z.array(StatusSchema).optional(),
});

export const WebhookPayloadSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.looseObject({
        id: z.string(),
        changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })),
      }),
    )
    .max(1000),
});

export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export type StatusUpdate = z.infer<typeof StatusSchema>;
export type ChangeValue = z.infer<typeof ChangeValueSchema>;
