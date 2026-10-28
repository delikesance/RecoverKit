import { SystemClock } from '@recoverkit/core';
import { createRuntime } from '@recoverkit/services';
import { Scheduler } from './scheduler';
import { buildTasks } from './tasks';

const runtime = createRuntime(process.env);
const { deps } = runtime;
const scheduler = new Scheduler(new SystemClock(), deps.log);
for (const task of buildTasks(deps)) scheduler.add(task);

deps.log.info({ tasks: buildTasks(deps).map((t) => t.name) }, 'worker RecoverKit démarré');
scheduler.start(1000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  deps.log.info({ signal }, 'arrêt du worker : attente des tâches en cours');
  await scheduler.stop();
  await runtime.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
