import mongoose from 'mongoose';
import { User } from './src/models/User.js';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/scalivo');
  const users = await User.find({ role: 'owner' }).lean();
  console.log('Owners:', users.map(u => u.email));
  process.exit(0);
}

run();
