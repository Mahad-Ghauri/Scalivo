import mongoose, { type ClientSession } from 'mongoose';
import { Business } from '../models/Business.js';

/** Configuration and reservations write the same fence in their transactions. */
export async function configureBooking<T>(
  businessId: string,
  change: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let value: T | undefined;
    await session.withTransaction(
      async () => {
        await Business.updateOne(
          { _id: businessId },
          { $inc: { bookingConfigRevision: 1, bookingFence: 1 } },
          { session, maxTimeMS: 5000 },
        );
        value = await change(session);
      },
      { maxCommitTimeMS: 5000 },
    );
    return value as T;
  } finally {
    await session.endSession();
  }
}

export class ConfigurationConflict extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
