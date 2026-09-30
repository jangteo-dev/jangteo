<?php
// Token metadata for collections whose creators uploaded one artwork per token on Insadong.
// /nft/<manifest sha256>/<id>.json is rewritten here; the manifest (stored by nft-json.php, named
// by the hash of its content) lists the images in token order, so nothing here can change later.
declare(strict_types=1);
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Access-Control-Allow-Origin: *');

$m = $_GET['m'] ?? '';
$id = $_GET['id'] ?? '';
if (!preg_match('/^[0-9a-f]{64}$/', $m) || !preg_match('/^[1-9][0-9]{0,5}$/', $id)) {
    http_response_code(400);
    echo json_encode(['error' => 'bad request']);
    exit;
}
$file = "/srv/jangteo/uploads/$m.json";
$doc = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
if (!is_array($doc) || ($doc['kind'] ?? '') !== 'manifest' || !isset($doc['images'][(int) $id - 1])) {
    http_response_code(404);
    echo json_encode(['error' => 'no such token']);
    exit;
}
header('Cache-Control: public, max-age=31536000, immutable');
echo json_encode(array_filter([
    'name' => ($doc['name'] ?? 'Token') . ' #' . $id,
    'description' => $doc['description'] ?? null,
    'image' => $doc['images'][(int) $id - 1],
], fn($v) => $v !== null && $v !== ''), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
