// --- Логика секретной кнопки входа в раздел Goals (на главной странице) ---

const secretDot = document.getElementById("secret-dot");
const secretOverlay = document.getElementById("secret-overlay");
const secretClose = document.getElementById("secret-close");
const secretForm = document.getElementById("secret-form");
const secretCodeInput = document.getElementById("secret-code-input");
const secretError = document.getElementById("secret-error");

function openSecretModal() {
  secretOverlay.hidden = false;
  secretError.hidden = true;
  secretCodeInput.value = "";
  secretCodeInput.focus();
}

function closeSecretModal() {
  secretOverlay.hidden = true;
}

secretDot.addEventListener("click", openSecretModal);
secretClose.addEventListener("click", closeSecretModal);

secretOverlay.addEventListener("click", (event) => {
  if (event.target === secretOverlay) {
    closeSecretModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !secretOverlay.hidden) {
    closeSecretModal();
  }
});

secretForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const code = secretCodeInput.value;
  if (!code.trim()) return;

  const success = await tryUnlockGoals(code);

  if (success) {
    window.location.href = "goals.html";
  } else {
    secretError.hidden = false;
    secretCodeInput.value = "";
    secretCodeInput.focus();
  }
});
