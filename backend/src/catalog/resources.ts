import express, { type Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Resource } from '../models/Resource.js';
import { Service } from '../models/Service.js';
import { Booking } from '../models/Booking.js';
import { BlockedTime } from '../models/BlockedTime.js';
import { requireAuth, requireTenant } from '../auth/middleware.js';
import { fieldErrors, param } from '../http/params.js';
import { configureBooking, ConfigurationConflict } from '../bookings/configuration.js';
import { isDuplicateKey } from '../lib/mongo.js';
import { chooseResources, resourceUnitIds, type ResourceCapacity } from '../bookings/capacity.js';
import { CapacityOccupancy } from '../models/CapacityOccupancy.js';

export const resourceRequirementsSchema = z
  .array(
    z.object({
      anyOfResourceIds: z
        .array(z.string().regex(/^[a-f\d]{24}$/i))
        .min(1)
        .max(4)
        .refine((ids) => new Set(ids).size === ids.length, 'Remove duplicate resources'),
    }),
  )
  .max(4);

export async function validateRequirements(
  businessId: string,
  groups: z.infer<typeof resourceRequirementsSchema>,
  session?: mongoose.ClientSession,
): Promise<void> {
  const ids = [...new Set(groups.flatMap((group) => group.anyOfResourceIds))];
  if (!ids.length) return;
  const resources = await Resource.find({ businessId, _id: { $in: ids }, active: true })
    .session(session ?? null)
    .lean()
    .maxTimeMS(5000);
  if (resources.length !== ids.length)
    throw new ConfigurationConflict('Choose active resources belonging to this business');
  const kinds = new Map(resources.map((resource) => [String(resource._id), resource.kind]));
  if (groups.some((group) => new Set(group.anyOfResourceIds.map((id) => kinds.get(id))).size > 1))
    throw new ConfigurationConflict(
      'Rooms, beds, chairs and equipment must be in separate requirements. Each requirement reserves one available unit.',
    );
  const parents = [
    ...new Set(
      resources.flatMap((resource) => (resource.fixedRoomId ? [resource.fixedRoomId] : [])),
    ),
  ];
  const rooms = parents.length
    ? await Resource.find({ businessId, _id: { $in: parents }, active: true, kind: 'room' })
        .session(session ?? null)
        .lean()
        .maxTimeMS(5000)
    : [];
  const capacity: ResourceCapacity = { assets: new Map(), taken: new Map(), blocks: [] };
  for (const resource of [...resources, ...rooms])
    for (const id of resourceUnitIds(String(resource._id), resource.quantity ?? 1))
      capacity.assets.set(id, {
        id,
        resourceId: String(resource._id),
        kind: resource.kind,
        fixedRoomId: resource.fixedRoomId ?? null,
      });
  if (!chooseResources(groups, capacity, new Date(0), 1))
    throw new ConfigurationConflict(
      'These requirements cannot be used together. Check fixed-room equipment and duplicate requirements.',
    );
}

const body = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['room', 'bed', 'chair', 'equipment']),
  quantity: z.number().int().min(1).max(20).default(1),
  fixedRoomId: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .nullable()
    .default(null),
  active: z.boolean().default(true),
});
const patch = body.partial();

export function createResourceRouter(): Router {
  const router = express.Router();
  const guard = [requireAuth, requireTenant()] as const;
  router.get('/:businessId/resource-blocks', ...guard, async (req, res) => {
    const blocks = await BlockedTime.find({
      businessId: param(req, 'businessId'),
      resourceId: { $ne: null },
      endsAt: { $gt: new Date() },
    })
      .sort({ startsAt: 1 })
      .limit(100)
      .lean()
      .maxTimeMS(5000);
    res.json({ blocks: blocks.map((block) => ({ ...block, id: String(block._id) })) });
  });
  router.get('/:businessId/resources', ...guard, async (req, res) => {
    const resources = await Resource.find({ businessId: param(req, 'businessId') })
      .sort({ kind: 1, name: 1 })
      .limit(200)
      .lean()
      .maxTimeMS(5000);
    res.json({ resources: resources.map((asset) => ({ ...asset, id: String(asset._id) })) });
  });
  const save: express.RequestHandler = async (req, res) => {
    const parsed = (req.method === 'POST' ? body : patch).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid resource', fields: fieldErrors(parsed.error) });
      return;
    }
    const businessId = param(req, 'businessId');
    const id = req.method === 'POST' ? null : param(req, 'resourceId');
    if (id && !mongoose.isValidObjectId(id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    try {
      const resource = await configureBooking(businessId, async (session) => {
        const asset = id
          ? await Resource.findOne({ _id: id, businessId }).session(session)
          : new Resource({ businessId });
        if (!asset) return null;
        const merged = {
          ...asset.toObject(),
          ...parsed.data,
          quantity: parsed.data.quantity ?? asset.quantity ?? 1,
        };
        if (merged.kind === 'room' && merged.fixedRoomId)
          throw new ConfigurationConflict('A room cannot be placed inside another room');
        if ((merged.kind === 'bed' || merged.kind === 'chair') && !merged.fixedRoomId)
          throw new ConfigurationConflict('Choose the room containing these beds or chairs');
        if (merged.fixedRoomId) {
          const parent = await Resource.findOne({
            _id: merged.fixedRoomId,
            businessId,
            kind: 'room',
            active: true,
          })
            .select('quantity')
            .session(session)
            .lean()
            .maxTimeMS(5000);
          if (!parent || (parent.quantity ?? 1) !== 1)
            throw new ConfigurationConflict(
              'Choose an active, individually named room. Rooms with stations must have quantity 1',
            );
        }
        if (!id || merged.quantity !== (asset.quantity ?? 1)) {
          const inventory = await Resource.find({ businessId })
            .select('quantity')
            .session(session)
            .limit(201)
            .lean()
            .maxTimeMS(5000);
          const units =
            inventory.reduce((total, resource) => total + (resource.quantity ?? 1), 0) -
            (id ? (asset.quantity ?? 1) : 0) +
            merged.quantity;
          if (inventory.length > 200 || units > 200)
            throw new ConfigurationConflict('Inventory limit is 200 physical units');
          if (
            id &&
            merged.kind === 'room' &&
            merged.quantity > 1 &&
            (await Resource.exists({ businessId, fixedRoomId: id, active: true })
              .session(session)
              .maxTimeMS(5000))
          )
            throw new ConfigurationConflict(
              'A room containing beds, chairs or fixed equipment must have quantity 1',
            );
          if (
            id &&
            merged.quantity < (asset.quantity ?? 1) &&
            (await CapacityOccupancy.exists({
              businessId,
              capacityKey: {
                $in: resourceUnitIds(id, asset.quantity ?? 1)
                  .slice(merged.quantity)
                  .map((unit) => `resource:${unit}`),
              },
              slotStart: { $gte: new Date(Math.floor(Date.now() / 60000) * 60000) },
            })
              .session(session)
              .maxTimeMS(5000))
          )
            throw new ConfigurationConflict(
              'Move or cancel appointments using these units before reducing quantity',
            );
        }
        if (
          id &&
          (merged.active !== asset.active ||
            merged.kind !== asset.kind ||
            merged.fixedRoomId !== asset.fixedRoomId)
        ) {
          const dependentService = await Service.exists({
            businessId,
            active: true,
            'resourceRequirements.anyOfResourceIds': id,
          }).session(session);
          const dependentEquipment = await Resource.exists({
            businessId,
            active: true,
            fixedRoomId: id,
          }).session(session);
          const dependentBooking = await Booking.exists({
            businessId,
            resourceIds: id,
            status: { $ne: 'cancelled' },
            $expr: {
              $gt: [
                {
                  $add: [
                    '$startsAt',
                    {
                      $multiply: [
                        { $add: ['$durationMinutes', { $ifNull: ['$bufferMinutes', 0] }] },
                        60000,
                      ],
                    },
                  ],
                },
                new Date(),
              ],
            },
          }).session(session);
          if (dependentService || dependentEquipment || dependentBooking)
            throw new ConfigurationConflict(
              'This resource is in use. Update its services, equipment and appointments first. Use blocked time for temporary downtime.',
            );
        }
        asset.set(parsed.data);
        await asset.save({ session });
        return asset;
      });
      if (!resource) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.status(id ? 200 : 201).json({ ...resource.toObject(), id: String(resource._id) });
    } catch (error) {
      if (error instanceof ConfigurationConflict || isDuplicateKey(error)) {
        res.status(409).json({
          error:
            error instanceof ConfigurationConflict
              ? error.reason
              : 'A resource with that name already exists',
        });
        return;
      }
      throw error;
    }
  };
  router.post('/:businessId/resources', ...guard, express.json(), save);
  router.patch('/:businessId/resources/:resourceId', ...guard, express.json(), save);
  return router;
}
