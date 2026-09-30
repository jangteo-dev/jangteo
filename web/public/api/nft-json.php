<?php
// 인사동 Insadong: stores a collection's page details or a mint allowlist as a small JSON file,
// named by the SHA-256 of its content. A name can never point at different content, and the
// web app checks every allowlist against the Merkle root written on-chain before using it.
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function fail(int $code, string $msg): never {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function https_url(mixed $v): ?string {
    if (!is_string($v) || $v === '' || strlen($v) > 512) return null;
    return preg_match('#^https://[^\s"<>\\\\]+$#', $v) ? $v : null;
}

function text(mixed $v, int $max): string {
    if (!is_string($v)) return '';
    $v = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $v) ?? '');
    return mb_substr($v, 0, $max);
}

// The server hosts other sites too: uploads stop before they could fill its disk.
function storage_guard(): void {
    $dir = '/srv/jangteo/uploads';
    if (@disk_free_space('/') < 15 * 1024 ** 3) fail(507, 'Uploads are paused for now. Try again later.');
    $cache = sys_get_temp_dir() . '/jangteo-uploads-size';
    $size = is_file($cache) && time() - filemtime($cache) < 300 ? (int) file_get_contents($cache) : null;
    if ($size === null) {
        $size = 0;
        foreach (new FilesystemIterator($dir) as $f) $size += $f->getSize();
        file_put_contents($cache, (string) $size, LOCK_EX);
    }
    if ($size > 20 * 1024 ** 3) fail(507, 'Uploads are paused for now. Try again later.');
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'POST required');
storage_guard();
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = $_SERVER['HTTP_HOST'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== $host) fail(403, 'Cross-site upload refused');

$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rate = sys_get_temp_dir() . '/jangteo-json-' . hash('sha256', $ip) . '.json';
$now = time();
$hits = is_file($rate) ? json_decode((string) file_get_contents($rate), true) : [];
$hits = array_values(array_filter(is_array($hits) ? $hits : [], fn($t) => is_int($t) && $t > $now - 3600));
if (count($hits) >= 30) fail(429, 'Hourly limit reached. Try again later.');
$hits[] = $now;
file_put_contents($rate, json_encode($hits), LOCK_EX);

$raw = file_get_contents('php://input', false, null, 0, 1_000_001);
if (!is_string($raw) || strlen($raw) > 1_000_000) fail(413, 'Up to 1 MB');
$in = json_decode($raw, true);
if (!is_array($in)) fail(400, 'Not JSON');

if (($in['kind'] ?? '') === 'allowlist') {
    $list = $in['addresses'] ?? null;
    if (!is_array($list) || count($list) === 0 || count($list) > 20000) fail(422, 'Between 1 and 20,000 addresses');
    $out = [];
    foreach ($list as $a) {
        if (!is_string($a) || !preg_match('/^0x[0-9a-fA-F]{40}$/', $a)) fail(422, 'Not an address: ' . substr((string) (is_string($a) ? $a : ''), 0, 60));
        $out[strtolower($a)] = true;
    }
    $keys = array_keys($out);
    sort($keys);
    $doc = ['kind' => 'allowlist', 'addresses' => $keys];
} elseif (($in['kind'] ?? '') === 'collection') {
    $links = is_array($in['links'] ?? null) ? $in['links'] : [];
    $lists = [];
    foreach (is_array($in['lists'] ?? null) ? $in['lists'] : [] as $k => $u) {
        if (preg_match('/^[0-4]$/', (string) $k) && is_string($u) && preg_match('#^/uploads/[0-9a-f]{64}\.json$#', $u)) $lists[(string) $k] = $u;
    }
    $phaseNames = [];
    foreach (is_array($in['phaseNames'] ?? null) ? $in['phaseNames'] : [] as $k => $n) {
        if (preg_match('/^[0-4]$/', (string) $k)) $phaseNames[(string) $k] = text($n, 32);
    }
    $doc = array_filter([
        'kind' => 'collection',
        'description' => text($in['description'] ?? '', 2000),
        'image' => https_url($in['image'] ?? null),
        'banner' => https_url($in['banner'] ?? null),
        'links' => array_filter(['site' => https_url($links['site'] ?? null), 'x' => https_url($links['x'] ?? null), 'discord' => https_url($links['discord'] ?? null), 'telegram' => https_url($links['telegram'] ?? null)]),
        'lists' => $lists,
        'phaseNames' => array_filter($phaseNames),
    ], fn($v) => $v !== null && $v !== '' && $v !== []);
} elseif (($in['kind'] ?? '') === 'manifest') {
    // One artwork per token, in token order: served as /nft/<sha>/<id>.json by nft-meta.php.
    $images = $in['images'] ?? null;
    if (!is_array($images) || count($images) === 0 || count($images) > 10000) fail(422, 'Between 1 and 10,000 images');
    $clean = [];
    foreach ($images as $u) {
        $v = https_url($u);
        if ($v === null) fail(422, 'Every image must be an https link');
        $clean[] = $v;
    }
    $doc = array_filter([
        'kind' => 'manifest',
        'name' => text($in['name'] ?? '', 64),
        'description' => text($in['description'] ?? '', 2000),
        'images' => $clean,
    ], fn($v) => $v !== '');
} elseif (($in['kind'] ?? '') === 'token') {
    // Edition metadata: one ERC-721 metadata document shared by every token of a collection.
    $image = https_url($in['image'] ?? null);
    if ($image === null) fail(422, 'An https image is required');
    $doc = array_filter([
        'name' => text($in['name'] ?? '', 64),
        'description' => text($in['description'] ?? '', 2000),
        'image' => $image,
    ], fn($v) => $v !== '');
} else {
    fail(422, 'Unknown kind');
}

$body = json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
$hash = hash('sha256', $body);
$dir = '/srv/jangteo/uploads';
$path = "$dir/$hash.json";
if (!is_file($path)) {
    if (!is_dir($dir) || file_put_contents($path, $body, LOCK_EX) === false) fail(500, 'Could not store the file');
    @chmod($path, 0644);
}
echo json_encode(['url' => "/uploads/$hash.json", 'sha256' => $hash]);
