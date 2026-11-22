/** Sign-in emails, from the same templates Supabase used. */
import { CONFIRMATION, MAGIC_LINK, RECOVERY } from './templates';

export type CodePurpose = 'signup' | 'signin' | 'recovery';

const TEMPLATES: Record<CodePurpose, { subject: string; html: string }> = {
  signup: { subject: 'Confirm your SpazaStock account', html: CONFIRMATION },
  signin: { subject: 'Your SpazaStock sign-in code', html: MAGIC_LINK },
  recovery: { subject: 'Reset your SpazaStock password', html: RECOVERY },
};

export interface Mailer {
  send(message: { to: string; subject: string; html: string; text: string }): Promise<void>;
}

export function codeEmail(purpose: CodePurpose, code: string): { subject: string; html: string; text: string } {
  const t = TEMPLATES[purpose];
  const html = t.html.replace(/\{\{\s*\.Token\s*\}\}/g, code);
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { subject: t.subject, html, text };
}

interface SendEmailBinding {
  send(message: {
    to: string;
    from: string | { email: string; name: string };
    subject: string;
    html: string;
    text: string;
  }): Promise<unknown>;
}

/**
 * Cloudflare Email Sending through the EMAIL binding. Without a binding or sender (local
 * development), the message is logged instead, code included, so sign-in can be tested.
 */
export function cloudflareMailer(binding: SendEmailBinding | undefined, from: string | undefined): Mailer {
  return {
    async send(message) {
      if (!binding || !from) {
        console.log(`[email not configured] to=${message.to} subject=${message.subject} text=${message.text}`);
        return;
      }
      await binding.send({ ...message, from: { email: from, name: 'SpazaStock' } });
    },
  };
}
