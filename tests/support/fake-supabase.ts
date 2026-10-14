// MOCKED VERIFICATION ONLY.
//
// An in-memory stand-in for the slice of Supabase Auth (GoTrue) that the portal uses. It lets the
// tests exercise the portal's own logic — profile mapping, invitation rules, link handling, session
// revocation — without a Supabase project. It is NOT evidence that real Supabase behaves this way;
// the gated live tests (tests/supabase-live.test.ts) are the only thing that can show that.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";

export interface FakeUser {
  id: string;
  email: string;
  password: string;
  confirmed: boolean;
  banned: boolean;
  metadata: Record<string, unknown>;
  signedInAt: Date | null;
}

interface FakeSession {
  id: string;
  userId: string;
  amr: Array<{ method: string; timestamp: number }>;
  iat: number;
}

interface FakeOtp {
  userId: string;
  type: string;
  used: boolean;
}

type AuthError = { code: string; message: string; status: number };
const err = (code: string, message: string, status = 400): AuthError => ({ code, message, status });

async function mirror(sql: string, params: unknown[]) {
  await withSystem((db) => db.query(sql, params));
}

export class FakeSupabaseProject {
  users = new Map<string, FakeUser>();
  sessions = new Map<string, FakeSession>();
  otps = new Map<string, FakeOtp>();
  /** The browser cookie jar: which session the current visitor holds. */
  visitorSession: string | null = null;
  nextUserId: string | null = null;
  /** Records every admin call so tests can assert the secret-key client was (not) used. */
  adminCalls: string[] = [];

  private userByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());
  }

  private newSession(userId: string, method: string): FakeSession {
    const now = Math.floor(Date.now() / 1000);
    const s: FakeSession = { id: crypto.randomUUID(), userId, amr: [{ method, timestamp: now }], iat: now };
    this.sessions.set(s.id, s);
    this.visitorSession = s.id;
    return s;
  }

  private current(): { session: FakeSession; user: FakeUser } | null {
    const s = this.visitorSession ? this.sessions.get(this.visitorSession) : undefined;
    const u = s ? this.users.get(s.userId) : undefined;
    return s && u ? { session: s, user: u } : null;
  }

  /** Simulates someone using the public sign-up endpoint with the publishable key. */
  async publicSignUp(email: string, password: string): Promise<FakeUser> {
    const id = crypto.randomUUID();
    const user: FakeUser = { id, email, password, confirmed: false, banned: false, metadata: {}, signedInAt: null };
    this.users.set(id, user);
    await mirror("insert into auth.users (id, email) values ($1, $2)", [id, email]);
    return user;
  }

  private publicUser(u: FakeUser) {
    return { id: u.id, email: u.email, email_confirmed_at: u.confirmed ? new Date().toISOString() : null };
  }

  private authApi() {
    // SDK-shaped methods bind `this` to their client object; capture the fake project deliberately.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const u = self.userByEmail(email);
        if (!u || u.password !== password) return { data: { user: null, session: null }, error: err("invalid_credentials", "Invalid login credentials") };
        if (u.banned) return { data: { user: null, session: null }, error: err("user_banned", "User is banned", 403) };
        if (!u.confirmed) return { data: { user: null, session: null }, error: err("email_not_confirmed", "Email not confirmed") };
        const s = self.newSession(u.id, "password");
        u.signedInAt = new Date();
        return { data: { user: self.publicUser(u), session: { access_token: `fake.${s.id}` } }, error: null };
      },
      async signOut(opts?: { scope?: "local" | "global" | "others" }) {
        const scope = opts?.scope ?? "global";
        const cur = self.current();
        if (!cur) return { error: null };
        if (scope === "local") {
          self.sessions.delete(cur.session.id);
          self.visitorSession = null;
        } else if (scope === "global") {
          for (const [id, s] of self.sessions) if (s.userId === cur.user.id) self.sessions.delete(id);
          self.visitorSession = null;
        } else {
          for (const [id, s] of self.sessions) if (s.userId === cur.user.id && id !== cur.session.id) self.sessions.delete(id);
        }
        return { error: null };
      },
      async getClaims() {
        const cur = self.current();
        if (!cur || cur.user.banned) return { data: null, error: err("session_not_found", "No session", 401) };
        return {
          data: { claims: { sub: cur.user.id, session_id: cur.session.id, email: cur.user.email, amr: cur.session.amr, iat: cur.session.iat } },
          error: null,
        };
      },
      async getUser() {
        const cur = self.current();
        if (!cur || cur.user.banned) return { data: { user: null }, error: err("session_not_found", "No session", 401) };
        return { data: { user: self.publicUser(cur.user) }, error: null };
      },
      async verifyOtp({ type, token_hash }: { type: string; token_hash: string }) {
        const otp = self.otps.get(token_hash);
        if (!otp || otp.used || otp.type !== type) return { data: { user: null, session: null }, error: err("otp_expired", "Token has expired or is invalid") };
        otp.used = true;
        const u = self.users.get(otp.userId)!;
        if (!u.confirmed) {
          u.confirmed = true;
          await mirror("update auth.users set email_confirmed_at = now() where id = $1", [u.id]);
        }
        const s = self.newSession(u.id, "otp");
        return { data: { user: self.publicUser(u), session: { access_token: `fake.${s.id}` } }, error: null };
      },
      admin: {
        async createUser(attrs: { id?: string; email: string; password?: string; email_confirm?: boolean; user_metadata?: Record<string, unknown> }) {
          self.adminCalls.push("createUser");
          if (self.userByEmail(attrs.email)) return { data: { user: null }, error: err("email_exists", "A user with this email address has already been registered", 422) };
          if ((attrs.password ?? "").length < 6) return { data: { user: null }, error: err("weak_password", "Password should be at least 6 characters", 422) };
          const id = attrs.id ?? self.nextUserId ?? crypto.randomUUID();
          self.nextUserId = null;
          const user: FakeUser = {
            id,
            email: attrs.email,
            password: attrs.password ?? "",
            confirmed: Boolean(attrs.email_confirm),
            banned: false,
            metadata: attrs.user_metadata ?? {},
            signedInAt: null,
          };
          self.users.set(id, user);
          await mirror("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, case when $3 then now() end)", [id, attrs.email, user.confirmed]);
          return { data: { user: self.publicUser(user) }, error: null };
        },
        async deleteUser(id: string) {
          self.adminCalls.push("deleteUser");
          self.users.delete(id);
          for (const [sid, s] of self.sessions) if (s.userId === id) self.sessions.delete(sid);
          await mirror("delete from auth.users where id = $1", [id]);
          return { data: { user: null }, error: null };
        },
        async updateUserById(id: string, attrs: { password?: string; ban_duration?: string }) {
          self.adminCalls.push("updateUserById");
          const u = self.users.get(id);
          if (!u) return { data: { user: null }, error: err("user_not_found", "User not found", 404) };
          if (attrs.password !== undefined) {
            if (attrs.password.length < 6) return { data: { user: null }, error: err("weak_password", "Weak password", 422) };
            u.password = attrs.password;
          }
          if (attrs.ban_duration !== undefined) u.banned = attrs.ban_duration !== "none";
          return { data: { user: self.publicUser(u) }, error: null };
        },
        async generateLink({ type, email }: { type: string; email: string }) {
          self.adminCalls.push("generateLink");
          const u = self.userByEmail(email);
          if (!u) return { data: { properties: null }, error: err("user_not_found", "User not found", 404) };
          const hashed = crypto.randomBytes(24).toString("hex");
          self.otps.set(hashed, { userId: u.id, type, used: false });
          return { data: { properties: { hashed_token: hashed, verification_type: type } }, error: null };
        },
      },
    };
  }

  /** What createSupabaseServerClient() returns: shares the visitor's cookie jar. */
  serverClient() {
    return { auth: this.authApi() };
  }

  /** What createSupabaseAdminClient() returns (the secret-key client). */
  adminClient() {
    return { auth: this.authApi() };
  }

  /** What createSupabaseStatelessClient() returns: its own throwaway session, not the visitor's. */
  statelessClient() {
    // The probe owns a separate session while its methods still update this project's fixtures.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const outer = this;
    const api = this.authApi();
    return {
      auth: {
        async signInWithPassword(creds: { email: string; password: string }) {
          const keep = outer.visitorSession;
          const res = await api.signInWithPassword(creds);
          const probeSession = outer.visitorSession;
          outer.visitorSession = keep;
          probeSessionId = probeSession;
          return res;
        },
        async signOut() {
          if (probeSessionId) outer.sessions.delete(probeSessionId);
          return { error: null };
        },
      },
    };
    // eslint-disable-next-line no-var
    var probeSessionId: string | null = null;
  }
}
