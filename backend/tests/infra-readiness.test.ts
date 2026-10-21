import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { infraReady } from './infra.js';

const probes = vi.hoisted(() => ({
  mongoConnect: vi.fn(),
  hello: vi.fn(),
  redisConnect: vi.fn(),
  redisPing: vi.fn(),
  redisDisconnect: vi.fn(),
  pgConnect: vi.fn(),
  pgQuery: vi.fn(),
  pgEnd: vi.fn(),
}));

vi.mock('mongoose', () => ({
  default: {
    connect: probes.mongoConnect,
    connection: { db: { admin: () => ({ command: probes.hello }) } },
  },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    connect = probes.redisConnect;
    ping = probes.redisPing;
    disconnect = probes.redisDisconnect;
  },
}));
vi.mock('pg', () => ({
  Client: class {
    connect = probes.pgConnect;
    query = probes.pgQuery;
    end = probes.pgEnd;
  },
}));

describe('integration test infrastructure readiness', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('CI', 'true');
    probes.mongoConnect.mockResolvedValue(undefined);
    probes.hello.mockResolvedValue({ setName: 'rs0' });
    probes.redisConnect.mockResolvedValue(undefined);
    probes.redisPing.mockResolvedValue('PONG');
    probes.pgConnect.mockResolvedValue(undefined);
    probes.pgQuery.mockResolvedValue({ rows: [{ value: 1 }] });
    probes.pgEnd.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('requires all requested services and closes its temporary clients', async () => {
    expect(await infraReady({ replicaSet: true, redis: true, postgres: true })).toBe(true);
    expect(probes.hello).toHaveBeenCalledWith({ hello: 1, maxTimeMS: 2000 });
    expect(probes.redisDisconnect).toHaveBeenCalledOnce();
    expect(probes.pgQuery).toHaveBeenCalledWith('SELECT 1');
    expect(probes.pgEnd).toHaveBeenCalledOnce();
  });

  it('fails CI instead of silently skipping when MongoDB is unavailable', async () => {
    probes.mongoConnect.mockRejectedValue(new Error('private driver detail'));
    await expect(infraReady()).rejects.toThrow('Required test infrastructure is unavailable.');
    expect(probes.redisConnect).not.toHaveBeenCalled();
  });

  it('still allows local infrastructure-dependent suites to skip', async () => {
    vi.stubEnv('CI', 'false');
    probes.mongoConnect.mockRejectedValue(new Error('unavailable'));
    expect(await infraReady()).toBe(false);
  });

  it('fails CI for standalone MongoDB when transactions require a replica set', async () => {
    probes.hello.mockResolvedValue({});
    await expect(infraReady({ replicaSet: true })).rejects.toThrow('Required test infrastructure');
  });

  it('disconnects a failed Redis probe before failing CI', async () => {
    probes.redisPing.mockRejectedValue(new Error('unavailable'));
    await expect(infraReady({ redis: true })).rejects.toThrow('Required test infrastructure');
    expect(probes.redisDisconnect).toHaveBeenCalledOnce();
  });

  it('ends a failed PostgreSQL connection probe before failing CI', async () => {
    probes.pgConnect.mockRejectedValue(new Error('unavailable'));
    await expect(infraReady({ postgres: true })).rejects.toThrow('Required test infrastructure');
    expect(probes.pgEnd).toHaveBeenCalledOnce();
  });

  it('ends a failed PostgreSQL query probe before failing CI', async () => {
    probes.pgQuery.mockRejectedValue(new Error('unavailable'));
    await expect(infraReady({ postgres: true })).rejects.toThrow('Required test infrastructure');
    expect(probes.pgEnd).toHaveBeenCalledOnce();
  });
});
