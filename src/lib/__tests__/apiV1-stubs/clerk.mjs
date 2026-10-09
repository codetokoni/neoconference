// Clerk: who is signed in (globalThis.__who, session globalThis.__sid) and
// each user in globalThis.__users = { [id]: { plan?, role?, emails?, unverified?, first? } }.
// `emails` are verified addresses; `unverified` are on the account but not verified.
export * from "real:clerk";

const users = () => (globalThis.__users ??= {});

function emailList(u) {
  return [
    ...(u.emails ?? []).map((e) => ({ emailAddress: e, verification: { status: "verified" } })),
    ...(u.unverified ?? []).map((e) => ({ emailAddress: e, verification: { status: "unverified" } })),
  ];
}

function toUser(id) {
  const u = users()[id];
  if (!u) return null;
  const list = emailList(u);
  const publicMetadata = { ...(u.metadata ?? {}) };
  if (u.plan) publicMetadata.plan = u.plan;
  if (u.role) publicMetadata.role = u.role;
  return {
    id,
    firstName: u.first ?? null,
    lastName: null,
    username: null,
    imageUrl: "",
    publicMetadata,
    emailAddresses: list,
    primaryEmailAddress: list[0] ?? null,
    createdAt: u.createdAt ?? 0,
  };
}

// clerkMiddleware: runs the app's handler with auth() as above, so a test
// can drive src/middleware.ts. protect() on a signed-out request throws, as
// Clerk's does (Clerk's throw becomes a sign-in redirect).
export function clerkMiddleware(handler) {
  return async (req, ev) => {
    const authFn = Object.assign(async () => auth(), {
      protect: async () => {
        if (!globalThis.__who) throw new Error("clerk: protect() on a signed-out request");
      },
    });
    return handler(authFn, req, ev);
  };
}

// Restrictions (allowlist / blocklist), in globalThis.__clerkLists.
const lists = () => (globalThis.__clerkLists ??= { allow: [], block: [], restrictions: {}, seq: 0 });
const identifierApi = (which) => ({
  async list() {
    return { data: lists()[which].map((x) => ({ ...x })), totalCount: lists()[which].length };
  },
  async create({ identifier }) {
    const item = { id: `${which}_${++lists().seq}`, identifier, identifierType: "email_address", createdAt: Date.now() };
    lists()[which].push(item);
    return item;
  },
  async remove(id) {
    lists()[which] = lists()[which].filter((x) => x.id !== id);
    return { id, deleted: true };
  },
});

export async function auth() {
  const userId = globalThis.__who ?? null;
  return { userId, sessionId: userId ? (globalThis.__sid ?? `sess_${userId}`) : null, sessionClaims: {} };
}

export async function currentUser() {
  return globalThis.__who ? toUser(globalThis.__who) : null;
}

export async function clerkClient() {
  const allow = identifierApi("allow");
  const block = identifierApi("block");
  return {
    allowlistIdentifiers: {
      getAllowlistIdentifierList: allow.list,
      createAllowlistIdentifier: allow.create,
      deleteAllowlistIdentifier: allow.remove,
    },
    blocklistIdentifiers: {
      getBlocklistIdentifierList: block.list,
      createBlocklistIdentifier: block.create,
      deleteBlocklistIdentifier: block.remove,
    },
    instance: {
      async updateRestrictions(params) {
        Object.assign(lists().restrictions, params);
        return { ...lists().restrictions };
      },
    },
    users: {
      async getUser(id) {
        const u = toUser(id);
        if (!u) throw new Error("user not found");
        return u;
      },
      async getUserList(params = {}) {
        let ids = Object.keys(users());
        if (params.emailAddress?.length) {
          const want = params.emailAddress.map((e) => e.toLowerCase());
          ids = ids.filter((id) => emailList(users()[id]).some((e) => want.includes(e.emailAddress.toLowerCase())));
        }
        if (params.query) {
          const q = params.query.toLowerCase();
          ids = ids.filter((id) => JSON.stringify(users()[id]).toLowerCase().includes(q));
        }
        const all = ids.map(toUser);
        const offset = params.offset ?? 0;
        return { data: all.slice(offset, offset + (params.limit ?? 10)), totalCount: all.length };
      },
      async updateUserMetadata(id, { publicMetadata }) {
        const u = users()[id];
        if (!u) throw new Error("user not found");
        const { plan, role, ...rest } = publicMetadata ?? {};
        u.plan = plan;
        u.role = role;
        u.metadata = rest;
        return toUser(id);
      },
    },
  };
}
