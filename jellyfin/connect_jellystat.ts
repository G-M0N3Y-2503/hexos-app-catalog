// Type imports only: each script is compiled standalone, so runtime imports of sibling files wouldn't resolve.
import type { HookContext, HookInputDeclaration } from "../_lib/hook_context";

/**
 * Finishes Jellystat's first-run setup against this Jellyfin server (connect-jellystat), as its own
 * setup pages do: an account to sign in to Jellystat with, then the server's address and an API key
 * of Jellystat's own. The account is the owner's Jellyfin administrator, the sign-in they chose for
 * the install or collection (`ctx.signIn`), so they sign in to both with the same username and
 * password; run from the card with none, it asks. Jellystat starts its first sync by itself once
 * setup is done.
 */

const CLIENT_HEADER = 'MediaBrowser Client="HexOS", Device="Setup", DeviceId="hexos-jellystat-link", Version="1.0.0"';
const KEY_NAME = "Jellystat";

/** Jellystat's setup state (backend/classes/config.js): 0 no account, 1 no Jellyfin server, 2 set up. */
const NO_ACCOUNT = 0;
const SET_UP = 2;

// --- Keccak-512 --------------------------------------------------------------
// Jellystat's pages send CryptoJS.SHA3(password), which is the original Keccak-512 (padding 0x01),
// not the SHA3-512 Node's crypto offers (padding 0x06), and it stores whatever it is sent. The
// script can't import crypto-js, so the permutation is here.

const MASK = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rotation offsets by lane, x + 5y. */
const ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
].map(BigInt);

const rotate = (lane: bigint, by: bigint) => (by === 0n ? lane : ((lane << by) | (lane >> (64n - by))) & MASK);

function permute(state: bigint[]) {
  for (const constant of ROUND_CONSTANTS) {
    const columns = [0, 1, 2, 3, 4].map((x) => state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = columns[(x + 4) % 5] ^ rotate(columns[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    const moved = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[x + 5 * y], ROTATIONS[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) state[x + y] = moved[x + y] ^ (~moved[((x + 1) % 5) + y] & MASK & moved[((x + 2) % 5) + y]);
    }
    state[0] ^= constant;
  }
}

/** Keccak-512 of `text` as UTF-8, in hex. `padding` 0x06 gives SHA3-512, which is how it is checked. */
export function keccak512Hex(text: string, padding = 0x01): string {
  const rate = 72;
  const message = new TextEncoder().encode(text);
  const blocks = new Uint8Array(Math.floor(message.length / rate + 1) * rate);
  blocks.set(message);
  blocks[message.length] ^= padding;
  blocks[blocks.length - 1] ^= 0x80;
  const state = new Array<bigint>(25).fill(0n);
  for (let offset = 0; offset < blocks.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n;
      for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(blocks[offset + lane * 8 + byte]);
      state[lane] ^= value;
    }
    permute(state);
  }
  let hex = "";
  for (let lane = 0; lane < 8; lane++) {
    for (let byte = 0; byte < 8; byte++) hex += ((state[lane] >> BigInt(8 * byte)) & 0xffn).toString(16).padStart(2, "0");
  }
  return hex;
}

// --- the link ----------------------------------------------------------------

async function setupState(base: string): Promise<number | undefined> {
  const body = await fetch(`${base}/auth/isConfigured`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => response.json() as Promise<{ state?: number }>)
    .catch(() => undefined);
  return typeof body?.state === "number" ? body.state : undefined;
}

/** An API key of Jellystat's own, made once with the owner's sign-in: a rerun finds it. */
async function jellystatKey(ctx: HookContext, username: string, password: string): Promise<string> {
  const signIn = await fetch(`${ctx.baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: CLIENT_HEADER },
    body: JSON.stringify({ Username: username, Pw: password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (signIn.status === 401) {
    ctx.fail("Jellyfin didn't accept that username and password. Run Connect to Jellystat from Jellyfin with the account you set Jellyfin up with.");
  }
  if (!signIn.ok) ctx.fail("HexOS couldn't sign in to Jellyfin", [{ label: "Status", value: String(signIn.status) }]);
  const { AccessToken: token } = (await signIn.json()) as { AccessToken?: string };
  if (!token) ctx.fail("Jellyfin signed HexOS in without a token");
  const headers = { Authorization: `${CLIENT_HEADER}, Token="${token}"` };
  const find = async () => {
    const response = await fetch(`${ctx.baseUrl}/Auth/Keys`, { headers, signal: AbortSignal.timeout(15_000) });
    if (response.status === 403) {
      ctx.fail("That Jellyfin account isn't an administrator. Run Connect to Jellystat from Jellyfin with the account you set Jellyfin up with.");
    }
    if (!response.ok) ctx.fail("Jellyfin didn't list its API keys", [{ label: "Status", value: String(response.status) }]);
    const keys = (await response.json()) as { Items?: Array<{ AppName?: string; AccessToken?: string }> };
    return keys.Items?.find((key) => key.AppName === KEY_NAME)?.AccessToken;
  };
  const existing = await find();
  if (existing) return existing;
  const created = await fetch(`${ctx.baseUrl}/Auth/Keys?app=${KEY_NAME}`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!created.ok) ctx.fail("Jellyfin didn't make an API key for Jellystat", [{ label: "Status", value: String(created.status) }]);
  const key = await find();
  if (!key) ctx.fail("Jellyfin made an API key for Jellystat, but HexOS couldn't find it");
  return key;
}

/**
 * Jellystat's setup handlers never answer a failure they catch, so every call is cut short; one
 * that gets no answer at all (Jellystat still starting) is tried again.
 */
async function post(ctx: HookContext, url: string, body: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => {
      if (attempt >= 4) throw error;
      return undefined;
    });
    if (response) return response;
    await ctx.sleep(5_000);
  }
}

/** Jellystat answers once its database is up, which takes a while on a fresh install. */
async function waitForSetupState(ctx: HookContext, base: string): Promise<number | undefined> {
  for (let attempt = 0; attempt < 24; attempt++) {
    const state = await setupState(base);
    if (state !== undefined) return state;
    await ctx.sleep(5_000);
  }
  return undefined;
}

async function ask(ctx: HookContext, inputs: HookInputDeclaration[], prompt: { title: string; description: string }) {
  if (typeof ctx.askForInputs !== "function") return undefined;
  return ctx.askForInputs(inputs, prompt).catch((error: unknown) => {
    if (error instanceof Error && error.name === "HookInputsUnanswered") return undefined;
    throw error;
  });
}

/** The owner's Jellyfin administrator: the sign-in they chose, else the one they give now. */
async function account(ctx: HookContext): Promise<{ username: string; password: string }> {
  if (ctx.signIn) return ctx.signIn;
  const answers = await ask(
    ctx,
    [
      { type: "question", id: "username", question: { question: "Jellyfin username", type: "text", key: "username", required: true } },
      { type: "question", id: "password", question: { question: "Jellyfin password", type: "password", key: "password", required: true } },
    ],
    { title: "Sign in to Jellyfin", description: "Enter your Jellyfin administrator's sign-in. You'll sign in to Jellystat with it too." },
  );
  const username = typeof answers?.username === "string" ? answers.username.trim() : "";
  const password = typeof answers?.password === "string" ? answers.password : "";
  if (!username || !password) ctx.fail("Jellystat needs your Jellyfin sign-in. Run Connect to Jellystat from Jellyfin to give it.");
  return { username, password };
}

export async function run(ctx: HookContext) {
  await ctx.registerCheckpoints([
    { id: "locate", message: "Finding Jellystat" },
    { id: "key", message: "Making Jellystat an API key in Jellyfin" },
    { id: "account", message: "Creating your Jellystat sign-in" },
    { id: "connect", message: "Pointing Jellystat at this Jellyfin server" },
  ]);

  const base = await ctx.getInstalledAppUrl("jellystat");
  if (!base) ctx.fail("Jellystat isn't installed, or HexOS can't find its port");
  if (!ctx.host || !ctx.port) ctx.fail("HexOS couldn't find this Jellyfin server's address");
  const state = await waitForSetupState(ctx, base);
  if (state === undefined) ctx.fail("Jellystat didn't answer. Try again once it has started.");
  await ctx.emitCheckpoint("locate");
  if (state === SET_UP) {
    for (const id of ["key", "account", "connect"]) await ctx.skipCheckpoint(id, "Jellystat is already set up");
    return;
  }

  const { username, password } = await account(ctx);
  const apiKey = await jellystatKey(ctx, username, password);
  await ctx.emitCheckpoint("key");

  // An account someone already made in Jellystat is theirs: only a Jellystat with none gets one.
  // The account comes first, or the server's row is made without one and setup can't finish.
  if (state === NO_ACCOUNT) {
    const created = await post(ctx, `${base}/auth/createuser`, { username, password: keccak512Hex(password) });
    if (!created.ok) ctx.fail("Jellystat didn't make the sign-in", [{ label: "Status", value: String(created.status) }]);
    await ctx.emitCheckpoint("account");
  } else {
    await ctx.skipCheckpoint("account", "Jellystat already has a sign-in");
  }

  // Jellystat checks the address and key against Jellyfin from inside its container
  const server = `http://${ctx.host}:${ctx.port}`;
  const saved = await post(ctx, `${base}/auth/configSetup`, { JF_HOST: server, JF_API_KEY: apiKey });
  if (!saved.ok) {
    ctx.fail("Jellystat couldn't reach this Jellyfin server", [
      { label: "Address", value: server },
      { label: "Status", value: String(saved.status) },
    ]);
  }
  if ((await waitForSetupState(ctx, base)) !== SET_UP) ctx.fail("Jellystat saved this Jellyfin server, but its setup didn't finish");
  await ctx.emitCheckpoint("connect");
}
