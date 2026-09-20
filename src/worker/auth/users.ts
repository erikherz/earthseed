// Accounts: the row, the upsert, and the two questions the Worker asks about a signed-in person.
//
// Ported from Wallflower, narrowed to one provider. Wallflower's upsert took a `provider` and
// interpolated `${provider}_id` into the column name, which was groundwork for Microsoft and
// Discord sign-in that never arrived. Earthseed's users table has a `google_id` column and no
// others (migration 0012), so the generic form would be a string-interpolated column name that
// can only ever hold one value — the shape of an SQL injection with none of the benefits of
// being general. It is written out instead.
//
// The two questions, deliberately separate:
//
//   currentUser()  — who is this?          Answered by a signed cookie.
//   canBroadcast() — may they publish?     Answered by the allow list, default-DENY.
//
// Keeping them apart is what makes "signed in" necessary and not sufficient. Wallflower shipped
// an auth check twice in a form that could not fail, both times by letting one of these answer
// for the other.

import { getSessionFromCookie, verifySessionToken } from "./session";

export interface User {
  id: number;
  google_id: string | null;
  email: string;
  name: string;
  avatar_url: string;
  created_at: string;
  updated_at: string;
}

export interface GoogleUserInput {
  provider_id: string;
  email: string;
  name: string;
  avatar_url: string;
}

/**
 * Find or create the row for a Google account.
 *
 * Three cases, in order. The middle one is the one worth knowing about: a row may already exist
 * for this EMAIL with no google_id — because an operator added it to the allow list, or because
 * a future provider got there first — and in that case the Google identity is linked onto the
 * existing account rather than creating a second one. Two rows for one person would mean their
 * allow-list entry silently stopped applying to them.
 */
export async function upsertGoogleUser(db: D1Database, input: GoogleUserInput): Promise<User> {
  const byProvider = await db
    .prepare("SELECT * FROM users WHERE google_id = ?")
    .bind(input.provider_id)
    .first<User>();

  if (byProvider) {
    await db
      .prepare(
        `UPDATE users SET email = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
          WHERE id = ?`
      )
      .bind(input.email, input.name, input.avatar_url, byProvider.id)
      .run();
    return { ...byProvider, email: input.email, name: input.name, avatar_url: input.avatar_url };
  }

  const byEmail = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(input.email)
    .first<User>();

  if (byEmail) {
    await db
      .prepare(
        `UPDATE users SET google_id = ?, name = ?, avatar_url = ?, updated_at = datetime('now')
          WHERE id = ?`
      )
      .bind(input.provider_id, input.name, input.avatar_url, byEmail.id)
      .run();
    return {
      ...byEmail,
      google_id: input.provider_id,
      name: input.name,
      avatar_url: input.avatar_url,
    };
  }

  const created = await db
    .prepare(
      `INSERT INTO users (google_id, email, name, avatar_url) VALUES (?, ?, ?, ?) RETURNING *`
    )
    .bind(input.provider_id, input.email, input.name, input.avatar_url)
    .first<User>();

  return created!;
}

export const getUserById = (db: D1Database, id: number): Promise<User | null> =>
  db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();

/**
 * Who is making this request, or null.
 *
 * Null for every reason: no cookie, a cookie that does not verify, an expired one, a valid one
 * naming a user that has since been deleted. Callers must treat all of those identically, which
 * they will if they only ever check for null.
 *
 * Returns null rather than throwing when SESSION_SECRET is unset. That is the fail-closed
 * direction: with no secret configured there are no valid sessions, so nobody is signed in, and
 * the account path is simply absent rather than open.
 */
export async function currentUser(request: Request, env: { DB: D1Database; SESSION_SECRET?: string }): Promise<User | null> {
  if (!env.SESSION_SECRET) return null;

  const token = getSessionFromCookie(request.headers.get("Cookie"));
  if (!token) return null;

  const session = await verifySessionToken(token, env.SESSION_SECRET);
  if (!session) return null;

  return getUserById(env.DB, session.userId);
}

/**
 * The broadcaster allow list. DEFAULT-DENY: no row, or any status other than 'allowed', is a no.
 *
 * Written as an equality against 'allowed' rather than a check for absence or for 'suspended',
 * so that a status nobody has thought of yet — a typo, a future 'pending' — denies. A gate whose
 * failure mode is "admit" is not a gate, and this one has been written the wrong way round
 * before.
 */
export async function canBroadcast(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM broadcaster_access WHERE email = ?")
    .bind(email)
    .first<{ status: string }>();
  return row?.status === "allowed";
}
