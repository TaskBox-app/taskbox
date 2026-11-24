// --- Общая логика авторизации для секретного раздела (SECRET ARCHIVE) ---
//
// ВАЖНО (прочитай это, если меняешь код доступа):
// Это статический сайт без сервера, поэтому настоящую защиту здесь
// обеспечить нельзя — весь JavaScript выполняется в браузере пользователя
// и теоретически может быть прочитан или обойдён через консоль разработчика.
// Чтобы не хранить код открытым текстом, здесь хранится не сам код,
// а его SHA-256 хэш. Это защищает от случайного обнаружения кода при
// беглом просмотре файла, но не является защитой от целенаправленного взлома.
//
// Дополнительно: из этого же кода выводится ключ шифрования (AES-GCM через
// PBKDF2), которым в goals.js шифруется содержимое документов и файлов перед
// записью в LocalStorage. Это защищает от самого простого способа подглядеть
// данные — прочитать LocalStorage через консоль разработчика, не вводя код:
// без правильного кода содержимое выглядит как бессмысленный набор символов.
// Ключ хранится только в sessionStorage на время сессии и исчезает при выходе
// или закрытии вкладки.
// Подробности и честные ограничения — в README.md.

const GOALS_SESSION_KEY = "taskbox-goals-session";
const GOALS_ENC_SESSION_KEY = "taskbox-goals-enc-key";
// SHA-256 от правильного кода доступа (сам код нигде в коде не хранится).
const GOALS_CODE_HASH =
  "965e61d12e18d4cc44caff5cf27b19f1f3d26bc66c18c01cc738070b06bfe953";

// Соль для PBKDF2. Не является секретом (секрет — сам код доступа), нужна
// только для того, чтобы один и тот же код каждый раз давал один и тот же ключ.
const ENC_SALT = "secret-archive-pbkdf2-salt-v1";
const PBKDF2_ITERATIONS = 150000;

// --- Вспомогательное: ArrayBuffer <-> base64 ---

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Считает SHA-256 строки и возвращает его в виде hex-строки.
async function sha256Hex(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Выводит ключ AES-GCM-256 из кода доступа через PBKDF2.
async function deriveEncryptionKey(code) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(code.trim()),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(ENC_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// Сохраняет ключ шифрования в sessionStorage на время сессии (в виде raw-байт,
// закодированных в base64 — сам код доступа при этом нигде не сохраняется).
async function storeEncryptionKeyForSession(code) {
  const key = await deriveEncryptionKey(code);
  const raw = await crypto.subtle.exportKey("raw", key);
  sessionStorage.setItem(GOALS_ENC_SESSION_KEY, arrayBufferToBase64(raw));
}

// Возвращает CryptoKey текущей сессии для расшифровки архива, либо null,
// если сессии нет (например, доступ не открывали через настоящий код).
async function getArchiveEncryptionKey() {
  const base64 = sessionStorage.getItem(GOALS_ENC_SESSION_KEY);
  if (!base64) return null;
  try {
    return await crypto.subtle.importKey(
      "raw",
      base64ToArrayBuffer(base64),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"]
    );
  } catch (error) {
    console.error("Не удалось восстановить ключ шифрования сессии:", error);
    return null;
  }
}

// Проверяет введённый код и, если он верный, открывает сессию доступа
// и готовит ключ шифрования для этой сессии.
// Сессия хранится в sessionStorage — она живёт только пока открыта вкладка
// браузера и исчезает при её закрытии.
async function tryUnlockGoals(code) {
  const hash = await sha256Hex(code.trim());
  if (hash === GOALS_CODE_HASH) {
    sessionStorage.setItem(GOALS_SESSION_KEY, GOALS_CODE_HASH);
    await storeEncryptionKeyForSession(code);
    return true;
  }
  return false;
}

function isGoalsUnlocked() {
  return sessionStorage.getItem(GOALS_SESSION_KEY) === GOALS_CODE_HASH;
}

function lockGoals() {
  sessionStorage.removeItem(GOALS_SESSION_KEY);
  sessionStorage.removeItem(GOALS_ENC_SESSION_KEY);
}
