import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { join } from 'node:path';

type FixtureResult = {
  fatal?: string;
  pid: number;
  port: number;
  updates: Array<{
    where: { id: string };
    data: { status: string; errorCode?: string };
  }>;
  targetStates: string[];
};

describe('Automation worker process boundary (e2e)', () => {
  let child: ChildProcess | undefined;

  beforeAll(() => {
    execFileSync(
      process.execPath,
      [join('node_modules', '@nestjs', 'cli', 'bin', 'nest.js'), 'build'],
      {
        cwd: join(__dirname, '..'),
        stdio: 'pipe',
      },
    );
  });

  afterEach(() => {
    if (child?.connected) child.send('shutdown');
    child = undefined;
  });

  it('keeps the same PID healthy and processes a following job after INVALID_OUTPUT', async () => {
    child = fork(
      join(__dirname, 'fixtures', 'automation-worker-process.fixture.cjs'),
      [],
      { cwd: join(__dirname, '..'), silent: true },
    );
    const result = await new Promise<FixtureResult>((resolve, reject) => {
      child!.once('message', (message: FixtureResult) => resolve(message));
      child!.once('exit', (code) =>
        reject(new Error(`fixture exited: ${code}`)),
      );
      child!.once('error', reject);
    });
    if (result.fatal) throw new Error(result.fatal);

    const health = await new Promise<{ status: string; pid: number }>(
      (resolve, reject) => {
        const healthRequest = request(
          { hostname: '127.0.0.1', port: result.port, path: '/health' },
          (response) => {
            let body = '';
            response.on('data', (chunk: Buffer) => (body += chunk.toString()));
            response.on('end', () => {
              if (response.statusCode !== 200)
                return reject(
                  new Error(`health status ${response.statusCode}`),
                );
              resolve(JSON.parse(body) as { status: string; pid: number });
            });
          },
        );
        healthRequest.once('error', reject);
        healthRequest.end();
      },
    );

    expect(child.exitCode).toBeNull();
    expect(health).toEqual({ status: 'ok', pid: result.pid });
    expect(result.targetStates).toEqual(['ERROR', 'WAITING_REPLY']);
    expect(result.updates).toEqual([
      expect.objectContaining({
        where: { id: 'invalid-job' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'INVALID_OUTPUT',
        }) as unknown,
      }),
      expect.objectContaining({
        where: { id: 'next-job' },
        data: expect.objectContaining({ status: 'COMPLETED' }) as unknown,
      }),
    ]);
  });
});
