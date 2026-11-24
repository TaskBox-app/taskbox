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
// Подробности и честные ограничения — в README.md.

const SA_DOCS_KEY = "secret-archive-documents";
const SA_FILES_KEY = "secret-archive-files";
const SA_FOLDERS_KEY = "secret-archive-folders";
const SA_STORAGE_MODE_KEY = "secret-archive-storage-mode";
const SA_MIGRATION_BACKUP_AT_KEY = "secret-archive-migration-backup-at";

const IDB_NAME = "secret-archive-db";
const IDB_VERSION = 1;
const IDB_STORES = ["documents", "files", "folders"];

// Старый раздел Goals убран из проекта — подчищаем его данные, если остались.
localStorage.removeItem("taskbox-goals");

const MAX_FILE_SIZE_LOCALSTORAGE = 2 * 1024 * 1024; // 2 МБ — старый лимит для LocalStorage
const MAX_FILE_SIZE_INDEXEDDB = 25 * 1024 * 1024; // 25 МБ — IndexedDB на порядки просторнее

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

// --- Шифрование содержимого ---

async function encryptPayload(payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, encryptionKey, data);
  return { iv: arrayBufferToBase64(iv), data: arrayBufferToBase64(cipherBuffer) };
}

async function decryptPayload(enc) {
  const iv = new Uint8Array(base64ToArrayBuffer(enc.iv));
  const cipherBuffer = base64ToArrayBuffer(enc.data);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, encryptionKey, cipherBuffer);
  return JSON.parse(new TextDecoder().decode(plainBuffer));
}

// Загружает и расшифровывает коллекцию; элементы в старом (незашифрованном)
// формате подхватывает как есть и помечает на повторное сохранение — так
// старые данные не теряются при любом обновлении формата хранения.
async function loadEncryptedCollection(storeName, localStorageKey) {
  const raw = await loadRawCollection(storeName, localStorageKey);
  let needsMigration = false;

  const items = await Promise.all(
    raw.map(async (item) => {
      if (!item.enc) {
        needsMigration = true;
        const { ...rest } = item;
        return rest;
      }
      const { enc, ...meta } = item;
      const secret = await decryptPayload(enc);
      return { ...meta, ...secret };
    })
  );

  return { items, needsMigration };
}

async function saveEncryptedCollection(storeName, localStorageKey, items, secretFieldNames) {
  const encrypted = await Promise.all(
    items.map(async (item) => {
      const meta = {};
      const secret = {};
      Object.keys(item).forEach((field) => {
        if (secretFieldNames.includes(field)) {
          secret[field] = item[field];
        } else {
          meta[field] = item[field];
        }
      });
      meta.enc = await encryptPayload(secret);
      return meta;
    })
  );
  await saveRawCollection(storeName, localStorageKey, encrypted);
}

async function saveDocuments() {
  await saveEncryptedCollection("documents", SA_DOCS_KEY, documents, ["title", "content"]);
}

async function saveFolders() {
  await saveEncryptedCollection("folders", SA_FOLDERS_KEY, folders, ["name"]);
}

async function saveFiles() {
  try {
    await saveEncryptedCollection("files", SA_FILES_KEY, files, ["name", "dataUrl"]);
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
// другом устройстве будет расшифрован этот файл при импорте). Формат файла
// не зависит от того, лежат ли данные в IndexedDB или в LocalStorage —
// экспорт/импорт одинаково совместимы в обе стороны.

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

// Расшифровывает импортируемые записи текущим ключом сессии.
// Запись, которую не получилось расшифровать (например, бэкап сделан
// с другим кодом доступа), пропускается, а не ломает весь импорт.
async function decryptImportedArray(rawArray) {
  const items = [];
  let failed = 0;

  for (const item of rawArray) {
    try {
      if (!item.enc) {
        items.push(item);
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
    decryptImportedArray(payload.documents),
    decryptImportedArray(payload.files),
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

function renderFolderNode(folder, depth, container) {
  const hasChildren = folderHasChildren(folder.id);
  const isExpanded = expandedFolderIds.has(folder.id);

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
    item.addEventListener("click", () => openEditDocModal(doc));

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
  renderFolderSelectOptions();
  if (activeFolderId) docFolderSelect.value = activeFolderId;
  docModalOverlay.hidden = false;
  docTitleInput.focus();
}

function openEditDocModal(doc) {
  editingDocId = doc.id;
  docModalTitle.textContent = "Редактировать документ";
  docTitleInput.value = doc.title;
  docContentInput.value = doc.content;
  renderFolderSelectOptions();
  docFolderSelect.value = doc.folderId || "";
  docModalOverlay.hidden = false;
  docTitleInput.focus();
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
  closeDocModal();
  renderAll();
});

async function deleteDocument(id) {
  const doc = documents.find((d) => d.id === id);
  if (!doc) return;
  if (!confirm(`Удалить документ «${doc.title}»? Это необратимо.`)) return;

  const cardEl = docsGridEl.querySelector(`[data-id="${id}"]`);
  const removeFromData = async () => {
    documents = documents.filter((d) => d.id !== id);
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

function createDocCard(doc) {
  const card = document.createElement("div");
  card.className = "doc-card";
  card.dataset.id = doc.id;

  const top = document.createElement("div");
  top.className = "card-top";

  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = doc.title;

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "icon-btn";
  editBtn.textContent = "✎";
  editBtn.setAttribute("aria-label", "Редактировать");
  editBtn.addEventListener("click", () => openEditDocModal(doc));

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "icon-btn delete";
  deleteBtn.textContent = "🗑";
  deleteBtn.setAttribute("aria-label", "Удалить");
  deleteBtn.addEventListener("click", () => deleteDocument(doc.id));

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);
  top.appendChild(title);
  top.appendChild(actions);

  const snippet = document.createElement("p");
  snippet.className = "card-snippet";
  snippet.textContent = doc.content || "Без содержания";

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const dates = document.createElement("span");
  dates.textContent = `Создан: ${formatDate(doc.createdAt)} · Изменён: ${formatDate(doc.updatedAt)}`;
  meta.appendChild(dates);

  const folderSelect = createFolderMiniSelect(doc, async (newFolderId) => {
    doc.folderId = newFolderId;
    await saveDocuments();
    renderAll();
  });

  card.appendChild(top);
  card.appendChild(snippet);
  card.appendChild(meta);
  card.appendChild(folderSelect);

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
  if (!confirm(`Удалить файл «${file.name}»? Это необратимо.`)) return;

  const cardEl = filesGridEl.querySelector(`[data-id="${id}"]`);
  const removeFromData = async () => {
    files = files.filter((f) => f.id !== id);
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

  const top = document.createElement("div");
  top.className = "card-top";

  const titleWrap = document.createElement("span");
  titleWrap.className = "card-title";
  titleWrap.textContent = `${fileIconFor(file.mimeType, file.name)} ${file.name}`;

  const actions = document.createElement("div");
  actions.className = "card-actions";

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

  if (file.mimeType.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "file-thumb";
    img.src = file.dataUrl;
    img.alt = file.name;
    card.appendChild(img);
  }

  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.innerHTML = `<span>${formatBytes(file.size)}</span><span>${formatDate(file.createdAt)}</span>`;
  card.appendChild(meta);

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
      loadEncryptedCollection("documents", SA_DOCS_KEY),
      loadEncryptedCollection("files", SA_FILES_KEY),
      loadEncryptedCollection("folders", SA_FOLDERS_KEY),
    ]);

    documents = docsResult.items;
    files = filesResult.items;
    folders = foldersResult.items.map((f) => ({ parentId: null, ...f }));

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
