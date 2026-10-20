<?php
// examples/prayerclouds/session.php — the same session endpoint as
// server.mjs, for a PHP site. Route POST /api/prayer-meeting/session to it.
//
// Environment (never in a web page): NLM_PARTNER_KEY, SITE_ORIGIN
// (this site's origin, approved in NeoLinguaMeet's admin), optionally
// NLM_ORIGIN and ALLOW_GUESTS=1.
//
// Replace current_user() with your own login check. Answers { code } for
// the widget, or { error: { code, message } }.

declare(strict_types=1);

header('Content-Type: application/json');
header('Cache-Control: no-store');

function answer(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body);
    exit;
}

/** The signed-in user as ['id' => ..., 'name' => ...], or null. REPLACE with your session lookup. */
function current_user(): ?array
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_start();
    }
    $u = $_SESSION['user'] ?? null;
    return is_array($u) && isset($u['id'], $u['name']) ? ['id' => (string) $u['id'], 'name' => (string) $u['name']] : null;
}

$key = getenv('NLM_PARTNER_KEY') ?: '';
$nlm = rtrim(getenv('NLM_ORIGIN') ?: 'https://neolinguameet.com', '/');
$site = rtrim(getenv('SITE_ORIGIN') ?: '', '/');
$guests = getenv('ALLOW_GUESTS') === '1';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') answer(405, ['error' => ['code' => 'method', 'message' => 'POST only.']]);
if ($key === '' || $site === '') answer(500, ['error' => ['code' => 'not_configured', 'message' => 'The meeting is not set up yet.']]);
$from = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($from !== '' && $from !== $site) answer(403, ['error' => ['code' => 'forbidden', 'message' => 'Not from this site.']]);

$zone = (string) ($_GET['zone'] ?? '');
if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/', $zone)) answer(400, ['error' => ['code' => 'invalid_zone', 'message' => 'Unknown zone.']]);

$user = current_user();
if ($user) {
    $who = ['id' => $user['id'], 'displayName' => mb_substr($user['name'], 0, 60)];
} elseif ($guests) {
    $body = json_decode(file_get_contents('php://input') ?: '{}', true);
    $name = is_array($body) && is_string($body['displayName'] ?? null) ? trim($body['displayName']) : '';
    if ($name === '') answer(401, ['error' => ['code' => 'name_required', 'message' => 'Enter your name to join.']]);
    $who = ['guest' => true, 'displayName' => mb_substr($name, 0, 60)];
} else {
    answer(401, ['error' => ['code' => 'sign_in_required', 'message' => 'Sign in to join the prayer meeting.']]);
}

$ch = curl_init("$nlm/api/partner/v1/join-sessions");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', "Authorization: Bearer $key"],
    CURLOPT_POSTFIELDS => json_encode(['zoneId' => $zone, 'origin' => $site, 'user' => $who]),
]);
$raw = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($raw === false) answer(502, ['error' => ['code' => 'unreachable', 'message' => 'The meeting service is not reachable. Try again.']]);
$data = json_decode($raw, true) ?: [];
if ($status !== 201) {
    error_log('[prayer-meeting] join-sessions ' . $status . ' ' . ($data['error']['code'] ?? ''));
    answer($status === 401 ? 502 : $status, ['error' => $data['error'] ?? ['code' => 'failed', 'message' => 'Could not start the meeting.']]);
}
answer(200, ['code' => $data['code'], 'expiresAt' => $data['expiresAt'], 'title' => $data['meeting']['title'] ?? null]);
