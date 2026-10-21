<?php
// examples/prayerclouds/reports.php — the prayer report proxy of server.mjs,
// for a PHP site. Route GET /api/prayer-meeting/reports/{view} to it with
// ?view=me|zone|participants|session|export|public (plus zone, period,
// from, to, page, pageSize, session). prayer-reports.js calls it.
//
// The viewer is always YOUR signed-in user (current_user() in
// session.php), never anything the browser sends. NeoLinguaMeet decides
// what that person may see.

declare(strict_types=1);

/** The signed-in user as ['id' => ..., 'name' => ...], or null. REPLACE with your session lookup (as in session.php). */
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

function fail(int $status, string $code, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(['error' => ['code' => $code, 'message' => $message]]);
    exit;
}

$view = (string) ($_GET['view'] ?? '');
$zone = (string) ($_GET['zone'] ?? '');
if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/', $zone)) fail(400, 'invalid_zone', 'Unknown zone.');
$z = rawurlencode($zone);
$paths = [
    'me' => "/api/partner/v1/attendance/me?zoneId=$z",
    'zone' => "/api/partner/v1/reports/zones/$z",
    'participants' => "/api/partner/v1/reports/zones/$z/participants",
    'export' => "/api/partner/v1/reports/zones/$z/export",
    'public' => "/api/partner/v1/zones/$z/public-stats",
];
if ($view === 'session') {
    $sid = (string) ($_GET['session'] ?? '');
    if (!preg_match('/^ps_[a-f0-9]{16}$/', $sid)) fail(400, 'invalid_session', 'Unknown session.');
    $path = "/api/partner/v1/reports/zones/$z/sessions/$sid";
} elseif (isset($paths[$view])) {
    $path = $paths[$view];
} else {
    fail(404, 'not_found', 'No such report.');
}

$user = current_user();
if ($view !== 'public' && !$user) fail(401, 'sign_in_required', 'Sign in to see prayer reports.');

$q = [];
foreach (['period', 'from', 'to', 'page', 'pageSize'] as $k) {
    if (isset($_GET[$k]) && $_GET[$k] !== '') $q[$k] = (string) $_GET[$k];
}
$url = $nlm . $path . (str_contains($path, '?') ? '&' : '?') . http_build_query($q);
$headers = ["Authorization: Bearer $key"];
if ($view !== 'public') $headers[] = 'X-Viewer-Id: ' . $user['id'];
if (!empty($_SERVER['HTTP_IF_NONE_MATCH'])) $headers[] = 'If-None-Match: ' . $_SERVER['HTTP_IF_NONE_MATCH'];

$passed = [];
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$passed) {
        if (preg_match('/^(etag|content-type|content-disposition):/i', $line)) $passed[] = trim($line);
        return strlen($line);
    },
]);
$body = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if ($body === false) fail(502, 'unreachable', 'The meeting service is not reachable.');

http_response_code($status === 401 ? 502 : $status);
header('Cache-Control: private, no-cache');
foreach ($passed as $h) header($h);
if ($status !== 304) echo $body;
