// The two files that let a tapped invitation open the phone app (#266): Apple's
// apple-app-site-association and Android's assetlinks.json, both under /.well-known/. Both fail
// silently when wrong (the link just opens the browser), so what they must say is checked here,
// by the build, by the release gate and by tests/app-links.test.js.
//
// Only an invitation's own path is claimed. Verification and recovery links stay on the web.

export const APPLE_APP_ID = '769MBW6826.com.togetherledger.ledger';
export const ANDROID_PACKAGE = 'com.togetherledger.ledger';
export const INVITATION_PATH = '/invite';
export const APP_SITE_ASSOCIATION = '.well-known/apple-app-site-association';
export const ASSET_LINKS = '.well-known/assetlinks.json';

// A certificate's SHA-256, as the Play Console shows it: 32 bytes, upper-case hex, colon-separated.
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** What is wrong with an apple-app-site-association, or nothing. */
export function appSiteAssociationProblems(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ['apple-app-site-association is not JSON'];
  }
  const details = parsed?.applinks?.details;
  if (!Array.isArray(details) || details.length !== 1) return ['apple-app-site-association must hold exactly one applinks entry'];
  const [entry] = details;
  const problems = [];
  if (JSON.stringify(entry.appIDs) !== JSON.stringify([APPLE_APP_ID])) problems.push(`apple-app-site-association must name only ${APPLE_APP_ID}`);
  if (entry.paths !== undefined) problems.push('apple-app-site-association must claim by components, not paths');
  const components = Array.isArray(entry.components) ? entry.components : [];
  if (components.length !== 1 || components[0]['/'] !== INVITATION_PATH || Object.keys(components[0]).some((key) => !['/', 'comment'].includes(key))) {
    problems.push(`apple-app-site-association must claim ${INVITATION_PATH} and nothing else`);
  }
  if (Object.keys(parsed).some((key) => key !== 'applinks')) problems.push('apple-app-site-association must carry applinks only');
  return problems;
}

/** What is wrong with an assetlinks.json, or nothing. Placeholders and an empty list are wrong. */
export function assetLinksProblems(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ['assetlinks.json is not JSON'];
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return ['assetlinks.json must hold exactly one statement'];
  const [statement] = parsed;
  const problems = [];
  if (JSON.stringify(statement.relation) !== JSON.stringify(['delegate_permission/common.handle_all_urls'])) problems.push('assetlinks.json must grant handle_all_urls only');
  if (statement.target?.namespace !== 'android_app' || statement.target?.package_name !== ANDROID_PACKAGE) problems.push(`assetlinks.json must name ${ANDROID_PACKAGE}`);
  const fingerprints = statement.target?.sha256_cert_fingerprints;
  if (!Array.isArray(fingerprints) || !fingerprints.length) problems.push('assetlinks.json has no certificate fingerprint');
  else if (fingerprints.some((value) => !FINGERPRINT.test(value))) problems.push('assetlinks.json still holds a placeholder, or a fingerprint that is not a SHA-256 in AA:BB:… form');
  return problems;
}
