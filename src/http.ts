import http from "http";
import https from "https";
import type { RequestInit as NFRequestInit } from "node-fetch";

/** Keep-alive agents to speed up fetch round-trips. */
const KA_HTTP = new http.Agent({ keepAlive: true, maxSockets: 64 });
const KA_HTTPS = new https.Agent({ keepAlive: true, maxSockets: 64 });

/**
 * Build a node-fetch RequestInit with keep-alive agent + any extras.
 * Always returns the node-fetch variant of RequestInit to avoid DOM clashes.
 */
export function fetchInit(extras: NFRequestInit = {}): NFRequestInit {
  // node-fetch supports agent: Agent | ((parsedUrl) => Agent)
  const agent = (url: string | URL) => {
    const u = typeof url === "string" ? url : url.toString();
    return u.startsWith("http:") ? KA_HTTP : KA_HTTPS;
  };
  return { agent, ...extras } as NFRequestInit;
}

/** Timeout signal helper (works in Node 18+ / node-fetch v3 typings) */
export function timeout(ms: number): AbortSignal {
  // @ts-ignore AbortSignal.timeout is available in Node 18+
  return AbortSignal.timeout(ms);
}
