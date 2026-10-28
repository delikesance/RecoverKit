import { createRuntime, reconcileAll, replayDeadEvent } from '@recoverkit/services';

const [command, arg] = process.argv.slice(2);
const runtime = createRuntime(process.env);

async function main() {
  switch (command) {
    case 'reconcile': {
      const r = await reconcileAll(runtime.deps);
      console.log(JSON.stringify(r));
      return;
    }
    case 'replay': {
      if (!arg) throw new Error('Usage : replay <stripe_event_id>');
      const ok = await replayDeadEvent(runtime.deps, arg);
      console.log(ok ? `Événement ${arg} remis en file.` : `Aucun événement mort nommé ${arg}.`);
      return;
    }
    default:
      throw new Error('Commandes : reconcile | replay <stripe_event_id>');
  }
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => runtime.close());
