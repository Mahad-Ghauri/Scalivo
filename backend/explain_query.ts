import mongoose from 'mongoose';
import { Booking } from './src/models/Booking.js';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/scalivo?replicaSet=rs0');
  
  const from = new Date('2023-10-18T00:00:00Z');
  const to = new Date('2023-10-25T00:00:00Z');
  
  const explanation = await Booking.find({
    businessId: '6aad828897d5d2261a1c0742',
    startsAt: { $gte: from, $lt: to }
  }).explain('executionStats');
  
  console.log('Query Planner:', JSON.stringify(explanation.queryPlanner, null, 2));
  console.log('Execution Stats:', JSON.stringify(explanation.executionStats, null, 2));
  process.exit(0);
}

run();
