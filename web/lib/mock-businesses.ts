/**
 * Marketplace fixtures.
 *
 * **Temporary.** This file is deleted the day `SOURCE` in marketplace.ts flips
 * to 'http'. Nothing outside marketplace.ts may import it — the point of the
 * data layer is that no page knows this file exists.
 *
 * The content is modelled on the real tenants rather than invented from
 * nothing. `skinare` mirrors backend/src/scripts/seed.ts field for field —
 * same slug, same four services at the same prices, the same two clinicians,
 * the same Mon–Sat 09:00–18:00 with a 13:00–14:00 break. If the seed and this
 * disagree, the seed is right. `uxelerate` is the internal tenant Phase 1.9
 * puts on the system and Phase 2 is accepted against. `iron-oasis` stands in
 * for the CrossFit pilot that Phase 5.2 onboards.
 *
 * Prices are paisa. 800_000 is PKR 8,000.
 */

import type { MarketplaceBusiness } from './marketplace';

const KARACHI = 'Asia/Karachi';

/**
 * Photos are from Unsplash, whose licence allows free commercial use without
 * attribution. Served straight from their CDN with a crop and width baked into
 * the URL, so a phone on mobile data is never sent a 5,000px original.
 *
 * Uxelerate's staff have no photo on purpose: they are real people, and a stock
 * stranger's face under a real name is a misrepresentation, not a placeholder.
 */
const SIZES = { cover: 'w=1200&h=800', photo: 'w=900&h=700', portrait: 'w=240&h=240' } as const;
const unsplash = (id: string, kind: keyof typeof SIZES) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&q=70&${SIZES[kind]}`;

/** Mon–Sat, one pattern, with an optional midday break. */
const weekdayHours = (opensAt: string, closesAt: string, breaks: { startsAt: string; endsAt: string }[] = []) =>
  [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt, breaks }));

/** Defaults every business shares, so each entry below shows only what differs. */
const base = {
  timezone: KARACHI,
  slotIncrementMinutes: 15,
  minNoticeMinutes: 60,
  bookingHorizonDays: 30,
  published: true,
} as const;

export const MOCK_BUSINESSES: MarketplaceBusiness[] = [
  {
    ...base,
    id: 'biz_skinare',
    slug: 'skinare',
    name: 'Skinare Aesthetics',
    category: 'clinic',
    city: 'Multan',
    neighbourhood: 'Gulgasht Colony',
    tagline: 'Medical-grade skin, without the hard sell.',
    about:
      'A two-clinician aesthetic practice on Gulgasht Colony, running since 2019. Every appointment opens with a skin read and an honest answer about what will and will not work, several of which are "nothing, wait six weeks". Hydrafacials, laser and peels are performed by the physician who consulted you, never handed down.',
    addressLine: '14-B Gulgasht Colony, Multan',
    logoUrl: null,
    coverUrl: unsplash('1552693673-1bf958298935', 'cover'),
    themeColor: '#0F766E',
    rating: 4.8,
    reviewCount: 126,
    hours: weekdayHours('09:00', '18:00', [{ startsAt: '13:00', endsAt: '14:00' }]),
    gallery: [
      { url: unsplash('1570172619644-dfd03ed5d881', 'photo'), alt: 'A client lying back with a facial mask being applied' },
      { url: unsplash('1616394584738-fc6e612e71b9', 'photo'), alt: 'A client on a treatment bed with cream applied to her face' },
      { url: unsplash('1633681926019-03bd9325ec20', 'photo'), alt: 'A calm waiting area with a sofa and a vase of flowers' },
    ],
    services: [
      {
        id: 'svc_skinare_consult',
        name: 'Consultation',
        durationMinutes: 30,
        priceMinor: 200_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 1,
        description: 'A skin read, a plan, and a straight answer on what it will cost.',
        imageUrl: null,
      },
      {
        id: 'svc_skinare_hydra',
        name: 'Hydrafacial',
        durationMinutes: 45,
        priceMinor: 800_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 2,
        description: 'Cleanse, extract and hydrate in one pass. No downtime.',
        imageUrl: null,
      },
      {
        id: 'svc_skinare_laser',
        name: 'Laser session',
        durationMinutes: 20,
        priceMinor: 500_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 3,
        description: 'Single-area diode session. Course of six recommended.',
        imageUrl: null,
      },
      {
        id: 'svc_skinare_peel',
        name: 'Chemical peel',
        durationMinutes: 40,
        priceMinor: 650_000,
        depositRequired: true,
        depositAmountMinor: 200_000,
        displayOrder: 4,
        description: 'Medium-depth peel with a patch test the week before.',
        imageUrl: null,
      },
    ],
    staff: [
      {
        id: 'stf_skinare_ayesha',
        name: 'Dr. Ayesha',
        role: 'Aesthetic physician',
        serviceIds: ['svc_skinare_consult', 'svc_skinare_hydra', 'svc_skinare_laser', 'svc_skinare_peel'],
        avatarUrl: unsplash('1630939687530-241d630735df', 'portrait'),
      },
      {
        id: 'stf_skinare_sana',
        name: 'Dr. Sana',
        role: 'Aesthetic physician',
        serviceIds: ['svc_skinare_consult', 'svc_skinare_hydra', 'svc_skinare_laser', 'svc_skinare_peel'],
        avatarUrl: unsplash('1595085610896-fb31cfd5d4b7', 'portrait'),
      },
    ],
    reviews: [
      {
        id: 'rev_skinare_1',
        authorName: 'Hira A.',
        rating: 5,
        comment:
          'Booked on WhatsApp at eleven at night and had a slot confirmed before I put the phone down. Dr. Ayesha talked me out of the package I came in asking for and gave me three sessions instead. Skin is better and I spent less.',
        createdAt: '2026-08-29T13:20:00.000Z',
        serviceName: 'Hydrafacial',
      },
      {
        id: 'rev_skinare_2',
        authorName: 'Mahnoor S.',
        rating: 5,
        comment:
          'Six laser sessions, every one of them started within five minutes of the time on the message. That is unheard of here.',
        createdAt: '2026-08-11T08:05:00.000Z',
        serviceName: 'Laser session',
      },
      {
        id: 'rev_skinare_3',
        authorName: 'Rabia K.',
        rating: 4,
        comment:
          'The peel needed a patch test first, which meant two visits instead of one. Annoying, but they were right to insist.',
        createdAt: '2026-07-24T11:45:00.000Z',
        serviceName: 'Chemical peel',
      },
    ],
  },

  {
    ...base,
    id: 'biz_iron_oasis',
    slug: 'iron-oasis',
    name: 'Iron Oasis CrossFit',
    category: 'gym',
    city: 'Multan',
    neighbourhood: 'Cantt',
    tagline: 'Coached barbell work in a room that knows your name.',
    minNoticeMinutes: 120,
    about:
      'A 4,000 sq ft box off Abdali Road with three certified coaches and a hard cap of twelve people per class. Personal training and aerobics run alongside the class schedule. Beginners get their first four weeks on a separate ramp-up track rather than being dropped into a metcon.',
    addressLine: 'Off Abdali Road, Multan Cantt',
    logoUrl: null,
    coverUrl: unsplash('1671970922029-0430d2ae122c', 'cover'),
    themeColor: '#B45309',
    rating: 4.7,
    reviewCount: 89,
    hours: [
      ...[1, 2, 3, 4, 5].map((dayOfWeek) => ({
        dayOfWeek,
        opensAt: '06:00',
        closesAt: '22:00',
        breaks: [{ startsAt: '12:00', endsAt: '16:00' }],
      })),
      { dayOfWeek: 6, opensAt: '07:00', closesAt: '13:00', breaks: [] },
    ],
    gallery: [
      { url: unsplash('1741156229623-da94e6d7977d', 'photo'), alt: 'Weights and equipment laid out and ready for a class' },
      { url: unsplash('1775993167276-743bbcde77e1', 'photo'), alt: 'Rows of treadmills and machines on the training floor' },
      { url: unsplash('1597076537061-a6b58163aa45', 'photo'), alt: 'A line of kettlebells on the gym floor' },
    ],
    services: [
      {
        id: 'svc_iron_intro',
        name: 'Free intro session',
        durationMinutes: 45,
        priceMinor: 0,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 1,
        description: 'Movement screen and a scaled workout. No obligation, no sales pitch.',
        imageUrl: null,
      },
      {
        id: 'svc_iron_pt',
        name: 'Personal training',
        durationMinutes: 60,
        priceMinor: 350_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 2,
        description: 'One-to-one with a coach. Programming written between sessions.',
        imageUrl: null,
      },
      {
        id: 'svc_iron_aerobics',
        name: 'Aerobics class',
        durationMinutes: 45,
        priceMinor: 120_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 3,
        description: 'Low-impact conditioning, twelve people maximum.',
        imageUrl: null,
      },
      {
        id: 'svc_iron_ramp',
        name: 'Ramp-up course',
        durationMinutes: 60,
        priceMinor: 900_000,
        depositRequired: true,
        depositAmountMinor: 300_000,
        displayOrder: 4,
        description: 'Four weeks of fundamentals before you join the regular classes.',
        imageUrl: null,
      },
    ],
    staff: [
      {
        id: 'stf_iron_bilal',
        name: 'Bilal Tariq',
        role: 'Head coach',
        serviceIds: ['svc_iron_intro', 'svc_iron_pt', 'svc_iron_ramp'],
        avatarUrl: unsplash('1568602471122-7832951cc4c5', 'portrait'),
      },
      {
        id: 'stf_iron_zara',
        name: 'Zara Iqbal',
        role: 'Conditioning coach',
        serviceIds: ['svc_iron_intro', 'svc_iron_aerobics'],
        avatarUrl: unsplash('1543871595-e11129e271cc', 'portrait'),
      },
    ],
    reviews: [
      {
        id: 'rev_iron_1',
        authorName: 'Usman R.',
        rating: 5,
        comment:
          'Came in having never touched a barbell. Four weeks on the ramp-up track and I can now do the class without holding anyone up. Bilal watches every rep.',
        createdAt: '2026-09-02T05:30:00.000Z',
        serviceName: 'Ramp-up course',
      },
      {
        id: 'rev_iron_2',
        authorName: 'Fatima N.',
        rating: 5,
        comment: 'Twelve-person cap is the whole point. You get corrected, not ignored.',
        createdAt: '2026-08-18T14:10:00.000Z',
        serviceName: 'Aerobics class',
      },
      {
        id: 'rev_iron_3',
        authorName: 'Ahmed J.',
        rating: 4,
        comment: 'Great coaching. Parking at 6am is a fight, so come early.',
        createdAt: '2026-07-30T03:15:00.000Z',
        serviceName: 'Personal training',
      },
    ],
  },

  {
    ...base,
    id: 'biz_uxelerate',
    slug: 'uxelerate',
    name: 'Uxelerate',
    category: 'studio',
    city: 'Multan',
    neighbourhood: 'Bosan Road',
    tagline: 'Product design for people who already have users.',
    about:
      'A two-person product studio working with founders who have shipped something and now need it to hold up. Engagements start with a discovery call and end with something in production. We run our own bookings on Scalivo, which is either reassuring or alarming depending on your view of dogfooding.',
    addressLine: 'Bosan Road, Multan',
    logoUrl: null,
    coverUrl: unsplash('1542089363-bba089ffaa25', 'cover'),
    themeColor: '#4338CA',
    rating: 5,
    reviewCount: 11,
    hours: weekdayHours('10:00', '19:00', [{ startsAt: '13:30', endsAt: '14:30' }]),
    gallery: [
      { url: unsplash('1716703371653-ca74beaa7a4a', 'photo'), alt: 'People working at desks in the studio' },
      { url: unsplash('1715593949273-09009558300a', 'photo'), alt: 'A desk and chair by the window, mid-project' },
    ],
    services: [
      {
        id: 'svc_ux_discovery',
        name: 'Discovery call',
        durationMinutes: 30,
        priceMinor: 0,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 1,
        description: 'Thirty minutes on what you are building and whether we are useful to it.',
        imageUrl: null,
      },
      {
        id: 'svc_ux_consult',
        name: 'Project consultation',
        durationMinutes: 60,
        priceMinor: 1_500_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 2,
        description: 'A working hour on a specific problem, with written notes after.',
        imageUrl: null,
      },
      {
        id: 'svc_ux_audit',
        name: 'Interface audit',
        durationMinutes: 90,
        priceMinor: 2_500_000,
        depositRequired: true,
        depositAmountMinor: 500_000,
        displayOrder: 3,
        description: 'A walkthrough of your live product and a ranked list of what to fix.',
        imageUrl: null,
      },
    ],
    staff: [
      {
        id: 'stf_ux_mahad',
        name: 'Mahad Ghauri',
        role: 'Product design',
        serviceIds: ['svc_ux_discovery', 'svc_ux_consult', 'svc_ux_audit'],
        avatarUrl: null,
      },
      {
        id: 'stf_ux_mahateer',
        name: 'Mahateer Muhammad',
        role: 'Engineering',
        serviceIds: ['svc_ux_discovery', 'svc_ux_consult'],
        avatarUrl: null,
      },
    ],
    reviews: [
      {
        id: 'rev_ux_1',
        authorName: 'Danish M.',
        rating: 5,
        comment:
          'The audit was a ranked list of twelve things, not a redesign pitch. We shipped the top four in a fortnight and signups went up. Worth the hour on its own.',
        createdAt: '2026-08-21T09:00:00.000Z',
        serviceName: 'Interface audit',
      },
      {
        id: 'rev_ux_2',
        authorName: 'Sadia H.',
        rating: 5,
        comment: 'Told us honestly that we did not need them yet. Came back four months later.',
        createdAt: '2026-06-14T10:30:00.000Z',
        serviceName: 'Discovery call',
      },
    ],
  },

  {
    ...base,
    id: 'biz_noor_salon',
    slug: 'noor-salon',
    name: 'Noor Salon & Spa',
    category: 'salon',
    city: 'Multan',
    neighbourhood: 'Shah Rukn-e-Alam',
    tagline: 'Twenty-one years on the same corner.',
    about:
      'A family salon near Shah Rukn-e-Alam that has been cutting hair since 2005, now with six chairs and a two-room spa at the back. Bridal work books out months ahead; everything else usually has something the same week.',
    addressLine: 'Block C, Shah Rukn-e-Alam Colony, Multan',
    logoUrl: null,
    coverUrl: unsplash('1633681926022-84c23e8cb2d6', 'cover'),
    themeColor: '#9D174D',
    rating: 4.6,
    reviewCount: 204,
    hours: [
      ...[1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        dayOfWeek,
        opensAt: '10:00',
        closesAt: '20:00',
        breaks: [],
      })),
      { dayOfWeek: 0, opensAt: '12:00', closesAt: '18:00', breaks: [] },
    ],
    gallery: [
      { url: unsplash('1521590832167-7bcbfaa6381f', 'photo'), alt: 'Three salon chairs facing a long counter and mirror' },
      { url: unsplash('1675034743339-0b0747047727', 'photo'), alt: 'A stylist working on a client hair appointment' },
      { url: unsplash('1600334089648-b0d9d3028eb2', 'photo'), alt: 'A hot stone massage in the spa room' },
    ],
    services: [
      {
        id: 'svc_noor_cut',
        name: 'Cut & blow-dry',
        durationMinutes: 45,
        priceMinor: 250_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 1,
        description: 'Consultation, wash, cut and finish.',
        imageUrl: null,
      },
      {
        id: 'svc_noor_colour',
        name: 'Full colour',
        durationMinutes: 120,
        priceMinor: 900_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 2,
        description: 'Global colour with a strand test on the first visit.',
        imageUrl: null,
      },
      {
        id: 'svc_noor_facial',
        name: 'Signature facial',
        durationMinutes: 60,
        priceMinor: 450_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 3,
        description: 'Deep cleanse and massage in the back spa room.',
        imageUrl: null,
      },
      {
        id: 'svc_noor_bridal',
        name: 'Bridal package',
        durationMinutes: 240,
        priceMinor: 6_000_000,
        depositRequired: true,
        depositAmountMinor: 1_500_000,
        displayOrder: 4,
        description: 'Hair, makeup and draping, with a trial run included.',
        imageUrl: null,
      },
    ],
    staff: [
      {
        id: 'stf_noor_shazia',
        name: 'Shazia Bibi',
        role: 'Senior stylist',
        serviceIds: ['svc_noor_cut', 'svc_noor_colour', 'svc_noor_bridal'],
        avatarUrl: unsplash('1489278353717-f64c6ee8a4d2', 'portrait'),
      },
      {
        id: 'stf_noor_amna',
        name: 'Amna Yousaf',
        role: 'Colourist',
        serviceIds: ['svc_noor_cut', 'svc_noor_colour'],
        avatarUrl: unsplash('1534180477871-5d6cc81f3920', 'portrait'),
      },
      {
        id: 'stf_noor_rida',
        name: 'Rida Aslam',
        role: 'Aesthetician',
        serviceIds: ['svc_noor_facial'],
        avatarUrl: unsplash('1506863530036-1efeddceb993', 'portrait'),
      },
    ],
    reviews: [
      {
        id: 'rev_noor_1',
        authorName: 'Ayesha T.',
        rating: 5,
        comment:
          'Shazia has cut my hair for nine years. The only thing that changed is that I now book by messaging instead of calling four times.',
        createdAt: '2026-09-05T12:00:00.000Z',
        serviceName: 'Cut & blow-dry',
      },
      {
        id: 'rev_noor_2',
        authorName: 'Zainab F.',
        rating: 5,
        comment: 'Bridal trial was exactly what I asked for, and on the day nothing moved for eleven hours.',
        createdAt: '2026-08-02T16:40:00.000Z',
        serviceName: 'Bridal package',
      },
      {
        id: 'rev_noor_3',
        authorName: 'Maria S.',
        rating: 4,
        comment: 'Colour was perfect. Saturdays are packed, so book midweek if you can.',
        createdAt: '2026-07-19T13:25:00.000Z',
        serviceName: 'Full colour',
      },
    ],
  },

  {
    ...base,
    id: 'biz_cantt_dental',
    slug: 'cantt-dental',
    name: 'Cantt Dental Studio',
    category: 'clinic',
    city: 'Multan',
    neighbourhood: 'Cantt',
    tagline: 'Same-day emergency slots, held back on purpose.',
    about:
      'A single-surgery practice that keeps two slots free every afternoon for people in actual pain. Routine work books normally; if you message with a broken tooth you will usually be seen that day.',
    addressLine: 'Sarwar Road, Multan Cantt',
    logoUrl: null,
    coverUrl: unsplash('1629909613654-28e377c37b09', 'cover'),
    themeColor: '#1D4ED8',
    rating: 4.9,
    reviewCount: 57,
    hours: weekdayHours('09:30', '17:30', [{ startsAt: '13:00', endsAt: '14:00' }]),
    gallery: [
      { url: unsplash('1643660527098-559f89e45a92', 'photo'), alt: 'The treatment room with a dental chair and monitor' },
      { url: unsplash('1598256989800-fe5f95da9787', 'photo'), alt: 'A dental chair and equipment in a bright surgery' },
    ],
    services: [
      {
        id: 'svc_dental_checkup',
        name: 'Check-up & clean',
        durationMinutes: 30,
        priceMinor: 300_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 1,
        description: 'Examination, scale and polish.',
        imageUrl: null,
      },
      {
        id: 'svc_dental_filling',
        name: 'Composite filling',
        durationMinutes: 45,
        priceMinor: 550_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 2,
        description: 'Tooth-coloured, one surface. Priced per tooth.',
        imageUrl: null,
      },
      {
        id: 'svc_dental_rct',
        name: 'Root canal',
        durationMinutes: 90,
        priceMinor: 1_800_000,
        depositRequired: true,
        depositAmountMinor: 500_000,
        displayOrder: 3,
        description: 'Usually two visits. Crown quoted separately.',
        imageUrl: null,
      },
      {
        id: 'svc_dental_emergency',
        name: 'Emergency assessment',
        durationMinutes: 20,
        priceMinor: 200_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 4,
        description: 'Held-back afternoon slots. Message and we will fit you in.',
        imageUrl: null,
      },
    ],
    staff: [
      {
        id: 'stf_dental_kamran',
        name: 'Dr. Kamran Shah',
        role: 'Principal dentist',
        serviceIds: ['svc_dental_checkup', 'svc_dental_filling', 'svc_dental_rct', 'svc_dental_emergency'],
        avatarUrl: unsplash('1522529599102-193c0d76b5b6', 'portrait'),
      },
    ],
    reviews: [
      {
        id: 'rev_dental_1',
        authorName: 'Imran B.',
        rating: 5,
        comment:
          'Cracked a molar at lunch, messaged the number, seen at four. Did not try to sell me a crown I did not need.',
        createdAt: '2026-09-09T15:00:00.000Z',
        serviceName: 'Emergency assessment',
      },
      {
        id: 'rev_dental_2',
        authorName: 'Nida Q.',
        rating: 5,
        comment: 'Root canal across two visits, both on time, both explained as they went.',
        createdAt: '2026-08-06T10:20:00.000Z',
        serviceName: 'Root canal',
      },
    ],
  },

  {
    ...base,
    id: 'biz_the_fold',
    slug: 'the-fold',
    name: 'The Fold Barbers',
    category: 'barber',
    city: 'Lahore',
    neighbourhood: 'Gulberg',
    tagline: 'Four chairs, no queue, walk out in forty minutes.',
    about:
      'A Gulberg barbershop built around not waiting. Everything is booked, nothing is walk-in, and the schedule is deliberately loose enough that a cut never runs into the next one.',
    addressLine: 'MM Alam Road, Gulberg III, Lahore',
    logoUrl: null,
    coverUrl: unsplash('1585747860715-2ba37e788b70', 'cover'),
    themeColor: '#0F172A',
    rating: 4.5,
    reviewCount: 143,
    hours: [
      ...[2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt: '11:00', closesAt: '21:00', breaks: [] })),
      { dayOfWeek: 0, opensAt: '13:00', closesAt: '19:00', breaks: [] },
    ],
    gallery: [
      { url: unsplash('1672257493626-038f96997ade', 'photo'), alt: 'Barber chairs along a brick wall' },
      { url: unsplash('1621605815971-fbc98d665033', 'photo'), alt: 'Clippers, scissors and a comb laid out on a board' },
    ],
    services: [
      {
        id: 'svc_fold_cut',
        name: 'Skin fade',
        durationMinutes: 40,
        priceMinor: 180_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 1,
        description: 'Clipper work down to the skin, finished with a razor line.',
        imageUrl: null,
      },
      {
        id: 'svc_fold_beard',
        name: 'Beard shape',
        durationMinutes: 20,
        priceMinor: 90_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 2,
        description: 'Trim, line-up and hot towel.',
        imageUrl: null,
      },
      {
        id: 'svc_fold_full',
        name: 'Cut & beard',
        durationMinutes: 60,
        priceMinor: 250_000,
        depositRequired: false,
        depositAmountMinor: null,
        displayOrder: 3,
        description: 'Both, back to back, one chair.',
        imageUrl: null,
      },
    ],
    staff: [
      {
        id: 'stf_fold_hamza',
        name: 'Hamza Sheikh',
        role: 'Barber',
        serviceIds: ['svc_fold_cut', 'svc_fold_beard', 'svc_fold_full'],
        avatarUrl: unsplash('1549913772-820279f909b7', 'portrait'),
      },
      {
        id: 'stf_fold_junaid',
        name: 'Junaid Ali',
        role: 'Barber',
        serviceIds: ['svc_fold_cut', 'svc_fold_beard', 'svc_fold_full'],
        avatarUrl: unsplash('1619961310218-3457aaebdeb2', 'portrait'),
      },
    ],
    reviews: [
      {
        id: 'rev_fold_1',
        authorName: 'Talha M.',
        rating: 5,
        comment: 'Booked for 6:40, in the chair at 6:40. Nowhere else does this.',
        createdAt: '2026-09-11T14:00:00.000Z',
        serviceName: 'Skin fade',
      },
      {
        id: 'rev_fold_2',
        authorName: 'Saad A.',
        rating: 4,
        comment: 'Good fade, small shop. Do not turn up hoping to walk in, they will turn you away politely.',
        createdAt: '2026-08-27T17:30:00.000Z',
        serviceName: 'Cut & beard',
      },
    ],
  },

  /**
   * Unpublished on purpose.
   *
   * `Business.published` is what hides a half-set-up business from the
   * marketplace, and a fixture set where every entry is published cannot prove
   * the gate works. This one must never appear in the directory, in search, in
   * the sitemap, or at /aura-wellness — that last one is a 404.
   */
  {
    ...base,
    published: false,
    id: 'biz_aura',
    slug: 'aura-wellness',
    name: 'Aura Wellness Spa',
    category: 'spa',
    city: 'Multan',
    neighbourhood: 'Gulgasht Colony',
    tagline: 'Still setting up.',
    about: 'Registered but not yet published. No staff assigned to its services.',
    addressLine: null,
    logoUrl: null,
    coverUrl: null,
    themeColor: null,
    rating: null,
    reviewCount: 0,
    hours: [],
    gallery: [],
    services: [],
    staff: [],
    reviews: [],
  },
];
