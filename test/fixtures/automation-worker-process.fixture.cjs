const http = require('node:http');
const {
  AutomationWorkerService,
} = require('../../dist/automation/automation-worker.service.js');
const {
  AutomationJobType,
} = require('../../dist/generated/prisma/enums.js');

const updates = [];
const targetStates = [];
const prisma = {
  automationJob: {
    update: async (value) => {
      updates.push(value);
      return value;
    },
    updateMany: async () => ({ count: 1 }),
  },
};
const worker = new AutomationWorkerService(prisma, {});
worker.runCampaignTarget = async (targetId) => {
  if (targetId === 'invalid-target') {
    targetStates.push('ERROR');
    const cause = Object.assign(new Error('invalid structured output'), {
      code: 'INVALID_OUTPUT',
      retryable: false,
    });
    const error = new Error('OpenAI did not return a valid result', { cause });
    throw error;
  }
  targetStates.push('WAITING_REPLY');
  return null;
};

const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('worker fixture timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const launch = (job) => {
  worker.active += 1;
  worker.launchWithinBoundary(job);
};

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }
  response.writeHead(404).end();
});

process.on('message', (message) => {
  if (message === 'shutdown') server.close(() => process.exit(0));
});

void (async () => {
  launch({
    id: 'invalid-job',
    type: AutomationJobType.CAMPAIGN_TARGET,
    attempts: 1,
    maxAttempts: 3,
    campaignTargetId: 'invalid-target',
    payload: null,
  });
  await waitFor(() => updates.length === 1 && worker.active === 0);
  launch({
    id: 'next-job',
    type: AutomationJobType.CAMPAIGN_TARGET,
    attempts: 1,
    maxAttempts: 3,
    campaignTargetId: 'next-target',
    payload: null,
  });
  await waitFor(() => updates.length === 2 && worker.active === 0);
  server.listen(0, '127.0.0.1', () => {
    process.send?.({
      pid: process.pid,
      port: server.address().port,
      updates,
      targetStates,
    });
  });
})().catch((error) => {
  process.send?.({ fatal: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
