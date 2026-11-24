// --- TaskBox: простой менеджер задач с сохранением в LocalStorage ---

const STORAGE_KEY = "taskbox-tasks";

const form = document.getElementById("task-form");
const input = document.getElementById("task-input");
const taskList = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const totalCountEl = document.getElementById("total-count");
const activeCountEl = document.getElementById("active-count");
const completedCountEl = document.getElementById("completed-count");
const filterButtons = document.querySelectorAll(".filter-btn");

let tasks = loadTasks();
let currentFilter = "all";

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    console.error("Не удалось прочитать задачи из LocalStorage:", error);
    return [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function addTask(text) {
  const trimmed = text.trim();
  if (!trimmed) return;

  tasks.push({
    id: generateId(),
    text: trimmed,
    completed: false,
  });

  saveTasks();
  render();
}

function toggleTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (task) {
    task.completed = !task.completed;
    saveTasks();
    render();
  }
}

function deleteTask(id) {
  const itemEl = taskList.querySelector(`[data-id="${id}"]`);

  const removeFromData = () => {
    tasks = tasks.filter((t) => t.id !== id);
    saveTasks();
    render();
  };

  if (itemEl) {
    itemEl.classList.add("removing");
    itemEl.addEventListener("transitionend", removeFromData, { once: true });
    // Запасной вариант, если transitionend не сработает
    setTimeout(removeFromData, 250);
  } else {
    removeFromData();
  }
}

function getFilteredTasks() {
  if (currentFilter === "active") {
    return tasks.filter((t) => !t.completed);
  }
  if (currentFilter === "completed") {
    return tasks.filter((t) => t.completed);
  }
  return tasks;
}

function updateStats() {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.completed).length;
  const active = total - completed;

  totalCountEl.textContent = `Всего: ${total}`;
  activeCountEl.textContent = `Активных: ${active}`;
  completedCountEl.textContent = `Выполнено: ${completed}`;
}

function createTaskElement(task) {
  const li = document.createElement("li");
  li.className = "task-item" + (task.completed ? " completed" : "");
  li.dataset.id = task.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-checkbox";
  checkbox.checked = task.completed;
  checkbox.addEventListener("change", () => toggleTask(task.id));

  const span = document.createElement("span");
  span.className = "task-text";
  span.textContent = task.text;

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "delete-btn";
  deleteBtn.textContent = "🗑";
  deleteBtn.setAttribute("aria-label", "Удалить задачу");
  deleteBtn.addEventListener("click", () => deleteTask(task.id));

  li.appendChild(checkbox);
  li.appendChild(span);
  li.appendChild(deleteBtn);

  return li;
}

function render() {
  const filtered = getFilteredTasks();

  taskList.innerHTML = "";
  filtered.forEach((task) => {
    taskList.appendChild(createTaskElement(task));
  });

  emptyState.classList.toggle("visible", filtered.length === 0);

  if (filtered.length === 0) {
    if (tasks.length === 0) {
      emptyState.textContent = "Задач пока нет. Добавь первую! ✨";
    } else if (currentFilter === "active") {
      emptyState.textContent = "Нет активных задач.";
    } else if (currentFilter === "completed") {
      emptyState.textContent = "Нет выполненных задач.";
    }
  }

  updateStats();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  addTask(input.value);
  input.value = "";
  input.focus();
});

filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    filterButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    render();
  });
});

render();
