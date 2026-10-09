// Clerk: who is signed in (globalThis.__who, session globalThis.__sid) and
// each user in globalThis.__users = { [id]: { plan?, role?, emails?, unverified?, first?, createdAt? } }.
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
    createdAt: u.createdAt ?? 0,
    emailAddresses: list,
    primaryEmailAddress: list[0] ?? null,
  };
}

export async function auth() {
  const userId = globalThis.__who ?? null;
  return { userId, sessionId: userId ? (globalThis.__sid ?? `sess_${userId}`) : null, sessionClaims: {} };
}

export async function currentUser() {
  return globalThis.__who ? toUser(globalThis.__who) : null;
}

export async function clerkClient() {
  return {
    users: {
      async getUser(id) {
        const u = toUser(id);
        if (!u) throw new Error("user not found");
        return u;
      },
      async getUserList(params = {}) {
        if (globalThis.__clerkListFails) throw new Error("clerk: unavailable (test)");
        let ids = Object.keys(users());
        if (params.userId?.length) ids = ids.filter((id) => params.userId.includes(id));
        if (params.emailAddress?.length) {
          const want = params.emailAddress.map((e) => e.toLowerCase());
          ids = ids.filter((id) => emailList(users()[id]).some((e) => want.includes(e.emailAddress.toLowerCase())));
        }
        if (params.query) {
          const q = params.query.toLowerCase();
          ids = ids.filter((id) => JSON.stringify(users()[id]).toLowerCase().includes(q));
        }
        const all = ids.map(toUser);
        if (params.orderBy === "-created_at") all.sort((a, b) => b.createdAt - a.createdAt);
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
