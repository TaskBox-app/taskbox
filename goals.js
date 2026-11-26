// --- SECRET ARCHIVE: документы, файлы и папки ---
//
// Хранилище: IndexedDB (с автоматической одноразовой миграцией из старого
// LocalStorage — см. раздел «Хранилище» ниже). Бэкенда в проекте нет — это
// статический сайт без сервера, все данные остаются только в этом браузере.
//
// Содержимое документов и файлов шифруется (AES-GCM-256, ключ через PBKDF2 —
// см. auth.js: getArchiveEncryptionKey) перед записью в хранилище. Это
// защищает от самого простого способа подглядеть данные: прочитать
// хранилище через консоль разработчика, не вводя код доступа. Метаданные
// (даты, размер, id папки/родителя) не шифруются — они нужны для сортировки
// и фильтрации и не считаются секретными.
//
// Дополнительно отдельные документы и файлы можно защитить СВОИМ паролем
// (см. раздел «Пароль на документ/файл» ниже) — это второй, независимый
// слой шифрования поверх общего, с собственным ключом.
// Подробности и честные ограничения — в README.md.

const SA_DOCS_KEY = "secret-archive-documents";
const SA_FILES_KEY = "secret-archive-files";
const SA_FOLDERS_KEY = "secret-archive-folders";
const SA_STORAGE_MODE_KEY = "secret-archive-storage-mode";
const SA_MIGRATION_BACKUP_AT_KEY = "secret-archive-migration-backup-at";
const SA_DOC_DRAFT_KEY = "secret-archive-doc-draft";

const IDB_NAME = "secret-archive-db";
const IDB_VERSION = 1;
const IDB_STORES = ["documents", "files", "folders"];

// Старый раздел Goals убран из проекта — подчищаем его данные, если остались.
localStorage.removeItem("taskbox-goals");

const MAX_FILE_SIZE_LOCALSTORAGE = 2 * 1024 * 1024; // 2 МБ — старый лимит для LocalStorage
const MAX_FILE_SIZE_INDEXEDDB = 25 * 1024 * 1024; // 25 МБ — IndexedDB на порядки просторнее

const LOCKED_DOC_PLACEHOLDER_TITLE = "🔒 Защищённый документ";
const LOCKED_FILE_PLACEHOLDER_NAME = "🔒 Защищённый файл";
const ITEM_LOCK_PBKDF2_ITERATIONS = 150000;

// --- Состояние (заполняется асинхронно в init(), после расшифровки) ---

let documents = [];
let files = [];
let folders = [];
let encryptionKey = null;

let currentView = "home";
let activeFolderId = null; // null = без фильтра по папке
let editingDocId = null;
let editingFolderId = null; // null = создаём новую папку, иначе — переименовываем
let creatingFolderParentId = null; // id родителя для новой папки (null = корень)
const expandedFolderIds = new Set(); // какие папки раскрыты в дереве (только в памяти)

// Ключи индивидуальной защиты документов/файлов, которые разблокированы в
// этой сессии (id -> CryptoKey). Живёт только в памяти, исчезает при выходе
// или перезагрузке — как и основной ключ архива.
const unlockedItemKeys = new Map();

// --- Хранилище: IndexedDB с запасным вариантом на LocalStorage ---
//
// storageMode определяется один раз при запуске:
// - "indexeddb", если IndexedDB доступен в этом браузере (обычный случай);
// - "localStorage", если IndexedDB недоступен (очень старый браузер или
//   режим приватного просмотра в некоторых версиях Safari, где IndexedDB
//   может быть заблокирован) — тогда архив продолжает работать как раньше,
//   без миграции.

let storageMode = "localStorage";
let idbInstance = null;

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB недоступен в этом браузере"));
      return;
    }
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      IDB_STORES.forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "id" });
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Полностью заменяет содержимое стора текущим состоянием массива в памяти
// (аналог "сохранить всё заново", как раньше делал localStorage.setItem).
function idbReplaceAll(db, storeName, items) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    store.clear();
    items.forEach((item) => store.put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function loadRawArray(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.error(`Не удалось прочитать ${key} из LocalStorage:`, error);
    return [];
  }
}

// --- Миграция из LocalStorage в IndexedDB (выполняется один раз) ---
//
// Шаги, в порядке, который требует задание:
// 1. Снимаем резервную копию текущих данных LocalStorage под отдельными
//    ключами (*__backup) — на случай, если что-то пойдёт не так.
// 2. Переносим данные в IndexedDB (как есть, уже зашифрованными —
//    расшифровка тут не нужна, мы просто переносим блоки данных).
// 3. Проверяем, что в IndexedDB оказалось столько же записей, сколько было
//    в LocalStorage — только после этой проверки считаем миграцию успешной.
// 4. НИКОГДА не удаляем оригинальные ключи LocalStorage автоматически —
//    они остаются как дополнительная подстраховка, даже после успешной
//    миграции. Они просто перестают использоваться.
async function migrateLocalStorageToIndexedDB(db) {
  const alreadyMigrated = localStorage.getItem(SA_STORAGE_MODE_KEY) === "indexeddb";
  if (alreadyMigrated) return;

  const rawDocs = loadRawArray(SA_DOCS_KEY);
  const rawFiles = loadRawArray(SA_FILES_KEY);
  const rawFolders = loadRawArray(SA_FOLDERS_KEY);

  // Папки до этой версии не имели parentId (вложенных папок не было) —
  // при миграции проставляем parentId: null, то есть "корневая папка".
  const rawFoldersWithParent = rawFolders.map((f) => ({ parentId: null, ...f }));

  // Шаг 1: резервная копия (ничего не удаляем, просто дублируем под другим
  // ключом — так оригинал остаётся нетронутым даже от случайной ошибки ниже).
  localStorage.setItem(`${SA_DOCS_KEY}__backup`, JSON.stringify(rawDocs));
  localStorage.setItem(`${SA_FILES_KEY}__backup`, JSON.stringify(rawFiles));
  localStorage.setItem(`${SA_FOLDERS_KEY}__backup`, JSON.stringify(rawFoldersWithParent));
  localStorage.setItem(SA_MIGRATION_BACKUP_AT_KEY, new Date().toISOString());

  // Если переносить нечего (новый, пустой архив) — сразу помечаем как
  // мигрированный, без лишней работы.
  if (!rawDocs.length && !rawFiles.length && !rawFoldersWithParent.length) {
    localStorage.setItem(SA_STORAGE_MODE_KEY, "indexeddb");
    return;
  }

  // Шаг 2: перенос в IndexedDB.
  await idbReplaceAll(db, "documents", rawDocs);
  await idbReplaceAll(db, "files", rawFiles);
  await idbReplaceAll(db, "folders", rawFoldersWithParent);

  // Шаг 3: проверка, что ничего не потерялось.
  const verifyDocs = await idbGetAll(db, "documents");
  const verifyFiles = await idbGetAll(db, "files");
  const verifyFolders = await idbGetAll(db, "folders");

  const migrationOk =
    verifyDocs.length === rawDocs.length &&
    verifyFiles.length === rawFiles.length &&
    verifyFolders.length === rawFoldersWithParent.length;

  if (!migrationOk) {
    throw new Error(
      "Проверка миграции в IndexedDB не прошла: количество записей не совпадает. " +
        "Резервная копия сохранена в LocalStorage (ключи с суффиксом __backup)."
    );
  }

  // Шаг 4: помечаем как мигрированное. Оригинальные ключи LocalStorage
  // намеренно НЕ удаляются — см. комментарий выше.
  localStorage.setItem(SA_STORAGE_MODE_KEY, "indexeddb");
}

// --- Универсальный доступ к коллекциям (документы/файлы/папки) ---
// Скрывает разницу между IndexedDB и запасным вариантом на LocalStorage.

async function loadRawCollection(storeName, localStorageKey) {
  if (storageMode === "indexeddb") {
    return idbGetAll(idbInstance, storeName);
  }
  return loadRawArray(localStorageKey);
}

async function saveRawCollection(storeName, localStorageKey, items) {
  if (storageMode === "indexeddb") {
    await idbReplaceAll(idbInstance, storeName, items);
  } else {
    localStorage.setItem(localStorageKey, JSON.stringify(items));
  }
}

// --- Шифрование содержимого (основной ключ архива) ---

async function encryptPayload(payload, key = encryptionKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: arrayBufferToBase64(iv), data: arrayBufferToBase64(cipherBuffer) };
}

async function decryptPayload(enc, key = encryptionKey) {
  const iv = new Uint8Array(base64ToArrayBuffer(enc.iv));
  const cipherBuffer = base64ToArrayBuffer(enc.data);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuffer);
  return JSON.parse(new TextDecoder().decode(plainBuffer));
}

// --- Пароль на документ/файл (второй, независимый слой шифрования) ---
//
// У каждого защищённого документа/файла — свой случайный `lockSalt` и свой
// ключ AES-GCM-256, выведенный из введённого пароля через PBKDF2 (как и
// основной ключ архива, но с собственной солью, так что одинаковые пароли
// на разных элементах дают разные ключи). Пока элемент не разблокирован в
// этой сессии, его `title`/`content` (или `name`/`dataUrl` у файла) в
// памяти — это просто плейсхолдер, а настоящие зашифрованные данные лежат
// в `_lockedEnc` нетронутыми. Ключ разблокированного элемента держится
// только в памяти (unlockedItemKeys) и исчезает при выходе/перезагрузке —
// после этого документ снова нужно открывать паролем.

function generateSalt() {
  return arrayBufferToBase64(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

async function deriveItemLockKey(password, saltBase64) {
  const enc = new TextEncoder();
  const salt = base64ToArrayBuffer(saltBase64);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: ITEM_LOCK_PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// Ставит пароль на документ/файл, для которого сейчас известно настоящее
// содержимое (не защищён или уже разблокирован). Сразу оставляет элемент
// разблокированным в этой сессии.
async function lockItemWithPassword(item, secretPayload, password) {
  const salt = generateSalt();
  const key = await deriveItemLockKey(password, salt);
  const check = await encryptPayload({ check: "ok" }, key);
  item.locked = true;
  item.lockSalt = salt;
  item.lockCheck = check;
  item._sealed = false;
  unlockedItemKeys.set(item.id, key);
  return key;
}

// Пробует открыть защищённый элемент паролем. true — пароль верный,
// элемент расшифрован и остаётся разблокированным в памяти до конца сессии.
async function tryUnlockItem(item, password) {
  try {
    const key = await deriveItemLockKey(password, item.lockSalt);
    await decryptPayload(item.lockCheck, key); // бросит исключение, если пароль неверный
    const secret = await decryptPayload(item._lockedEnc, key);
    Object.assign(item, secret);
    item._sealed = false;
    unlockedItemKeys.set(item.id, key);
    return true;
  } catch (error) {
    return false;
  }
}

// --- Загрузка/сохранение документов (с учётом индивидуальной защиты) ---

async function loadDocumentsFromStorage() {
  const raw = await loadRawCollection("documents", SA_DOCS_KEY);
  let needsMigration = false;

  const items = await Promise.all(
    raw.map(async (item) => {
      if (!item.enc) {
        needsMigration = true;
        return { ...item };
      }
      if (item.locked) {
        const { enc, ...meta } = item;
        return {
          ...meta,
          _lockedEnc: enc,
          _sealed: true,
          title: LOCKED_DOC_PLACEHOLDER_TITLE,
          content: "",
        };
      }
      const { enc, ...meta } = item;
      const secret = await decryptPayload(enc);
      return { ...meta, ...secret };
    })
  );

  return { items, needsMigration };
}

async function saveDocuments() {
  const encrypted = await Promise.all(
    documents.map(async (doc) => {
      const meta = {
        id: doc.id,
        folderId: doc.folderId,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
      if (doc.locked) {
        meta.locked = true;
        meta.lockSalt = doc.lockSalt;
        meta.lockCheck = doc.lockCheck;
        if (doc._sealed) {
          meta.enc = doc._lockedEnc; // не трогаем — не расшифровывалось в этой сессии
        } else {
          const key = unlockedItemKeys.get(doc.id);
          meta.enc = await encryptPayload({ title: doc.title, content: doc.content }, key);
        }
      } else {
        meta.enc = await encryptPayload({ title: doc.title, content: doc.content });
      }
      return meta;
    })
  );
  await saveRawCollection("documents", SA_DOCS_KEY, encrypted);
}

async function loadFilesFromStorage() {
  const raw = await loadRawCollection("files", SA_FILES_KEY);
  let needsMigration = false;

  const items = await Promise.all(
    raw.map(async (item) => {
      if (!item.enc) {
        needsMigration = true;
        return { ...item };
      }
      if (item.locked) {
        const { enc, ...meta } = item;
        return {
          ...meta,
          _lockedEnc: enc,
          _sealed: true,
          name: LOCKED_FILE_PLACEHOLDER_NAME,
          dataUrl: "",
        };
      }
      const { enc, ...meta } = item;
      const secret = await decryptPayload(enc);
      return { ...meta, ...secret };
    })
  );

  return { items, needsMigration };
}

async function saveFiles() {
  try {
    const encrypted = await Promise.all(
      files.map(async (file) => {
        const meta = {
          id: file.id,
          folderId: file.folderId,
          mimeType: file.mimeType,
          size: file.size,
          createdAt: file.createdAt,
        };
        if (file.locked) {
          meta.locked = true;
          meta.lockSalt = file.lockSalt;
          meta.lockCheck = file.lockCheck;
          if (file._sealed) {
            meta.enc = file._lockedEnc;
          } else {
            const key = unlockedItemKeys.get(file.id);
            meta.enc = await encryptPayload({ name: file.name, dataUrl: file.dataUrl }, key);
          }
        } else {
          meta.enc = await encryptPayload({ name: file.name, dataUrl: file.dataUrl });
        }
        return meta;
      })
    );
    await saveRawCollection("files", SA_FILES_KEY, encrypted);
    return true;
  } catch (error) {
    console.error("Не удалось сохранить файлы:", error);
    alert(
      "Не удалось сохранить файл: хранилище браузера переполнено. " +
        "Удали старые файлы или выбери файл поменьше."
    );
    return false;
  }
}

// Папки индивидуально не защищаются паролем (только их содержимое — через
// массовую блокировку документов/файлов внутри, см. ниже), поэтому для них
// шифрование как было — только названием, основным ключом архива.
async function saveFolders() {
  const encrypted = await Promise.all(
    folders.map(async (folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      createdAt: folder.createdAt,
      enc: await encryptPayload({ name: folder.name }),
    }))
  );
  await saveRawCollection("folders", SA_FOLDERS_KEY, encrypted);
}

async function loadFoldersFromStorage() {
  const raw = await loadRawCollection("folders", SA_FOLDERS_KEY);
  let needsMigration = false;

  const items = await Promise.all(
    raw.map(async (item) => {
      if (!item.enc) {
        needsMigration = true;
        return { parentId: null, ...item };
      }
      const { enc, ...meta } = item;
      const secret = await decryptPayload(enc);
      return { parentId: null, ...meta, ...secret };
    })
  );

  return { items, needsMigration };
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fileIconFor(mimeType, name) {
  if (mimeType.startsWith("image/")) return "🖼";
  if (mimeType === "application/pdf" || name.toLowerCase().endsWith(".pdf")) return "📕";
  if (name.toLowerCase().endsWith(".docx")) return "📘";
  if (mimeType.startsWith("text/") || name.toLowerCase().endsWith(".txt")) return "📝";
  return "📦";
}

function maxFileSize() {
  return storageMode === "indexeddb" ? MAX_FILE_SIZE_INDEXEDDB : MAX_FILE_SIZE_LOCALSTORAGE;
}

// --- DOM ---

const navItems = document.querySelectorAll(".nav-item");
const views = {
  home: document.getElementById("view-home"),
  documents: document.getElementById("view-documents"),
  files: document.getElementById("view-files"),
  backup: document.getElementById("view-backup"),
};

const statDocsEl = document.getElementById("stat-docs");
const statFilesEl = document.getElementById("stat-files");
const statFoldersEl = document.getElementById("stat-folders");
const recentListEl = document.getElementById("recent-list");
const recentEmptyEl = document.getElementById("recent-empty");

const foldersListEl = document.getElementById("folders-list");
const newFolderBtn = document.getElementById("new-folder-btn");
const folderModalOverlay = document.getElementById("folder-modal-overlay");
const folderModalTitle = document.getElementById("folder-modal-title");
const folderFormSubmit = document.getElementById("folder-form-submit");
const folderModalClose = document.getElementById("folder-modal-close");
const folderForm = document.getElementById("folder-form");
const folderNameInput = document.getElementById("folder-name-input");

const docsGridEl = document.getElementById("docs-grid");
const docsEmptyEl = document.getElementById("docs-empty");
const docSearchInput = document.getElementById("doc-search");
const docSortSelect = document.getElementById("doc-sort-select");
const newDocBtn = document.getElementById("new-doc-btn");
const docFolderChip = document.getElementById("doc-folder-chip");
const docFolderChipLabel = document.getElementById("doc-folder-chip-label");
const docFolderChipClear = document.getElementById("doc-folder-chip-clear");

const docModalOverlay = document.getElementById("doc-modal-overlay");
const docModalTitle = document.getElementById("doc-modal-title");
const docModalClose = document.getElementById("doc-modal-close");
const docForm = document.getElementById("doc-form");
const docTitleInput = document.getElementById("doc-title-input");
const docContentInput = document.getElementById("doc-content-input");
const docFolderSelect = document.getElementById("doc-folder-select");
const docDraftHint = document.getElementById("doc-draft-hint");

const filesGridEl = document.getElementById("files-grid");
const filesEmptyEl = document.getElementById("files-empty");
const fileSearchInput = document.getElementById("file-search");
const fileSortSelect = document.getElementById("file-sort-select");
const uploadFileBtn = document.getElementById("upload-file-btn");
const fileInput = document.getElementById("file-input");
const fileFolderChip = document.getElementById("file-folder-chip");
const fileFolderChipLabel = document.getElementById("file-folder-chip-label");
const fileFolderChipClear = document.getElementById("file-folder-chip-clear");

const logoutBtn = document.getElementById("logout-btn");

// --- Модалка ввода/установки пароля (общая для документов, файлов, папок) ---

const passwordModalOverlay = document.getElementById("password-modal-overlay");
const passwordModalTitle = document.getElementById("password-modal-title");
const passwordModalClose = document.getElementById("password-modal-close");
const passwordForm = document.getElementById("password-form");
const passwordFieldLabel = document.getElementById("password-field-label");
const passwordInput = document.getElementById("password-input");
const passwordConfirmField = document.getElementById("password-confirm-field");
const passwordConfirmInput = document.getElementById("password-confirm-input");
const passwordError = document.getElementById("password-error");
const passwordFormSubmit = document.getElementById("password-form-submit");

let passwordModalHandler = null; // async (password) => { ok: boolean, message?: string }

function openPasswordModal({ title, label = "Пароль", confirmMode = false, submitLabel = "Подтвердить", onSubmit }) {
  passwordModalTitle.textContent = title;
  passwordFieldLabel.textContent = label;
  passwordFormSubmit.textContent = submitLabel;
  passwordForm.reset();
  passwordError.hidden = true;
  passwordConfirmField.hidden = !confirmMode;
  passwordConfirmInput.required = confirmMode;
  passwordModalHandler = onSubmit;
  passwordModalOverlay.hidden = false;
  passwordInput.focus();
}

function closePasswordModal() {
  passwordModalOverlay.hidden = true;
  passwordModalHandler = null;
}

passwordModalClose.addEventListener("click", closePasswordModal);
passwordModalOverlay.addEventListener("click", (e) => {
  if (e.target === passwordModalOverlay) closePasswordModal();
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = passwordInput.value;
  if (!password) return;

  if (!passwordConfirmField.hidden && password !== passwordConfirmInput.value) {
    passwordError.textContent = "Пароли не совпадают.";
    passwordError.hidden = false;
    return;
  }

  const handler = passwordModalHandler;
  if (!handler) return;

  passwordFormSubmit.disabled = true;
  const result = await handler(password);
  passwordFormSubmit.disabled = false;

  if (result && result.ok) {
    closePasswordModal();
    renderAll();
  } else {
    passwordError.textContent = (result && result.message) || "Неверный пароль.";
    passwordError.hidden = false;
    passwordInput.value = "";
    passwordInput.focus();
  }
});

// --- Навигация между разделами ---

function switchView(view) {
  currentView = view;
  Object.keys(views).forEach((key) => {
    views[key].hidden = key !== view;
  });
  navItems.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
}

navItems.forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

logoutBtn.addEventListener("click", () => {
  lockGoals();
  window.location.href = "index.html";
});

// --- Экспорт / импорт (перенос данных на другое устройство) ---
//
// Файл экспорта содержит те же зашифрованные блоки, что лежат в хранилище —
// открыть и прочитать его можно только зная тот же код доступа (им же на
// другом устройстве будет расшифрован этот файл при импорте). Документы и
// файлы, защищённые отдельным паролем, остаются защищены им же и после
// экспорта/импорта — для них помимо кода доступа архива понадобится ещё и
// их собственный пароль.

const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFileInput = document.getElementById("import-file-input");

async function exportArchive() {
  const payload = {
    app: "secret-archive-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    documents: await loadRawCollection("documents", SA_DOCS_KEY),
    files: await loadRawCollection("files", SA_FILES_KEY),
    folders: await loadRawCollection("folders", SA_FOLDERS_KEY),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `secret-archive-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Расшифровывает импортируемые записи текущим ключом сессии. Запись,
// защищённую индивидуальным паролем, не трогает — переносит как есть,
// запечатанной (её при необходимости разблокируют на новом устройстве тем
// же паролем). Запись, которую не получилось расшифровать основным ключом
// (например, бэкап сделан с другим кодом доступа), пропускается, а не
// ломает весь импорт.
async function decryptImportedArray(rawArray, placeholderFields = {}) {
  const items = [];
  let failed = 0;

  for (const item of rawArray) {
    try {
      if (!item.enc) {
        items.push(item);
        continue;
      }
      if (item.locked) {
        const { enc, ...meta } = item;
        items.push({ ...meta, _lockedEnc: enc, _sealed: true, ...placeholderFields });
        continue;
      }
      const { enc, ...meta } = item;
      const secret = await decryptPayload(enc);
      items.push({ ...meta, ...secret });
    } catch (error) {
      failed++;
    }
  }

  return { items, failed };
}

async function importArchive(file) {
  let payload;
  try {
    const text = await file.text();
    payload = JSON.parse(text);
  } catch (error) {
    alert("Не удалось прочитать файл — это не похоже на файл экспорта SECRET ARCHIVE.");
    return;
  }

  if (
    !payload ||
    !Array.isArray(payload.documents) ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.folders)
  ) {
    alert("Файл не похож на экспорт SECRET ARCHIVE.");
    return;
  }

  const [docsResult, filesResult, foldersResult] = await Promise.all([
    decryptImportedArray(payload.documents, { title: LOCKED_DOC_PLACEHOLDER_TITLE, content: "" }),
    decryptImportedArray(payload.files, { name: LOCKED_FILE_PLACEHOLDER_NAME, dataUrl: "" }),
    decryptImportedArray(payload.folders),
  ]);

  const totalItems = payload.documents.length + payload.files.length + payload.folders.length;
  const totalFailed = docsResult.failed + filesResult.failed + foldersResult.failed;

  if (totalItems > 0 && totalFailed === totalItems) {
    alert(
      "Не удалось расшифровать ни одной записи из файла. " +
        "Скорее всего, бэкап сделан с другим кодом доступа — импорт возможен только тем же кодом."
    );
    return;
  }

  // Папки: добавляем только те, которых ещё нет (по id). Старые бэкапы без
  // parentId получают parentId: null (корень) — ничего не ломается.
  let addedFolders = 0;
  foldersResult.items.forEach((folder) => {
    if (!folders.some((f) => f.id === folder.id)) {
      folders.push({ parentId: null, ...folder });
      addedFolders++;
    }
  });

  // Документы: новые — добавляем; существующие — обновляем, только если
  // импортируемая версия новее (по updatedAt). Так правки с другого
  // устройства подтягиваются, а более свежие локальные правки не затираются.
  let addedDocs = 0;
  let updatedDocs = 0;
  docsResult.items.forEach((doc) => {
    const existing = documents.find((d) => d.id === doc.id);
    if (!existing) {
      documents.push(doc);
      addedDocs++;
    } else if (new Date(doc.updatedAt) > new Date(existing.updatedAt)) {
      Object.assign(existing, doc);
      updatedDocs++;
    }
  });

  // Файлы: добавляем только новые (по id). Существующие не перезаписываем.
  let addedFiles = 0;
  filesResult.items.forEach((file) => {
    if (!files.some((f) => f.id === file.id)) {
      files.push(file);
      addedFiles++;
    }
  });

  await Promise.all([saveFolders(), saveDocuments(), saveFiles()]);
  renderAll();

  let message =
    `Импорт завершён.\n` +
    `Документы: добавлено ${addedDocs}, обновлено ${updatedDocs}.\n` +
    `Файлы: добавлено ${addedFiles}.\n` +
    `Папки: добавлено ${addedFolders}.`;
  if (totalFailed > 0) {
    message += `\n\nНе удалось расшифровать ${totalFailed} запис(ей) — пропущены.`;
  }
  alert(message);
}

exportBtn.addEventListener("click", exportArchive);
importBtn.addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", async () => {
  const file = importFileInput.files[0];
  importFileInput.value = "";
  if (!file) return;
  await importArchive(file);
});

// --- Папки (с вложенностью) ---

function getFolderName(folderId) {
  const folder = folders.find((f) => f.id === folderId);
  return folder ? folder.name : null;
}

function countItemsInFolder(folderId) {
  const docCount = documents.filter((d) => d.folderId === folderId).length;
  const fileCount = files.filter((f) => f.folderId === folderId).length;
  return docCount + fileCount;
}

function getChildFolders(parentId) {
  return folders
    .filter((f) => f.parentId === parentId)
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

function folderHasChildren(folderId) {
  return folders.some((f) => f.parentId === folderId);
}

// Прямые документы/файлы папки (не рекурсивно) — используется массовой
// блокировкой/разблокировкой содержимого папки паролем.
function getDirectDocsAndFiles(folderId) {
  return {
    docs: documents.filter((d) => d.folderId === folderId),
    files: files.filter((f) => f.folderId === folderId),
  };
}

// Строит плоский список всех папок с указанием глубины вложенности —
// используется для выпадающих списков (там нельзя показать настоящее дерево,
// поэтому вложенность показываем отступом «— »).
function getFlatFolderList() {
  const result = [];
  function walk(parentId, depth) {
    getChildFolders(parentId).forEach((folder) => {
      result.push({ folder, depth });
      walk(folder.id, depth + 1);
    });
  }
  walk(null, 0);
  return result;
}

function openFolderModal({ parentId = null, editFolder = null } = {}) {
  folderForm.reset();
  editingFolderId = editFolder ? editFolder.id : null;
  creatingFolderParentId = parentId;

  if (editFolder) {
    folderModalTitle.textContent = "Переименовать папку";
    folderNameInput.value = editFolder.name;
    folderFormSubmit.textContent = "Сохранить";
  } else if (parentId) {
    folderModalTitle.textContent = `Новая папка в «${getFolderName(parentId)}»`;
    folderFormSubmit.textContent = "Создать";
  } else {
    folderModalTitle.textContent = "Новая папка";
    folderFormSubmit.textContent = "Создать";
  }

  folderModalOverlay.hidden = false;
  folderNameInput.focus();
}

function closeFolderModal() {
  folderModalOverlay.hidden = true;
  editingFolderId = null;
  creatingFolderParentId = null;
}

newFolderBtn.addEventListener("click", () => openFolderModal());
folderModalClose.addEventListener("click", closeFolderModal);
folderModalOverlay.addEventListener("click", (e) => {
  if (e.target === folderModalOverlay) closeFolderModal();
});

folderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = folderNameInput.value.trim();
  if (!name) return;

  if (editingFolderId) {
    const folder = folders.find((f) => f.id === editingFolderId);
    if (folder) folder.name = name;
  } else {
    const parentId = creatingFolderParentId;
    folders.push({ id: generateId(), name, parentId, createdAt: new Date().toISOString() });
    if (parentId) expandedFolderIds.add(parentId);
  }

  await saveFolders();
  closeFolderModal();
  renderAll();
});

function setActiveFolder(folderId) {
  activeFolderId = folderId;
  renderFolders();
  renderDocs();
  renderFiles();
}

async function deleteFolder(folderId) {
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return;
  const hasChildren = folderHasChildren(folderId);
  const warning = hasChildren
    ? `Удалить папку «${folder.name}»? Вложенные папки переместятся на уровень выше, а документы и файлы в ней останутся, но потеряют папку.`
    : `Удалить папку «${folder.name}»? Документы и файлы в ней останутся, но потеряют папку.`;
  if (!confirm(warning)) return;

  // Вложенные папки поднимаем на уровень выше (к родителю удаляемой папки),
  // а не удаляем вместе с ней и не делаем сиротами — дерево остаётся целым.
  folders.forEach((f) => {
    if (f.parentId === folderId) f.parentId = folder.parentId;
  });

  folders = folders.filter((f) => f.id !== folderId);
  documents.forEach((d) => {
    if (d.folderId === folderId) d.folderId = null;
  });
  files.forEach((f) => {
    if (f.folderId === folderId) f.folderId = null;
  });

  await saveFolders();
  await saveDocuments();
  await saveFiles();

  if (activeFolderId === folderId) activeFolderId = null;
  expandedFolderIds.delete(folderId);
  renderAll();
}

// --- Массовая блокировка/разблокировка содержимого папки паролем ---
//
// «Пароль на папку» — это не отдельный самостоятельный слой шифрования для
// самой папки (её название по-прежнему шифруется общим ключом архива и
// видно в дереве), а удобное массовое действие: одним паролем защищаются
// (или открываются) все документы и файлы, лежащие непосредственно в этой
// папке — тем же механизмом индивидуальной защиты, что и у одиночного
// документа/файла (см. выше). У каждого элемента всё равно свой случайный
// lockSalt, даже если пароль один на всех.

function folderLockableCounts(folderId) {
  const { docs, files: folderFiles } = getDirectDocsAndFiles(folderId);
  const lockable = [...docs, ...folderFiles].filter((item) => !item.locked);
  const sealed = [...docs, ...folderFiles].filter((item) => item.locked && item._sealed);
  return { lockableCount: lockable.length, sealedCount: sealed.length };
}

function openLockFolderModal(folder) {
  const { lockableCount } = folderLockableCounts(folder.id);
  if (lockableCount === 0) {
    alert(`В папке «${folder.name}» нет документов или файлов, которые можно защитить (без учёта вложенных папок).`);
    return;
  }

  openPasswordModal({
    title: `Защитить содержимое папки «${folder.name}»`,
    label: "Новый пароль",
    confirmMode: true,
    submitLabel: "Защитить",
    onSubmit: async (password) => {
      const { docs, files: folderFiles } = getDirectDocsAndFiles(folder.id);
      let locked = 0;

      for (const doc of docs) {
        if (doc.locked) continue;
        await lockItemWithPassword(doc, { title: doc.title, content: doc.content }, password);
        locked++;
      }
      for (const file of folderFiles) {
        if (file.locked) continue;
        await lockItemWithPassword(file, { name: file.name, dataUrl: file.dataUrl }, password);
        locked++;
      }

      await Promise.all([saveDocuments(), saveFiles()]);
      alert(`Защищено паролем: ${locked} элемент(ов) в папке «${folder.name}».`);
      return { ok: true };
    },
  });
}

function openUnlockFolderModal(folder) {
  const { sealedCount } = folderLockableCounts(folder.id);
  if (sealedCount === 0) {
    alert(`В папке «${folder.name}» нет запечатанных элементов для разблокировки.`);
    return;
  }

  openPasswordModal({
    title: `Разблокировать содержимое папки «${folder.name}»`,
    label: "Пароль",
    confirmMode: false,
    submitLabel: "Открыть",
    onSubmit: async (password) => {
      const { docs, files: folderFiles } = getDirectDocsAndFiles(folder.id);
      let unlocked = 0;
      let attempted = 0;

      for (const doc of docs) {
        if (!(doc.locked && doc._sealed)) continue;
        attempted++;
        if (await tryUnlockItem(doc, password)) unlocked++;
      }
      for (const file of folderFiles) {
        if (!(file.locked && file._sealed)) continue;
        attempted++;
        if (await tryUnlockItem(file, password)) unlocked++;
      }

      if (unlocked === 0) {
        return { ok: false, message: "Неверный пароль — ни один элемент не открылся." };
      }

      alert(`Открыто паролем: ${unlocked} из ${attempted} защищённых элементов в папке «${folder.name}».`);
      return { ok: true };
    },
  });
}

function renderFolderNode(folder, depth, container) {
  const hasChildren = folderHasChildren(folder.id);
  const isExpanded = expandedFolderIds.has(folder.id);
  const { lockableCount, sealedCount } = folderLockableCounts(folder.id);

  const item = document.createElement("div");
  item.className = "folder-item" + (activeFolderId === folder.id ? " active" : "");
  item.style.paddingLeft = `${8 + depth * 18}px`;

  if (hasChildren) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-toggle" + (isExpanded ? " expanded" : "");
    toggle.textContent = "▸";
    toggle.setAttribute("aria-label", isExpanded ? "Свернуть" : "Развернуть");
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expandedFolderIds.has(folder.id)) {
        expandedFolderIds.delete(folder.id);
      } else {
        expandedFolderIds.add(folder.id);
      }
      renderFolders();
    });
    item.appendChild(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "folder-toggle-spacer";
    item.appendChild(spacer);
  }

  const name = document.createElement("span");
  name.className = "folder-name";
  name.textContent = `📁 ${folder.name}`;
  name.addEventListener("click", () => {
    setActiveFolder(activeFolderId === folder.id ? null : folder.id);
  });

  const count = document.createElement("span");
  count.className = "folder-count";
  count.textContent = countItemsInFolder(folder.id);

  const actions = document.createElement("div");
  actions.className = "folder-actions";

  const addSubBtn = document.createElement("button");
  addSubBtn.type = "button";
  addSubBtn.className = "folder-action";
  addSubBtn.textContent = "+";
  addSubBtn.setAttribute("aria-label", `Новая папка в «${folder.name}»`);
  addSubBtn.title = "Новая вложенная папка";
  addSubBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openFolderModal({ parentId: folder.id });
  });

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "folder-action";
  renameBtn.textContent = "✎";
  renameBtn.setAttribute("aria-label", `Переименовать папку ${folder.name}`);
  renameBtn.title = "Переименовать";
  renameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openFolderModal({ editFolder: folder });
  });

  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.className = "folder-action";
  lockBtn.textContent = sealedCount > 0 ? "🔓" : "🔒";
  lockBtn.title = sealedCount > 0 ? "Разблокировать содержимое папки" : "Защитить содержимое папки паролем";
  lockBtn.setAttribute("aria-label", lockBtn.title);
  lockBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (sealedCount > 0) {
      openUnlockFolderModal(folder);
    } else {
      openLockFolderModal(folder);
    }
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "folder-action folder-delete";
  deleteBtn.textContent = "✕";
  deleteBtn.setAttribute("aria-label", `Удалить папку ${folder.name}`);
  deleteBtn.title = "Удалить";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteFolder(folder.id);
  });

  actions.appendChild(addSubBtn);
  actions.appendChild(renameBtn);
  if (lockableCount > 0 || sealedCount > 0) actions.appendChild(lockBtn);
  actions.appendChild(deleteBtn);

  item.appendChild(name);
  item.appendChild(count);
  item.appendChild(actions);
  container.appendChild(item);

  if (hasChildren && isExpanded) {
    getChildFolders(folder.id).forEach((child) => renderFolderNode(child, depth + 1, container));
  }
}

function renderFolders() {
  foldersListEl.innerHTML = "";
  getChildFolders(null).forEach((folder) => renderFolderNode(folder, 0, foldersListEl));
  renderFolderSelectOptions();
}

function renderFolderSelectOptions() {
  const current = docFolderSelect.value;
  docFolderSelect.innerHTML = '<option value="">Без папки</option>';
  getFlatFolderList().forEach(({ folder, depth }) => {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = `${"— ".repeat(depth)}${folder.name}`;
    docFolderSelect.appendChild(opt);
  });
  docFolderSelect.value = current;
}

function createFolderMiniSelect(item, onChange) {
  const select = document.createElement("select");
  select.className = "folder-select-mini";

  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "Без папки";
  select.appendChild(noneOpt);

  getFlatFolderList().forEach(({ folder, depth }) => {
    const opt = document.createElement("option");
    opt.value = folder.id;
    opt.textContent = `${"— ".repeat(depth)}📁 ${folder.name}`;
    select.appendChild(opt);
  });

  select.value = item.folderId || "";
  select.addEventListener("change", () => onChange(select.value || null));
  return select;
}

// --- Главная: статистика и недавние документы ---

function renderHome() {
  statDocsEl.textContent = documents.length;
  statFilesEl.textContent = files.length;
  statFoldersEl.textContent = folders.length;

  const recent = [...documents]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 5);

  recentListEl.innerHTML = "";
  recent.forEach((doc) => {
    const item = document.createElement("div");
    item.className = "recent-item";

    const title = document.createElement("span");
    title.className = "recent-item-title";
    title.textContent = doc.title;

    const date = document.createElement("span");
    date.className = "recent-item-date";
    date.textContent = formatDate(doc.updatedAt);

    item.appendChild(title);
    item.appendChild(date);
    item.addEventListener("click", () => openDocFromCard(doc));

    recentListEl.appendChild(item);
  });

  recentEmptyEl.hidden = recent.length !== 0;
}

// --- Сортировка (общая для документов и файлов) ---

function applySort(items, sortValue, nameField, dateField) {
  const sorted = [...items];
  switch (sortValue) {
    case "date-asc":
      sorted.sort((a, b) => new Date(a[dateField]) - new Date(b[dateField]));
      break;
    case "name-asc":
      sorted.sort((a, b) => a[nameField].localeCompare(b[nameField], "ru"));
      break;
    case "name-desc":
      sorted.sort((a, b) => b[nameField].localeCompare(a[nameField], "ru"));
      break;
    case "date-desc":
    default:
      sorted.sort((a, b) => new Date(b[dateField]) - new Date(a[dateField]));
      break;
  }
  return sorted;
}

// --- Черновик документа (автосохранение) ---
//
// Пока открыта модалка создания/редактирования документа, набранный текст
// каждые несколько секунд сохраняется (зашифрованным основным ключом
// архива) отдельно от самих документов. Если модалку закрыли случайно, не
// нажав «Сохранить» (Escape, клик мимо, случайная перезагрузка), при
// следующем открытии того же документа черновик предлагается восстановить.

let draftSaveTimer = null;

function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftNow, 600);
}

async function saveDraftNow() {
  if (docModalOverlay.hidden) return;
  const draft = {
    docId: editingDocId,
    title: docTitleInput.value,
    content: docContentInput.value,
    savedAt: new Date().toISOString(),
  };
  try {
    const enc = await encryptPayload(draft);
    localStorage.setItem(SA_DOC_DRAFT_KEY, JSON.stringify(enc));
  } catch (error) {
    console.error("Не удалось сохранить черновик:", error);
  }
}

function clearDraft() {
  localStorage.removeItem(SA_DOC_DRAFT_KEY);
}

async function loadDraft() {
  const raw = localStorage.getItem(SA_DOC_DRAFT_KEY);
  if (!raw) return null;
  try {
    return await decryptPayload(JSON.parse(raw));
  } catch (error) {
    return null;
  }
}

async function maybeOfferDraftRestore(targetDocId) {
  const draft = await loadDraft();
  if (!draft || draft.docId !== targetDocId) return;
  if (!draft.title && !draft.content) return;

  docDraftHint.hidden = false;
  docDraftHint.textContent = `Найден несохранённый черновик от ${formatDateTime(draft.savedAt)}.`;

  const restoreBtn = document.createElement("button");
  restoreBtn.type = "button";
  restoreBtn.className = "ghost-btn";
  restoreBtn.textContent = "Восстановить";
  restoreBtn.addEventListener("click", () => {
    docTitleInput.value = draft.title;
    docContentInput.value = draft.content;
    docDraftHint.hidden = true;
  });

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "ghost-btn";
  dismissBtn.textContent = "Не нужно";
  dismissBtn.addEventListener("click", () => {
    clearDraft();
    docDraftHint.hidden = true;
  });

  docDraftHint.appendChild(document.createElement("br"));
  docDraftHint.appendChild(restoreBtn);
  docDraftHint.appendChild(dismissBtn);
}

docTitleInput.addEventListener("input", scheduleDraftSave);
docContentInput.addEventListener("input", scheduleDraftSave);

// --- Документы ---

function getFilteredDocuments() {
  const query = docSearchInput.value.trim().toLowerCase();
  const filtered = documents.filter((d) => {
    const matchesFolder = activeFolderId === null || d.folderId === activeFolderId;
    const matchesQuery =
      !query ||
      d.title.toLowerCase().includes(query) ||
      d.content.toLowerCase().includes(query);
    return matchesFolder && matchesQuery;
  });
  return applySort(filtered, docSortSelect.value, "title", "updatedAt");
}

function openCreateDocModal() {
  editingDocId = null;
  docModalTitle.textContent = "Новый документ";
  docForm.reset();
  docDraftHint.hidden = true;
  docDraftHint.innerHTML = "";
  renderFolderSelectOptions();
  if (activeFolderId) docFolderSelect.value = activeFolderId;
  docModalOverlay.hidden = false;
  docTitleInput.focus();
  maybeOfferDraftRestore(null);
}

function openEditDocModal(doc) {
  editingDocId = doc.id;
  docModalTitle.textContent = "Редактировать документ";
  docTitleInput.value = doc.title;
  docContentInput.value = doc.content;
  docDraftHint.hidden = true;
  docDraftHint.innerHTML = "";
  renderFolderSelectOptions();
  docFolderSelect.value = doc.folderId || "";
  docModalOverlay.hidden = false;
  docTitleInput.focus();
  maybeOfferDraftRestore(doc.id);
}

// Открывает документ из списка «Недавние» и т.п.: если он запечатан, сперва
// просит пароль, и только потом открывает на редактирование.
function openDocFromCard(doc) {
  if (doc.locked && doc._sealed) {
    openPasswordModal({
      title: "Введи пароль документа",
      label: "Пароль документа",
      confirmMode: false,
      submitLabel: "Открыть",
      onSubmit: async (password) => {
        const ok = await tryUnlockItem(doc, password);
        if (!ok) return { ok: false, message: "Неверный пароль." };
        openEditDocModal(doc);
        return { ok: true };
      },
    });
    return;
  }
  openEditDocModal(doc);
}

function closeDocModal() {
  docModalOverlay.hidden = true;
  editingDocId = null;
}

newDocBtn.addEventListener("click", openCreateDocModal);
docModalClose.addEventListener("click", closeDocModal);
docModalOverlay.addEventListener("click", (e) => {
  if (e.target === docModalOverlay) closeDocModal();
});

docForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = docTitleInput.value.trim();
  if (!title) return;

  const content = docContentInput.value;
  const folderId = docFolderSelect.value || null;
  const now = new Date().toISOString();

  if (editingDocId) {
    const doc = documents.find((d) => d.id === editingDocId);
    if (doc) {
      doc.title = title;
      doc.content = content;
      doc.folderId = folderId;
      doc.updatedAt = now;
    }
  } else {
    documents.push({
      id: generateId(),
      title,
      content,
      folderId,
      createdAt: now,
      updatedAt: now,
    });
  }

  await saveDocuments();
  clearDraft();
  closeDocModal();
  renderAll();
});

async function deleteDocument(id) {
  const doc = documents.find((d) => d.id === id);
  if (!doc) return;
  const label = doc.locked && doc._sealed ? "этот защищённый документ" : `документ «${doc.title}»`;
  if (!confirm(`Удалить ${label}? Это необратимо.`)) return;

  const cardEl = docsGridEl.querySelector(`[data-id="${id}"]`);
  const removeFromData = async () => {
    documents = documents.filter((d) => d.id !== id);
    unlockedItemKeys.delete(id);
    await saveDocuments();
    renderAll();
  };

  if (cardEl) {
    cardEl.classList.add("removing");
    cardEl.addEventListener("transitionend", removeFromData, { once: true });
    setTimeout(removeFromData, 250);
  } else {
    await removeFromData();
  }
}

// Ставит пароль на документ, который сейчас не защищён.
function promptLockDocument(doc) {
  openPasswordModal({
    title: `Защитить документ «${doc.title}»`,
    label: "Новый пароль",
    confirmMode: true,
    submitLabel: "Защитить",
    onSubmit: async (password) => {
      await lockItemWithPassword(doc, { title: doc.title, content: doc.content }, password);
      await saveDocuments();
      return { ok: true };
    },
  });
}

// Снова запечатывает документ, разблокированный в этой сессии (без удаления
// защиты — пароль остаётся прежним, просто нужно будет ввести его заново).
async function resealDocument(doc) {
  const key = unlockedItemKeys.get(doc.id);
  doc._lockedEnc = await encryptPayload({ title: doc.title, content: doc.content }, key);
  doc.title = LOCKED_DOC_PLACEHOLDER_TITLE;
  doc.content = "";
  doc._sealed = true;
  unlockedItemKeys.delete(doc.id);
  await saveDocuments();
  renderAll();
}

// Полностью снимает защиту с документа, разблокированного в этой сессии —
// дальше он шифруется только основным ключом архива, как обычный документ.
async function removeDocumentLock(doc) {
  if (!confirm("Снять пароль с этого документа? Дальше он будет защищён только общим входом в архив.")) {
    return;
  }
  delete doc.locked;
  delete doc.lockSalt;
  delete doc.lockCheck;
  delete doc._lockedEnc;
  delete doc._sealed;
  unlockedItemKeys.delete(doc.id);
  await saveDocuments();
  renderAll();
}

function createDocCard(doc) {
  const card = document.createElement("div");
  card.className = "doc-card";
  card.dataset.id = doc.id;

  const sealed = doc.locked && doc._sealed;
  const unlockedNow = doc.locked && !doc._sealed;

  const top = document.createElement("div");
  top.className = "card-top";

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = doc.title;

  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (sealed) {
    const unlockBtn = document.createElement("button");
    unlockBtn.type = "button";
    unlockBtn.className = "icon-btn";
    unlockBtn.textContent = "🔒";
    unlockBtn.title = "Открыть паролем";
    unlockBtn.setAttribute("aria-label", "Открыть документ паролем");
    unlockBtn.addEventListener("click", () => openDocFromCard(doc));
    actions.appendChild(unlockBtn);
  } else {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn";
    editBtn.textContent = "✎";
    editBtn.setAttribute("aria-label", "Редактировать");
    editBtn.addEventListener("click", () => openEditDocModal(doc));
    actions.appendChild(editBtn);

    const lockBtn = document.createElement("button");
    lockBtn.type = "button";
    lockBtn.className = "icon-btn";
    lockBtn.textContent = unlockedNow ? "🔓" : "🔒";
    lockBtn.title = unlockedNow ? "Снова запечатать" : "Защитить паролем";
    lockBtn.setAttribute("aria-label", lockBtn.title);
    lockBtn.addEventListener("click", () => {
      if (unlockedNow) {
        resealDocument(doc);
      } else {
        promptLockDocument(doc);
      }
    });
    actions.appendChild(lockBtn);

    if (unlockedNow) {
      const removeLockBtn = document.createElement("button");
      removeLockBtn.type = "button";
      removeLockBtn.className = "icon-btn";
      removeLockBtn.textContent = "⊘";
      removeLockBtn.title = "Снять пароль совсем";
      removeLockBtn.setAttribute("aria-label", "Снять пароль с документа");
      removeLockBtn.addEventListener("click", () => removeDocumentLock(doc));
      actions.appendChild(removeLockBtn);
    }
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "icon-btn delete";
  deleteBtn.textContent = "🗑";
  deleteBtn.setAttribute("aria-label", "Удалить");
  deleteBtn.addEventListener("click", () => deleteDocument(doc.id));
  actions.appendChild(deleteBtn);

  top.appendChild(title);
  top.appendChild(actions);

  const snippet = document.createElement("p");
  snippet.className = "card-snippet";
  snippet.textContent = sealed ? "Содержимое защищено паролем." : doc.content || "Без содержания";

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const dates = document.createElement("span");
  dates.textContent = `Создан: ${formatDate(doc.createdAt)} · Изменён: ${formatDate(doc.updatedAt)}`;
  meta.appendChild(dates);

  card.appendChild(top);
  card.appendChild(snippet);
  card.appendChild(meta);

  if (!sealed) {
    const folderSelect = createFolderMiniSelect(doc, async (newFolderId) => {
      doc.folderId = newFolderId;
      await saveDocuments();
      renderAll();
    });
    card.appendChild(folderSelect);
  }

  return card;
}

function renderDocs() {
  const filtered = getFilteredDocuments();
  docsGridEl.innerHTML = "";
  filtered.forEach((doc) => docsGridEl.appendChild(createDocCard(doc)));
  docsEmptyEl.hidden = filtered.length !== 0;

  if (activeFolderId) {
    docFolderChip.hidden = false;
    docFolderChipLabel.textContent = `Папка: ${getFolderName(activeFolderId)}`;
  } else {
    docFolderChip.hidden = true;
  }
}

docSearchInput.addEventListener("input", renderDocs);
docSortSelect.addEventListener("change", renderDocs);
docFolderChipClear.addEventListener("click", () => setActiveFolder(null));

// --- Файлы ---

function getFilteredFiles() {
  const query = fileSearchInput.value.trim().toLowerCase();
  const filtered = files.filter((f) => {
    const matchesFolder = activeFolderId === null || f.folderId === activeFolderId;
    const matchesQuery = !query || f.name.toLowerCase().includes(query);
    return matchesFolder && matchesQuery;
  });
  return applySort(filtered, fileSortSelect.value, "name", "createdAt");
}

uploadFileBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;

  const limit = maxFileSize();
  if (file.size > limit) {
    alert(
      `Файл слишком большой (${formatBytes(file.size)}). ` +
        `Максимальный размер — ${formatBytes(limit)}.`
    );
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    files.push({
      id: generateId(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      dataUrl,
      folderId: activeFolderId,
      createdAt: new Date().toISOString(),
    });

    if (await saveFiles()) {
      renderAll();
    } else {
      files.pop();
    }
  } catch (error) {
    console.error("Не удалось прочитать файл:", error);
    alert("Не удалось загрузить файл. Попробуй другой файл.");
  }
});

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function deleteFile(id) {
  const file = files.find((f) => f.id === id);
  if (!file) return;
  const label = file.locked && file._sealed ? "этот защищённый файл" : `файл «${file.name}»`;
  if (!confirm(`Удалить ${label}? Это необратимо.`)) return;

  const cardEl = filesGridEl.querySelector(`[data-id="${id}"]`);
  const removeFromData = async () => {
    files = files.filter((f) => f.id !== id);
    unlockedItemKeys.delete(id);
    await saveFiles();
    renderAll();
  };

  if (cardEl) {
    cardEl.classList.add("removing");
    cardEl.addEventListener("transitionend", removeFromData, { once: true });
    setTimeout(removeFromData, 250);
  } else {
    await removeFromData();
  }
}

function promptLockFile(file) {
  openPasswordModal({
    title: `Защитить файл «${file.name}»`,
    label: "Новый пароль",
    confirmMode: true,
    submitLabel: "Защитить",
    onSubmit: async (password) => {
      await lockItemWithPassword(file, { name: file.name, dataUrl: file.dataUrl }, password);
      await saveFiles();
      return { ok: true };
    },
  });
}

async function resealFile(file) {
  const key = unlockedItemKeys.get(file.id);
  file._lockedEnc = await encryptPayload({ name: file.name, dataUrl: file.dataUrl }, key);
  file.name = LOCKED_FILE_PLACEHOLDER_NAME;
  file.dataUrl = "";
  file._sealed = true;
  unlockedItemKeys.delete(file.id);
  await saveFiles();
  renderAll();
}

async function removeFileLock(file) {
  if (!confirm("Снять пароль с этого файла? Дальше он будет защищён только общим входом в архив.")) {
    return;
  }
  delete file.locked;
  delete file.lockSalt;
  delete file.lockCheck;
  delete file._lockedEnc;
  delete file._sealed;
  unlockedItemKeys.delete(file.id);
  await saveFiles();
  renderAll();
}

function promptUnlockFile(file) {
  openPasswordModal({
    title: `Открыть файл «${file.name === LOCKED_FILE_PLACEHOLDER_NAME ? "защищённый файл" : file.name}»`,
    label: "Пароль файла",
    confirmMode: false,
    submitLabel: "Открыть",
    onSubmit: async (password) => {
      const ok = await tryUnlockItem(file, password);
      if (!ok) return { ok: false, message: "Неверный пароль." };
      return { ok: true };
    },
  });
}

function canPreviewInBrowser(file) {
  return (
    file.mimeType.startsWith("image/") ||
    file.mimeType === "application/pdf" ||
    file.mimeType.startsWith("text/")
  );
}

function createFileCard(file) {
  const card = document.createElement("div");
  card.className = "file-card";
  card.dataset.id = file.id;

  const sealed = file.locked && file._sealed;
  const unlockedNow = file.locked && !file._sealed;

  const top = document.createElement("div");
  top.className = "card-top";

  const titleWrap = document.createElement("span");
  titleWrap.className = "card-title";
  titleWrap.textContent = sealed ? file.name : `${fileIconFor(file.mimeType, file.name)} ${file.name}`;

  const actions = document.createElement("div");
  actions.className = "card-actions";

  if (sealed) {
    const unlockBtn = document.createElement("button");
    unlockBtn.type = "button";
    unlockBtn.className = "icon-btn";
    unlockBtn.textContent = "🔒";
    unlockBtn.title = "Открыть паролем";
    unlockBtn.setAttribute("aria-label", "Открыть файл паролем");
    unlockBtn.addEventListener("click", () => promptUnlockFile(file));
    actions.appendChild(unlockBtn);
  } else {
    const lockBtn = document.createElement("button");
    lockBtn.type = "button";
    lockBtn.className = "icon-btn";
    lockBtn.textContent = unlockedNow ? "🔓" : "🔒";
    lockBtn.title = unlockedNow ? "Снова запечатать" : "Защитить паролем";
    lockBtn.setAttribute("aria-label", lockBtn.title);
    lockBtn.addEventListener("click", () => {
      if (unlockedNow) {
        resealFile(file);
      } else {
        promptLockFile(file);
      }
    });
    actions.appendChild(lockBtn);

    if (unlockedNow) {
      const removeLockBtn = document.createElement("button");
      removeLockBtn.type = "button";
      removeLockBtn.className = "icon-btn";
      removeLockBtn.textContent = "⊘";
      removeLockBtn.title = "Снять пароль совсем";
      removeLockBtn.setAttribute("aria-label", "Снять пароль с файла");
      removeLockBtn.addEventListener("click", () => removeFileLock(file));
      actions.appendChild(removeLockBtn);
    }
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "icon-btn delete";
  deleteBtn.textContent = "🗑";
  deleteBtn.setAttribute("aria-label", "Удалить файл");
  deleteBtn.addEventListener("click", () => deleteFile(file.id));
  actions.appendChild(deleteBtn);

  top.appendChild(titleWrap);
  top.appendChild(actions);
  card.appendChild(top);

  if (!sealed && file.mimeType.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "file-thumb";
    img.src = file.dataUrl;
    img.alt = file.name;
    card.appendChild(img);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.innerHTML = sealed
    ? `<span>Защищено паролем</span><span>${formatDate(file.createdAt)}</span>`
    : `<span>${formatBytes(file.size)}</span><span>${formatDate(file.createdAt)}</span>`;
  card.appendChild(meta);

  if (!sealed) {
    const footer = document.createElement("div");
    footer.className = "card-footer";

    if (canPreviewInBrowser(file)) {
      const viewBtn = document.createElement("a");
      viewBtn.className = "ghost-btn";
      viewBtn.href = file.dataUrl;
      viewBtn.target = "_blank";
      viewBtn.rel = "noopener noreferrer";
      viewBtn.textContent = "Открыть";
      footer.appendChild(viewBtn);
    }

    const downloadBtn = document.createElement("a");
    downloadBtn.className = "ghost-btn";
    downloadBtn.href = file.dataUrl;
    downloadBtn.download = file.name;
    downloadBtn.textContent = "Скачать";
    footer.appendChild(downloadBtn);

    card.appendChild(footer);

    const folderSelect = createFolderMiniSelect(file, async (newFolderId) => {
      file.folderId = newFolderId;
      await saveFiles();
      renderAll();
    });
    card.appendChild(folderSelect);
  }

  return card;
}

function renderFiles() {
  const filtered = getFilteredFiles();
  filesGridEl.innerHTML = "";
  filtered.forEach((file) => filesGridEl.appendChild(createFileCard(file)));
  filesEmptyEl.hidden = filtered.length !== 0;

  if (activeFolderId) {
    fileFolderChip.hidden = false;
    fileFolderChipLabel.textContent = `Папка: ${getFolderName(activeFolderId)}`;
  } else {
    fileFolderChip.hidden = true;
  }
}

fileSearchInput.addEventListener("input", renderFiles);
fileSortSelect.addEventListener("change", renderFiles);
fileFolderChipClear.addEventListener("click", () => setActiveFolder(null));

// --- Общий рендер ---

function renderAll() {
  renderHome();
  renderFolders();
  renderDocs();
  renderFiles();
}

// --- Закрытие модалок по Escape ---

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!docModalOverlay.hidden) closeDocModal();
  if (!folderModalOverlay.hidden) closeFolderModal();
  if (!passwordModalOverlay.hidden) closePasswordModal();
});

// --- Инициализация: получаем ключ сессии, готовим хранилище, расшифровываем архив ---

async function init() {
  encryptionKey = await getArchiveEncryptionKey();

  if (!encryptionKey) {
    // Доступ не был открыт настоящим кодом (например, флаг сессии подделан
    // вручную через консоль) — ключа для расшифровки нет, показывать нечего.
    lockGoals();
    window.location.replace("index.html");
    return;
  }

  // Готовим хранилище: пробуем IndexedDB, при неудаче остаёмся на
  // LocalStorage (как было раньше) — архив в любом случае должен открыться.
  try {
    idbInstance = await openDatabase();
    await migrateLocalStorageToIndexedDB(idbInstance);
    storageMode = "indexeddb";
  } catch (error) {
    console.error("IndexedDB недоступен или миграция не удалась, используем LocalStorage:", error);
    storageMode = "localStorage";
  }

  try {
    const [docsResult, filesResult, foldersResult] = await Promise.all([
      loadDocumentsFromStorage(),
      loadFilesFromStorage(),
      loadFoldersFromStorage(),
    ]);

    documents = docsResult.items;
    files = filesResult.items;
    folders = foldersResult.items;

    // Если нашлись данные в старом незашифрованном формате — сразу
    // пересохраняем их в зашифрованном виде, чтобы они больше не лежали
    // в хранилище открытым текстом.
    if (docsResult.needsMigration) await saveDocuments();
    if (filesResult.needsMigration) await saveFiles();
    if (foldersResult.needsMigration) await saveFolders();
  } catch (error) {
    console.error("Не удалось расшифровать архив:", error);
    alert(
      "Не удалось открыть архив: не получилось расшифровать данные. " +
        "Возможно, доступ был подделан вручную. Войди через код доступа ещё раз."
    );
    lockGoals();
    window.location.replace("index.html");
    return;
  }

  renderAll();
}

init();
