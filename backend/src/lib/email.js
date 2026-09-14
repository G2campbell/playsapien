/* Transactional mail, via Resend.

   One template, one send. The whole auth design (spec §1) rests on this mail
   arriving, so it is worth being careful about the parts that decide whether it
   does: a plain-text alternative, no images, no tracking pixel, a subject line
   that carries the code, and a body short enough that a filter has nothing to
   object to.

   The send is injected as `fetchImpl` rather than calling global fetch, so the
   tests can assert what would have been sent without a network or an API key.
   Everything in this file is pure apart from that one call. */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/* The code goes in the subject too. Most mail clients show enough of it in the
   notification that a player can read the code without opening anything, which
   removes the whole app-switching dance from the common case. */
export function codeSubject(code) {
  return code + ' is your PlaySapien sign-in code';
}

export function codeText({ code, link, ttlMinutes }) {
  return [
    'Your PlaySapien sign-in code is:',
    '',
    '    ' + code.slice(0, 3) + ' ' + code.slice(3),
    '',
    'Type it into the tab you already have open. It expires in ' + ttlMinutes +
      ' minutes and works once.',
    '',
    'On a computer you can use this link instead:',
    link,
    '',
    'If you did not ask to sign in, nothing has happened and you can ignore this.',
    'Someone typed your address into a sign-in form, which is all it takes to',
    'send this mail -- it does not mean anyone has access to anything.',
    '',
    'PlaySapien',
  ].join('\n');
}

/* Inline styles only: every mail client that matters strips <style> blocks, and
   a table layout is the one thing that renders the same in Outlook and Gmail.
   The code is rendered as text, not an image, so it can be copied. */
export function codeHtml({ code, link, ttlMinutes }) {
  const spaced = escapeHtml(code.slice(0, 3) + ' ' + code.slice(3));
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F6F1E7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#F6F1E7;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="max-width:440px;background:#FFFFFF;border-radius:14px;padding:32px;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
              color:#1F1A14;">
  <tr><td style="font-size:15px;line-height:1.5;padding-bottom:20px;">
    Your PlaySapien sign-in code:
  </td></tr>
  <tr><td align="center" style="padding-bottom:20px;">
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
                font-size:34px;letter-spacing:6px;font-weight:700;color:#1F1A14;">${spaced}</div>
  </td></tr>
  <tr><td style="font-size:14px;line-height:1.5;color:#5A5147;padding-bottom:20px;">
    Type it into the tab you already have open. It expires in ${ttlMinutes} minutes
    and works once.
  </td></tr>
  <tr><td align="center" style="padding-bottom:24px;">
    <a href="${escapeHtml(link)}"
       style="display:inline-block;background:#1F1A14;color:#F6F1E7;text-decoration:none;
              font-size:15px;padding:12px 22px;border-radius:9px;">Or sign in here</a>
  </td></tr>
  <tr><td style="font-size:13px;line-height:1.5;color:#8A8075;border-top:1px solid #E8E0D2;padding-top:18px;">
    If you did not ask to sign in, nothing has happened and you can ignore this.
    Someone typed your address into a sign-in form, which is all it takes to send
    this mail -- it does not mean anyone has access to anything.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Build the sign-in link. The link carries the same six digits as the code --
   one credential, one row in login_codes, one set of attempt counters. Sending
   a second, longer token so the link could be "more convenient" would mean two
   things to expire, two things to burn and two ways to get it wrong, for a path
   that already has a working alternative on the same screen. */
export function signinLink(appOrigin, email, code) {
  const u = new URL('/signin', appOrigin);
  u.searchParams.set('email', email);
  u.searchParams.set('code', code);
  return u.toString();
}

/* Send, or pretend to.

   A mail failure must not fail /auth/email/start -- the response is always
   { sent: true } regardless (spec §5, email enumeration), so a thrown error
   here would be both a leak and a lie. The caller logs and carries on; this
   returns a result object instead of throwing for anything the provider says. */
export async function sendLoginCode({
  to, code, link, ttlMinutes = 10, apiKey, from, fetchImpl = fetch,
}) {
  if (!apiKey) {
    /* No key configured: local development, or a deploy where the secret has
       not been set yet. Log the code so `wrangler dev` is usable offline, and
       say plainly that nothing was sent. */
    console.log('[email] RESEND_API_KEY unset; sign-in code for ' + to + ' is ' + code);
    return { sent: false, reason: 'no_api_key' };
  }

  const res = await fetchImpl(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: codeSubject(code),
      text: codeText({ code, link, ttlMinutes }),
      html: codeHtml({ code, link, ttlMinutes }),
      /* Tells a well-behaved auto-responder not to reply, and marks the message
         as transactional for bulk-mail heuristics. */
      headers: { 'X-Entity-Ref-ID': 'playsapien-signin' },
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* body already consumed */ }
    console.error('[email] resend rejected the send: ' + res.status + ' ' + detail);
    return { sent: false, reason: 'provider_error', status: res.status };
  }
  return { sent: true };
}
