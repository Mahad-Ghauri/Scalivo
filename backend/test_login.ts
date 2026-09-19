import mongoose from 'mongoose';
import { User } from './src/models/User.js';
import bcrypt from 'bcryptjs';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/scalivo');
  
  const user = await User.findOne({ email: 'owner@skinare.pk' });
  console.log('User found:', !!user);
  
  if (user) {
    const ok = await bcrypt.compare('skinare-dev-password', user.passwordHash);
    console.log('Password matches:', ok);
    console.log('Stored hash:', user.passwordHash);
  }
  
  process.exit(0);
}

run();
