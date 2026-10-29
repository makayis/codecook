import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from "crypto";
import { createServer, type Server, type ServerResponse } from "http";
import type { ChatGptCredential } from "./types";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_AUTHORIZE = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_AGENT_NAME = "Makayis";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;

const REFRESH_MARGIN_MS = 60_000;
const DEAD_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);

interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

export interface ChatGptSignInResult {
  ok: boolean;
  error?: string;
  session?: ChatGptCredential;
  needsApiKey?: boolean;
}

export function createHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function planUsageGranted(scopes: string[]): boolean {
  return scopes.includes(CHATGPT_PLAN_SCOPE);
}

export function needsChatGptRefresh(session: ChatGptCredential, now = Date.now()): boolean {
  if (!session.accessToken || !session.refreshToken) {
    return Boolean(session.refreshToken);
  }
  if (!session.expiresAt) {
    return true;
  }
  return now + REFRESH_MARGIN_MS >= session.expiresAt;
}

export function buildAuthorizeUrl(options: {
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  hostId: string;
  previous?: Pick<ChatGptCredential, "clientId" | "idToken" | "email"> | null;
}): string {
  const query = new URLSearchParams({
    response_type: "code",
    redirect_uri: options.redirectUri,
    scope: CHATGPT_SCOPES,
    resource: CHATGPT_RESOURCE,
    state: options.state,
    nonce: options.nonce,
    code_challenge_method: "S256",
    code_challenge: options.challenge,
    ext_agent_host_id: options.hostId,
  });
  const previous = options.previous?.clientId;
  if (previous && previous !== "dynamic_agent_client") {
    query.set("client_id", previous);
    if (options.previous?.idToken) {
      query.set("id_token_hint", options.previous.idToken);
    }
    if (options.previous?.email) {
      query.set("login_hint", options.previous.email);
    }
  } else {
    query.set("client_id", "dynamic_agent_client");
    query.set("agent_name_hint", CHATGPT_AGENT_NAME);
  }
  return `${CHATGPT_AUTHORIZE}?${query.toString()}`;
}

export function verifyIdToken(
  token: string,
  keys: Jwk[],
  expected: { clientId: string; nonce: string; now?: number }
): { sub: string; email?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("ChatGPT sign-in returned an invalid identity token.");
  }
  const header = decodePart(parts[0]);
  const payload = decodePart(parts[1]);
  if (header.alg !== "RS256") {
    throw new Error("ChatGPT sign-in returned an unsupported identity token.");
  }
  const kid = typeof header.kid === "string" ? header.kid : "";
  const matches = keys.filter((key) => key.kty === "RSA" && key.n && key.e && (!kid || key.kid === kid));
  const signed = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], "base64url");
  const verified = matches.some((key) => {
    const publicKey = createPublicKey({ key: key as never, format: "jwk" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signed);
    return verifier.verify(publicKey, signature);
  });
  if (!verified) {
    throw new Error("ChatGPT sign-in could not be verified.");
  }
  if (payload.iss !== CHATGPT_ISSUER) {
    throw new Error("ChatGPT sign-in came from an unexpected issuer.");
  }
  const audience = payload.aud;
  const audiences = Array.isArray(audience) ? audience.map(String) : [String(audience ?? "")];
  const azp = typeof payload.azp === "string" ? payload.azp : "";
  const clientClaim = typeof payload.client_id === "string" ? payload.client_id : "";
  const audienceOk =
    audiences.includes(expected.clientId) ||
    azp === expected.clientId ||
    (clientClaim === expected.clientId && audiences.includes(CHATGPT_RESOURCE));
  if (!audienceOk) {
    throw new Error("ChatGPT sign-in was issued for a different app.");
  }
  const now = Math.floor((expected.now ?? Date.now()) / 1000);
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= now - 60) {
    throw new Error("ChatGPT sign-in expired. Try again.");
  }
  if (expected.nonce && payload.nonce !== expected.nonce) {
    throw new Error("ChatGPT sign-in did not match this attempt.");
  }
  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) {
    throw new Error("ChatGPT sign-in did not include an account.");
  }
  const email = typeof payload.email === "string" ? payload.email : undefined;
  return { sub, email };
}

export async function runChatGptSignIn(options: {
  hostId: string;
  previous?: ChatGptCredential | null;
  openBrowser: (url: string) => PromiseLike<boolean> | boolean;
  timeoutMs?: number;
}): Promise<ChatGptSignInResult> {
  const pkce = createPkce();
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(16).toString("base64url");
  const callback = await listenForCallback(state, options.timeoutMs ?? 600_000);
  try {
    const url = buildAuthorizeUrl({
      redirectUri: callback.redirectUri,
      state,
      nonce,
      challenge: pkce.challenge,
      hostId: options.hostId,
      previous: options.previous,
    });
    void Promise.resolve(options.openBrowser(url)).catch(() => undefined);
    const hit = await callback.done;
    try {
      const failure = await finishChatGptCallback(hit.params, {
        nonce,
        verifier: pkce.verifier,
        redirectUri: callback.redirectUri,
        hostId: options.hostId,
        previous: options.previous,
      });
      hit.complete(failure.page, failure.ok);
      return failure.result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "ChatGPT sign-in failed.";
      hit.complete(message, false);
      return { ok: false, error: message };
    }
  } catch (err) {
    callback.cancel(err instanceof Error ? err.message : "ChatGPT sign-in failed.");
    return { ok: false, error: err instanceof Error ? err.message : "ChatGPT sign-in failed." };
  }
}

async function finishChatGptCallback(
  params: URLSearchParams,
  options: {
    nonce: string;
    verifier: string;
    redirectUri: string;
    hostId: string;
    previous?: ChatGptCredential | null;
  }
): Promise<{ ok: boolean; page: string; result: ChatGptSignInResult }> {
  if (params.get("error")) {
    const result = { ok: false, error: "ChatGPT sign-in was cancelled." };
    return { ok: false, page: result.error, result };
  }
  const code = params.get("code") || "";
  if (!code) {
    const result = { ok: false, error: `ChatGPT sign-in did not return a code (${callbackKeys(params)}).` };
    return { ok: false, page: result.error, result };
  }
  const issued = issuedClientId(params.get("client_id"), options.previous?.clientId);
  if (!issued) {
    const result = { ok: false, error: `ChatGPT did not finish registering CodeCook (${callbackKeys(params)}).` };
    return { ok: false, page: result.error, result };
  }
  const token = await requestToken({
    grant_type: "authorization_code",
    client_id: issued,
    code,
    code_verifier: options.verifier,
    redirect_uri: options.redirectUri,
    resource: CHATGPT_RESOURCE,
  });
  const keys = await loadJwks();
  const idToken = String(token.id_token ?? "");
  const identity = verifyIdToken(idToken, keys, { clientId: issued, nonce: options.nonce });
  if (options.previous?.subject && options.previous.subject !== identity.sub) {
    const result = { ok: false, error: "That ChatGPT account does not match the saved sign-in." };
    return { ok: false, page: result.error, result };
  }
  const scopes = readScopes(token.scope).length ? readScopes(token.scope) : readScopes(params.get("scope"));
  const session = sessionFromToken(token, {
    clientId: issued,
    hostId: options.hostId,
    subject: identity.sub,
    email: identity.email,
    idToken,
    scopes,
    previous: options.previous,
  });
  if (!planUsageGranted(scopes)) {
    const result: ChatGptSignInResult = {
      ok: false,
      needsApiKey: true,
      session,
      error: "ChatGPT plan usage was not granted. Create an API key and paste it here.",
    };
    return { ok: false, page: result.error || "ChatGPT plan usage was not granted.", result };
  }
  return {
    ok: true,
    page: "CodeCook is connected to ChatGPT. You can close this tab.",
    result: { ok: true, session },
  };
}

export async function refreshChatGptSession(session: ChatGptCredential): Promise<{ session: ChatGptCredential; fatal: boolean; error?: string }> {
  if (!session.refreshToken || !session.clientId || session.clientId === "dynamic_agent_client") {
    return { session: clearTokens(session), fatal: true, error: "Sign in with ChatGPT again." };
  }
  try {
    const token = await requestToken({
      grant_type: "refresh_token",
      client_id: session.clientId,
      refresh_token: session.refreshToken,
      resource: CHATGPT_RESOURCE,
    });
    const scopes = token.scope ? readScopes(token.scope) : session.scopes;
    let idToken = session.idToken || "";
    let email = session.email;
    if (typeof token.id_token === "string" && token.id_token) {
      try {
        const identity = verifyIdToken(token.id_token, await loadJwks(), {
          clientId: session.clientId,
          nonce: "",
        });
        if (identity.sub !== session.subject) {
          return { session: clearTokens(session), fatal: true, error: "Sign in with ChatGPT again." };
        }
        idToken = token.id_token;
        email = identity.email ?? email;
      } catch {
        idToken = session.idToken || "";
      }
    }
    return {
      fatal: false,
      session: sessionFromToken(token, {
        clientId: session.clientId,
        hostId: session.hostId,
        subject: session.subject,
        email,
        idToken,
        scopes,
        previous: session,
      }),
    };
  } catch (err) {
    const coded = err as { code?: string };
    if (coded.code && DEAD_REFRESH.has(coded.code)) {
      return { session: clearTokens(session), fatal: true, error: "Sign in with ChatGPT again." };
    }
    return { session, fatal: false, error: err instanceof Error ? err.message : "ChatGPT sign-in could not be refreshed." };
  }
}

function clearTokens(session: ChatGptCredential): ChatGptCredential {
  return {
    email: session.email,
    subject: session.subject,
    clientId: session.clientId,
    hostId: session.hostId,
    scopes: [],
  };
}

function sessionFromToken(
  token: Record<string, unknown>,
  identity: {
    clientId: string;
    hostId: string;
    subject: string;
    email?: string;
    idToken: string;
    scopes: string[];
    previous?: ChatGptCredential | null;
  }
): ChatGptCredential {
  const expiresIn = Number(token.expires_in);
  const accessToken = typeof token.access_token === "string" ? token.access_token : identity.previous?.accessToken;
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : identity.previous?.refreshToken;
  return {
    email: identity.email,
    subject: identity.subject,
    clientId: identity.clientId,
    hostId: identity.hostId,
    idToken: identity.idToken || undefined,
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + 3600 * 1000,
    scopes: identity.scopes,
  };
}

function issuedClientId(callbackId: string | null, previousId: string | undefined): string | null {
  if (callbackId && callbackId !== "dynamic_agent_client") {
    if (previousId && previousId !== "dynamic_agent_client" && callbackId !== previousId) {
      return null;
    }
    return callbackId;
  }
  if (previousId && previousId !== "dynamic_agent_client") {
    return previousId;
  }
  return null;
}

function readScopes(value: unknown): string[] {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

function decodePart(part: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ChatGPT sign-in returned an invalid identity token.");
  }
  return parsed as Record<string, unknown>;
}

let jwksCache: { at: number; keys: Jwk[] } | undefined;

async function loadJwks(): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 60 * 60 * 1000) {
    return jwksCache.keys;
  }
  const discovery = await fetchJson(`${CHATGPT_ISSUER}/.well-known/openid-configuration`);
  const uri = typeof discovery.jwks_uri === "string" ? discovery.jwks_uri : "";
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("Could not load ChatGPT sign-in keys.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com") {
    throw new Error("Could not load ChatGPT sign-in keys.");
  }
  const body = await fetchJson(uri);
  const keys = Array.isArray(body.keys) ? (body.keys as Jwk[]) : [];
  jwksCache = { at: Date.now(), keys };
  return keys;
}

function tokenFailure(status: number, body: Record<string, unknown>): { message: string; code: string } {
  let code = "";
  let message = "";
  if (typeof body.error === "string") {
    code = body.error;
  } else if (body.error && typeof body.error === "object") {
    const nested = body.error as { message?: unknown; code?: unknown };
    if (typeof nested.code === "string") {
      code = nested.code;
    }
    if (typeof nested.message === "string") {
      message = nested.message;
    }
  }
  if (!message && typeof body.error_description === "string") {
    message = body.error_description;
  }
  if (!message && typeof body.detail === "string") {
    message = body.detail;
  }
  if (!message && typeof body.message === "string") {
    message = body.message;
  }
  if (code === "invalid_grant") {
    message = message || "ChatGPT rejected the login code. This is not a Plus or Pro check. Try Continue with ChatGPT once more, and leave the browser tab open until it finishes.";
  }
  if (!message) {
    message = `ChatGPT sign-in was rejected (HTTP ${status}${code ? `, ${code}` : ""}).`;
  }
  return { message, code };
}

async function requestToken(fields: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(CHATGPT_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const failure = tokenFailure(response.status, body);
    const error = new Error(failure.message) as Error & { code?: string };
    error.code = failure.code;
    throw error;
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("ChatGPT sign-in did not return an access token.");
  }
  return body;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    throw new Error("Could not reach ChatGPT sign-in.");
  }
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Could not reach ChatGPT sign-in.");
  }
  return body as Record<string, unknown>;
}

function callbackKeys(params: URLSearchParams): string {
  return [...params.keys()].join(", ") || "no details";
}

function decodeQuery(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%2B"));
  } catch {
    return value;
  }
}

function queryParams(rawUrl: string): URLSearchParams {
  const query = rawUrl.split("?")[1]?.split("#")[0] ?? "";
  const params = new URLSearchParams();
  if (!query) {
    return params;
  }
  for (const part of query.split("&")) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    const key = decodeQuery((eq === -1 ? part : part.slice(0, eq)));
    const value = decodeQuery(eq === -1 ? "" : part.slice(eq + 1));
    params.append(key, value);
  }
  return params;
}

function callbackPage(message: string): string {
  const safe = message.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] || char);
  return `<!DOCTYPE html><html><body><p>${safe}</p></body></html>`;
}

function listenForCallback(expectedState: string, timeoutMs: number): Promise<{
  redirectUri: string;
  done: Promise<{ params: URLSearchParams; complete: (message: string, ok: boolean) => void }>;
  cancel: (message: string) => void;
}> {
  return new Promise((resolve, reject) => {
    let server: Server;
    let settle: (value: { params: URLSearchParams; complete: (message: string, ok: boolean) => void }) => void;
    let fail: (err: Error) => void;
    let settled = false;
    const done = new Promise<{ params: URLSearchParams; complete: (message: string, ok: boolean) => void }>((res, rej) => {
      settle = res;
      fail = rej;
    });
    done.catch(() => undefined);
    let wait: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(timer);
      clearTimeout(wait);
      server.close();
    };
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      close();
      fail(new Error("ChatGPT sign-in timed out. Try again."));
    }, timeoutMs);
    let pending: URLSearchParams | undefined;
    const reply = (res: ServerResponse, message: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end(callbackPage(message));
    };
    server = createServer((req, res) => {
      const path = (req.url || "/").split("?")[0];
      if (req.method !== "GET" || path !== CHATGPT_CALLBACK_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }
      const params = queryParams(req.url || "/");
      if (params.get("state") !== expectedState || !params.get("code")) {
        res.writeHead(404);
        res.end();
        return;
      }
      reply(res, "Finishing ChatGPT sign-in in CodeCook. You can leave this tab open.");
      if (settled) {
        return;
      }
      pending = params;
      clearTimeout(wait);
      wait = setTimeout(() => {
        if (settled || !pending) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const captured = pending;
        settle({
          params: captured,
          complete: () => {
            close();
          },
        });
      }, 500);
    });
    let opened = false;
    server.on("error", (err) => {
      if (opened) {
        if (!settled) {
          settled = true;
          close();
          fail(err);
        }
        return;
      }
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      opened = true;
      const address = server.address();
      if (!address || typeof address === "string") {
        settled = true;
        close();
        reject(new Error("Could not open the ChatGPT sign-in callback."));
        return;
      }
      resolve({
        redirectUri: `http://127.0.0.1:${address.port}${CHATGPT_CALLBACK_PATH}`,
        done,
        cancel: (message: string) => {
          if (settled) {
            return;
          }
          settled = true;
          close();
          fail(new Error(message));
        },
      });
    });
  });
}
