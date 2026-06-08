import { __privatePrepareEntryForWorker, type ZipEncoderRuntimeOptions, type ZipInputEntry } from "./index";
import { AbortController_, DEV, E_WORKER, installPolyfills_ } from "./worker-common";

installPolyfills_();

const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void | Promise<void>) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

type WorkerRequest = {
  id: number;
  input: ZipInputEntry;
  options: Omit<ZipEncoderRuntimeOptions, "signal" | "onProgress">;
  pathInfo: { path: string; isDirectory: boolean };
};

const serializeError = (error: unknown): { name: string; message: string } => {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: DEV ? String(error) : E_WORKER };
};

workerSelf.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const { id, input, options, pathInfo } = event.data;
  try {
    const prepared = await __privatePrepareEntryForWorker(input, {
      ...options,
      signal: new AbortController_().signal,
      onProgress: () => undefined
    }, pathInfo);
    const transfer: Transferable[] = [prepared.compressed.buffer];
    if (prepared.extraField.byteLength) transfer.push(prepared.extraField.buffer);
    workerSelf.postMessage({ id, prepared }, transfer);
  } catch (error) {
    workerSelf.postMessage({ id, error: serializeError(error) });
  }
};
