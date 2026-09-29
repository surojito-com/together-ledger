// What the API's request log may carry. Fastify logs every request's address, so a one-time code
// in an address would otherwise be written in full. PRIVACY.md and docs/OPERATIONS.md both promise
// that logs never hold raw link tokens; this is what keeps that true (issue #208).

// The accept route used to carry the invitation token in the path. Clients now send it in the body
// (POST /api/v1/invitations/accept), but the old route stays for clients that haven't updated, so
// its token segment is masked rather than logged.
const TOKEN_PATH = /^(\/api\/v1\/invitations\/)[^/?#]+(\/accept)(?=$|[?#])/;
// The link parameters the web client reads. They land on the static site, not here, but if one
// ever reaches an API address its value is still never logged.
const TOKEN_QUERY = /([?&](?:token|verify|recovery|invite)=)[^&#]*/gi;

export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(TOKEN_PATH, '$1[redacted]$2').replace(TOKEN_QUERY, '$1[redacted]');
}

export const loggerOptions = {
  redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers.stripe-signature', 'req.body.password', 'req.body.token', 'req.body.refreshToken'],
  serializers: {
    // Fastify's own request serializer, with the address passed through redactUrl.
    req(request) {
      return {
        method: request.method,
        url: redactUrl(request.url),
        version: request.headers?.['accept-version'],
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket ? request.socket.remotePort : undefined,
      };
    },
  },
};
