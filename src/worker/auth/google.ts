// Google OAuth 2.0, the three calls it actually takes.
//
// Ported from Wallflower. Nothing here is Earthseed-specific and nothing here touches media — it
// answers "which Google account is this" and hands the answer to the caller, which then decides
// whether that account may publish (see users.ts and the broadcaster allow list).
//
// Scope is `openid email profile` and nothing more. We ask for no Drive, no contacts, no calendar,
// and `access_type: online` means we never receive a refresh token — so there is no long-lived
// credential for this service to hold, or to lose. The access token is used once, immediately, to
// read the profile, and is then discarded rather than stored.

export interface GoogleTokens {
  access_token: string;
  id_token: string;
  expires_in: number;
  token_type: string;
}

export interface GoogleUser {
  id: string;
  email: string;
  name: string;
  picture: string;
}

/**
 * The URL to send the browser to.
 *
 * `prompt: select_account` is deliberate: without it, a person already signed into one Google
 * account is silently bounced straight back as that account, which is the wrong default for a
 * machine that might be shared.
 */
export function getGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<GoogleTokens> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    // The body is Google's error JSON, not ours, and it names the misconfiguration (a redirect
    // URI that does not match, usually). Worth carrying into the log; never worth returning to
    // the browser, which is why the caller turns this into a generic redirect.
    throw new Error(`Token exchange failed: ${response.status} — ${await response.text()}`);
  }

  return response.json();
}

export async function getGoogleUserInfo(accessToken: string): Promise<GoogleUser> {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Failed to fetch user info: ${response.status}`);
  return response.json();
}
