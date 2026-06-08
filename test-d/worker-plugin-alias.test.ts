import { createWorkerBackend } from "../src/worker-plugin";

const worker = createWorkerBackend({
  worker: () => new Worker("/dist/jszipp.worker.mjs", { type: "module" })
});

worker.terminate();
