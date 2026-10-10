import { isUsableName } from '../lib/name.js';
import express, { type Router } from 'express';
import { z } from 'zod';
import { AppointmentHolder } from '../models/AppointmentHolder.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Booking } from '../models/Booking.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { param } from '../http/params.js';
import { configureBooking, ConfigurationConflict } from '../bookings/configuration.js';
import { newMeToken } from '../me/token.js';

export const holderBody = z.object({
  name: z.string().trim().min(1).max(80).refine(isUsableName, 'Enter a name'),
  active: z.boolean().optional(),
});

export async function saveHolder(
  businessId: string,
  clientId: string,
  input: z.infer<typeof holderBody>,
  holderId?: string,
) {
  return configureBooking(businessId, async (session) => {
    const holder = holderId
      ? await AppointmentHolder.findOne({ _id: holderId, businessId, clientId }).session(session)
      : new AppointmentHolder({ businessId, clientId });
    if (!holder) return null;
    if (!holderId && input.active === false)
      throw new ConfigurationConflict('New appointment holders must be active');
    if (
      (!holderId || (!holder.active && input.active === true)) &&
      (await AppointmentHolder.countDocuments({ businessId, clientId, active: true })
        .session(session)
        .maxTimeMS(5000)) >= 20
    )
      throw new ConfigurationConflict('Appointment-holder limit reached');
    if (
      input.active === false &&
      (await Booking.exists({
        businessId,
        clientId,
        appointmentHolderId: holderId,
        status: { $nin: ['completed', 'cancelled', 'no_show'] },
      })
        .session(session)
        .maxTimeMS(5000))
    )
      throw new ConfigurationConflict(
        'Move or cancel this person’s appointments before removing them',
      );
    holder.set(input);
    await holder.save({ session });
    return { id: String(holder._id), name: holder.name, active: holder.active };
  });
}

export function createHolderRouter(): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;
  const relationship: express.RequestHandler = async (req, res, next) => {
    if (
      !/^[a-f\d]{24}$/i.test(param(req, 'clientId')) ||
      !(await ClientProfile.exists({
        businessId: param(req, 'businessId'),
        clientId: param(req, 'clientId'),
      }).maxTimeMS(5000))
    ) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  };
  router.get('/:businessId/clients/:clientId/holders', ...guard, relationship, async (req, res) => {
    const holders = await AppointmentHolder.find({
      businessId: param(req, 'businessId'),
      clientId: param(req, 'clientId'),
      active: true,
    })
      .limit(20)
      .lean()
      .maxTimeMS(5000);
    res.json({
      holders: holders.map((holder) => ({
        id: String(holder._id),
        name: holder.name,
        active: holder.active,
      })),
    });
  });
  router.post(
    '/:businessId/clients/:clientId/revoke-link',
    ...guard,
    relationship,
    async (req, res) => {
      await ClientProfile.updateOne(
        { businessId: param(req, 'businessId'), clientId: param(req, 'clientId') },
        {
          $set: { meToken: newMeToken(), meTokenExpiresAt: new Date(Date.now() + 180 * 86400000) },
        },
        { maxTimeMS: 5000 },
      );
      res.status(204).end();
    },
  );
  const save: express.RequestHandler = async (req, res) => {
    const parsed = holderBody.safeParse(req.body);
    const id = req.method === 'PATCH' ? param(req, 'holderId') : undefined;
    if (!parsed.success || (id && !/^[a-f\d]{24}$/i.test(id))) {
      res.status(400).json({ error: 'Enter an appointment-holder name' });
      return;
    }
    try {
      const holder = await saveHolder(
        param(req, 'businessId'),
        param(req, 'clientId'),
        parsed.data,
        id,
      );
      if (!holder) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(id ? 200 : 201).json(holder);
    } catch (error) {
      if (error instanceof ConfigurationConflict) {
        res.status(409).json({ error: error.reason });
        return;
      }
      throw error;
    }
  };
  router.post(
    '/:businessId/clients/:clientId/holders',
    ...guard,
    relationship,
    express.json({ limit: '4kb' }),
    save,
  );
  router.patch(
    '/:businessId/clients/:clientId/holders/:holderId',
    ...guard,
    relationship,
    express.json({ limit: '4kb' }),
    save,
  );
  return router;
}
