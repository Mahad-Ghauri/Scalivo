import { CheckMark } from '@/components/Icons';

/**
 * The product, happening — not a description of it. Four messages is the whole
 * booking: ask, offer, confirm, done.
 *
 * Built from divs on purpose. No logo, no wordmark, no borrowed green: the
 * signal colour is ours and it means "this is a booking action" everywhere on
 * the site, here included.
 */
const MESSAGES: { from: 'customer' | 'business'; text: string; time: string; confirmed?: boolean }[] = [
  { from: 'customer', text: 'Hydrafacial Saturday?', time: '23:41' },
  { from: 'business', text: 'Saturday 4:00 PM with Dr. Ayesha — reply 1 to confirm', time: '23:41' },
  { from: 'customer', text: '1', time: '23:42' },
  { from: 'business', text: 'Booked', time: '23:42', confirmed: true },
];

export function BookingThread() {
  return (
    <figure className="border border-rule bg-raised">
      <figcaption className="flex items-baseline justify-between gap-3 border-b border-rule px-4 py-3">
        <span className="label text-muted">A booking, start to finish</span>
        <span className="num text-[0.6875rem] text-muted">SAT 23:41</span>
      </figcaption>

      <ol className="space-y-3 px-4 py-5">
        {MESSAGES.map((message, index) => {
          const mine = message.from === 'customer';

          return (
            <li key={index} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[85%] border px-3 py-2 text-[0.9375rem] leading-snug ${
                  mine
                    ? 'rounded-plate rounded-br-none border-signal/30 bg-signal/10 text-ink'
                    : 'rounded-plate rounded-bl-none border-rule bg-paper text-ink'
                }`}
              >
                {message.confirmed ? (
                  <span className="flex items-center gap-2 font-medium text-signal-deep">
                    <CheckMark />
                    {message.text}
                  </span>
                ) : (
                  message.text
                )}
              </div>
              <span className="num mt-1 text-[0.625rem] text-muted">{message.time}</span>
            </li>
          );
        })}
      </ol>

      <p className="label border-t border-rule px-4 py-3 text-muted">
        Confirmed in the thread. No app, no call, no waiting for morning.
      </p>
    </figure>
  );
}
