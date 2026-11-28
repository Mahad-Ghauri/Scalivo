import type { GrowChannel } from '@scalivo/shared';
import { SITE_URL } from './site';

/** The owner-facing names. What they did, not what the code calls it. */
export const CHANNEL_LABEL: Record<GrowChannel, string> = {
  qr: 'QR poster',
  instagram: 'Instagram',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp chats & status',
  link: 'Shared link',
  marketplace: 'Scalivo search',
  direct: 'Direct or unknown',
};

/**
 * The public profile, tagged with where it is being shared. Each place the
 * owner posts gets its own `?ref=`, which is the only way the funnel can say
 * which of them actually brought customers.
 */
export function profileLink(slug: string, channel: GrowChannel): string {
  return `${SITE_URL}/${slug}?ref=${channel}`;
}

/** '923001234567' → '+92 300 1234567'. Anything else is shown as given. */
export function formatPhone(e164: string): string {
  const pk = /^92(\d{3})(\d{7})$/.exec(e164);
  return pk ? `+92 ${pk[1]} ${pk[2]}` : `+${e164}`;
}

export interface ShareTarget {
  channel: Extract<GrowChannel, 'instagram' | 'facebook' | 'whatsapp' | 'link'>;
  title: string;
  hint: string;
  caption: string;
  link: string;
  /** Opens the platform's own share screen, where one exists. Instagram has none on the web. */
  intent: string | null;
}

/**
 * Pre-written, so an owner with no marketing experience posts something that
 * works: what they do, that booking takes a minute, and the link. Short enough
 * for a story, plain enough to read aloud.
 */
export function shareTargets(business: { name: string; slug: string; tagline: string }): ShareTarget[] {
  const instagram = profileLink(business.slug, 'instagram');
  const facebook = profileLink(business.slug, 'facebook');
  const whatsapp = profileLink(business.slug, 'whatsapp');
  const tagline = business.tagline.trim();

  const whatsappText = `Book with ${business.name} online: pick a time and get confirmed on WhatsApp. ${whatsapp}`;

  return [
    {
      channel: 'instagram',
      title: 'Instagram',
      hint: 'Put the link in your bio, or add it to a story with the link sticker.',
      caption: `${tagline ? `${tagline}\n\n` : ''}Book online in under a minute. No calls, no waiting for a reply. Link in bio.`,
      link: instagram,
      intent: null,
    },
    {
      channel: 'facebook',
      title: 'Facebook',
      hint: 'Post it on your page, and pin it to the top.',
      caption: `We now take bookings online! See our prices, pick a time that suits you, and get your confirmation on WhatsApp.\n\n${facebook}`,
      link: facebook,
      intent: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(facebook)}`,
    },
    {
      channel: 'whatsapp',
      title: 'WhatsApp status',
      hint: 'Post it as your status, or send it to regular customers.',
      caption: whatsappText,
      link: whatsapp,
      intent: `https://wa.me/?text=${encodeURIComponent(whatsappText)}`,
    },
    {
      channel: 'link',
      title: 'Anywhere else',
      hint: 'Google Business profile, email signature, a flyer, anywhere a link goes.',
      caption: profileLink(business.slug, 'link'),
      link: profileLink(business.slug, 'link'),
      intent: null,
    },
  ];
}
