import * as polyfillNative from "./polyfill";
import * as polyfillCR61FF58 from "./polyfill-CR61FF58";
import * as polyfillCR86FF68 from "./polyfill-CR86FF68";

declare const __DEV__: boolean;
declare const CR61FF58: boolean;
declare const CR86FF68: boolean;

export const DEV = typeof __DEV__ === "boolean" ? __DEV__ : true;
const CR61FF58_ = typeof CR61FF58 === "boolean" ? CR61FF58 : false;
const CR86FF68_ = typeof CR86FF68 === "boolean" ? CR86FF68 : false;

const polyfill_ = CR61FF58_ ? polyfillCR61FF58 : CR86FF68_ ? polyfillCR86FF68 : polyfillNative;

export const {
  AbortController_,
  throwIfAborted_,
  installPolyfills: installPolyfills_
} = polyfill_;

export const E_WORKER = "E_WORKER";
export const E_REQUIRED = "E_REQUIRED";
export const E_UNSUPPORTED = "E_UNSUPPORTED";
export const E_TERMINATED = "E_TERMINATED";
export const ERR_INVALID_STATE = "InvalidStateError";
export const ERR_NOT_SUPPORTED = "NotSupportedError";
