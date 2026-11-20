import { z } from 'zod';

export const syncWebhookSchema = z
  .object({
    discord_user_id: z.string().regex(/^\d{17,20}$/),
    sync_id: z.string().uuid(),
  })
  .strict();

export type SyncWebhook = z.infer<typeof syncWebhookSchema>;
