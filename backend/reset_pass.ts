import mongoose from 'mongoose';
import { User } from './src/models/User.js';
import bcrypt from 'bcryptjs';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/scalivo');
  
  const hash = await bcrypt.hash('skinare-dev-password', 12);
  await User.updateOne({ email: 'owner@skinare.pk' }, { $set: { passwordHash: hash } });
  
  console.log('Password updated for owner@skinare.pk');
  process.exit(0);
}

run();
