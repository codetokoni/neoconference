// Clerk: who is signed in (globalThis.__who, session globalThis.__sid) and
// each user in globalThis.__users = { [id]: { plan?, role?, emails?, unverified?, first?, last?,
// banned?, createdAt?, lastSignInAt?, password?, primary?, metadata?, locked? } }.
// `emails` are verified addresses; `unverified` are on the account but not verified.
// Clerk sessions in globalThis.__clerkSessions = { [userId]: [{ id, status }] }.
export * from "real:clerk";

const users = () => (globalThis.__users ??= {});
const sessions = () => (globalThis.__clerkSessions ??= {});
const emailId = (uid, address) => `idn_${uid}_${address}`;

function emailList(u, uid = "") {
  return [
    ...(u.emails ?? []).map((e) => ({ id: emailId(uid, e), emailAddress: e, verification: { status: "verified" } })),
    ...(u.unverified ?? []).map((e) => ({ id: emailId(uid, e), emailAddress: e, verification: { status: "unverified" } })),
  ];
}

function toUser(id) {
  const u = users()[id];
  if (!u) return null;
  const list = emailList(u, id);
  const primary = list.find((e) => e.emailAddress === u.primary) ?? list[0] ?? null;
  const publicMetadata = { ...(u.metadata ?? {}) };
  if (u.plan) publicMetadata.plan = u.plan;
  if (u.role) publicMetadata.role = u.role;
  return {
    id,
    firstName: u.first ?? null,
    lastName: u.last ?? null,
    username: null,
    imageUrl: "",
    publicMetadata,
    createdAt: u.createdAt ?? 0,
    emailAddresses: list,
    primaryEmailAddress: primary,
    primaryEmailAddressId: primary?.id ?? null,
    banned: !!u.banned,
    locked: !!u.locked,
    createdAt: u.createdAt ?? 1_700_000_000_000,
    lastSignInAt: u.lastSignInAt ?? null,
    lastActiveAt: u.lastSignInAt ?? null,
    passwordEnabled: u.password !== false,
    twoFactorEnabled: false,
    passwordCompromised: !!u.passwordCompromised,
  };
}

function notFound() {
  return Object.assign(new Error("user not found"), { status: 404 });
}

function revokeAll(userId) {
  for (const s of sessions()[userId] ?? []) s.status = "revoked";
}

export async function auth() {
  const userId = globalThis.__who ?? null;
  return { userId, sessionId: userId ? (globalThis.__sid ?? `sess_${userId}`) : null, sessionClaims: {} };
}

export async function currentUser() {
  return globalThis.__who ? toUser(globalThis.__who) : null;
}

const SORT_FIELD = { created_at: "createdAt", last_sign_in_at: "lastSignInAt", last_active_at: "lastActiveAt", email_address: "email", first_name: "firstName" };

export async function clerkClient() {
  return {
    users: {
      // globalThis.__clerkCountFails makes it throw, as Clerk does when it is down.
      async getCount() {
        if (globalThis.__clerkCountFails) throw Object.assign(new Error("Clerk API unavailable"), { status: 503 });
        return Object.keys(users()).length;
      },
      async getUser(id) {
        const u = toUser(id);
        if (!u) throw notFound();
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
          ids = ids.filter((id) => (id + JSON.stringify(users()[id])).toLowerCase().includes(q));
        }
        let all = ids.map(toUser);
        if (params.orderBy) {
          const desc = params.orderBy.startsWith("-");
          const f = SORT_FIELD[params.orderBy.replace(/^[-+]/, "")];
          const val = (u) => (f === "email" ? u.primaryEmailAddress?.emailAddress ?? "" : u[f] ?? 0);
          all = all.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (desc ? -1 : 1));
        }
        const offset = params.offset ?? 0;
        return { data: all.slice(offset, offset + (params.limit ?? 10)), totalCount: all.length };
      },
      async updateUserMetadata(id, { publicMetadata }) {
        const u = users()[id];
        if (!u) throw notFound();
        const { plan, role, ...rest } = publicMetadata ?? {};
        u.plan = plan;
        u.role = role;
        u.metadata = rest;
        return toUser(id);
      },
      async updateUser(id, params = {}) {
        const u = users()[id];
        if (!u) throw notFound();
        if (params.firstName !== undefined) u.first = params.firstName || null;
        if (params.lastName !== undefined) u.last = params.lastName || null;
        return toUser(id);
      },
      async banUser(id) {
        const u = users()[id];
        if (!u) throw notFound();
        u.banned = true;
        revokeAll(id);
        return toUser(id);
      },
      async unbanUser(id) {
        const u = users()[id];
        if (!u) throw notFound();
        u.banned = false;
        return toUser(id);
      },
      async deleteUser(id) {
        if (!users()[id]) throw notFound();
        delete users()[id];
        revokeAll(id);
        return { id, deleted: true };
      },
      async setPasswordCompromised(id, params = {}) {
        const u = users()[id];
        if (!u) throw notFound();
        u.passwordCompromised = true;
        if (params.revokeAllSessions) revokeAll(id);
        return toUser(id);
      },
      async unsetPasswordCompromised(id) {
        const u = users()[id];
        if (!u) throw notFound();
        u.passwordCompromised = false;
        return toUser(id);
      },
    },
    emailAddresses: {
      async updateEmailAddress(emailAddressId, { verified } = {}) {
        for (const [uid, u] of Object.entries(users())) {
          const e = emailList(u, uid).find((x) => x.id === emailAddressId);
          if (!e) continue;
          const address = e.emailAddress;
          u.primary ??= emailList(u, uid)[0]?.emailAddress;
          u.emails = (u.emails ?? []).filter((x) => x !== address);
          u.unverified = (u.unverified ?? []).filter((x) => x !== address);
          (verified ? u.emails : u.unverified).push(address);
          return { id: emailAddressId, emailAddress: address, verification: { status: verified ? "verified" : "unverified" } };
        }
        throw Object.assign(new Error("email not found"), { status: 404 });
      },
    },
    sessions: {
      async getSessionList({ userId, status } = {}) {
        const list = (sessions()[userId] ?? []).filter((s) => !status || s.status === status);
        return {
          data: list.map((s) => ({ id: s.id, userId, status: s.status, createdAt: 1, lastActiveAt: 2, expireAt: 3, actor: null, latestActivity: null })),
          totalCount: list.length,
        };
      },
      async revokeSession(id) {
        for (const list of Object.values(sessions())) for (const s of list) if (s.id === id) s.status = "revoked";
        return { id, status: "revoked" };
      },
    },
  };
}
