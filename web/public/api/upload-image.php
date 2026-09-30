<?php
// Token image upload for 장터 뻥튀기 launches: validates the file, re-encodes it to a 512×512 WebP
// (which also strips metadata and anything that isn't an image), pins it on IPFS through Pinata
// and returns an https gateway URL. The Pinata key never leaves the server.
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
// Same-site uploads only: a page elsewhere cannot spend our Pinata quota through a visitor's browser.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$host = $_SERVER['HTTP_HOST'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== $host) fail(403, 'Cross-site upload refused');

// kind=nft: one artwork of a collection (fit within 1024 px, kept on this server, 300 an hour).
// Otherwise a token or cover image (512 px square, pinned on IPFS when possible, 20 an hour).
$nft = ($_POST['kind'] ?? '') === 'nft';
$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rate = sys_get_temp_dir() . '/jangteo-upload-' . ($nft ? 'nft-' : '') . hash('sha256', $ip) . '.json';
$now = time();
$hits = is_file($rate) ? json_decode((string) file_get_contents($rate), true) : [];
$hits = array_values(array_filter(is_array($hits) ? $hits : [], fn($t) => is_int($t) && $t > $now - 3600));
if (count($hits) >= ($nft ? 300 : 20)) fail(429, 'Hourly upload limit reached. Try again later.');
$hits[] = $now;
file_put_contents($rate, json_encode($hits), LOCK_EX);

if (!isset($_FILES['image']) || ($_FILES['image']['error'] ?? 1) !== UPLOAD_ERR_OK) fail(400, 'No image received');
$file = $_FILES['image'];
if ($file['size'] < 1 || $file['size'] > 5 * 1024 * 1024) fail(413, 'Images up to 5 MB');
$mime = (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
$loaders = ['image/jpeg' => 'imagecreatefromjpeg', 'image/png' => 'imagecreatefrompng', 'image/webp' => 'imagecreatefromwebp', 'image/gif' => 'imagecreatefromgif'];
if (!isset($loaders[$mime])) fail(415, 'Use PNG, JPG, WebP or GIF');
$info = @getimagesize($file['tmp_name']);
if (!$info || $info[0] < 32 || $info[1] < 32 || $info[0] * $info[1] > 40_000_000) fail(422, 'Image must be between 32 px and 40 megapixels');
$src = @$loaders[$mime]($file['tmp_name']);
if (!$src) fail(422, 'Not a readable image');

$w = imagesx($src);
$h = imagesy($src);
if ($nft) {
    // Artwork keeps its shape: scaled to fit within 1024×1024, never enlarged.
    $k = min(1, 1024 / max($w, $h));
    $dw = max(1, (int) round($w * $k));
    $dh = max(1, (int) round($h * $k));
    $dst = imagecreatetruecolor($dw, $dh);
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    imagecopyresampled($dst, $src, 0, 0, 0, 0, $dw, $dh, $w, $h);
} else {
    // Centre square crop, 512×512.
    $side = min($w, $h);
    $dst = imagecreatetruecolor(512, 512);
    imagealphablending($dst, false);
    imagesavealpha($dst, true);
    imagecopyresampled($dst, $src, 0, 0, intdiv($w - $side, 2), intdiv($h - $side, 2), 512, 512, $side, $side);
}
ob_start();
imagewebp($dst, null, $nft ? 86 : 80);
$webp = (string) ob_get_clean();
imagedestroy($src);
imagedestroy($dst);
if ($webp === '' || strlen($webp) > ($nft ? 1200 : 400) * 1024) fail(422, 'Image too large after compression');

$hash = hash('sha256', $webp);
$jwt = !$nft && is_readable('/etc/jangteo/pinata.jwt') ? trim((string) file_get_contents('/etc/jangteo/pinata.jwt')) : '';
if ($jwt !== '') {
    $tmp = tempnam(sys_get_temp_dir(), 'jangteo-ipfs-');
    file_put_contents($tmp, $webp, LOCK_EX);
    $curl = curl_init('https://uploads.pinata.cloud/v3/files');
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => ['file' => new CURLFile($tmp, 'image/webp', $hash . '.webp'), 'network' => 'public', 'name' => 'jangteo-' . substr($hash, 0, 16)],
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $jwt],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
    ]);
    $raw = curl_exec($curl);
    $code = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    @unlink($tmp);
    $res = is_string($raw) ? json_decode($raw, true) : null;
    $cid = $res['data']['cid'] ?? $res['IpfsHash'] ?? null;
    if ($code >= 200 && $code < 300 && is_string($cid) && preg_match('/^[a-zA-Z0-9]{20,100}$/', $cid)) {
        echo json_encode(['url' => 'https://gateway.pinata.cloud/ipfs/' . $cid, 'cid' => $cid, 'storage' => 'ipfs']);
        exit;
    }
}

// Pinata unavailable (or over quota): keep the image on Jangteo's own server, content-addressed.
$dir = '/srv/jangteo/uploads';
$path = $dir . '/' . $hash . '.webp';
if (!is_file($path) && file_put_contents($path, $webp, LOCK_EX) === false) fail(500, 'Storage unavailable');
$host = preg_replace('/[^a-zA-Z0-9.-]/', '', $_SERVER['HTTP_HOST'] ?? 'jangteo.org');
echo json_encode(['url' => 'https://' . $host . '/uploads/' . $hash . '.webp', 'storage' => 'server']);
