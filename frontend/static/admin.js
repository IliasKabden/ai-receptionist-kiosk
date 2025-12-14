// Backend runs at 8001 (see run_kiosk_desktop.ps1 output)
const API_BASE = "http://localhost:8001";

async function loadConfig() {
  const res = await fetch(`${API_BASE}/api/config`);
  const cfg = await res.json();

  document.getElementById("language").value = cfg.language || "kk";
  document.getElementById("extra_prompt").value = cfg.extra_prompt || "";
  document.getElementById("avatar_mode").value = cfg.avatar_mode || "video";
  document.getElementById("avatar_image_path").value = cfg.avatar_image_path || "";
  document.getElementById("subtitles_enabled").checked = !!cfg.subtitles_enabled;

  const p = cfg.presence || {};
  document.getElementById("presence_sensitivity").value = (p.sensitivity ?? 0.7);
  const roi = p.roi || {};
  document.getElementById("roi_top").value = Math.round((roi.top ?? 0) * 100);
  document.getElementById("roi_left").value = Math.round((roi.left ?? 0) * 100);
  document.getElementById("roi_width").value = Math.round((roi.width ?? 1) * 100);
  document.getElementById("roi_height").value = Math.round((roi.height ?? 1) * 100);
  document.getElementById("attention_tolerance").value = (p.attentionTolerancePx ?? 80);
}

async function saveConfig() {
  const payload = {
    language: document.getElementById("language").value,
    extra_prompt: document.getElementById("extra_prompt").value,
    avatar_mode: document.getElementById("avatar_mode").value,
    avatar_image_path: document.getElementById("avatar_image_path").value,
    subtitles_enabled: document.getElementById("subtitles_enabled").checked,
    presence: {
      sensitivity: parseFloat(document.getElementById("presence_sensitivity").value),
      roi: {
        top: parseFloat(document.getElementById("roi_top").value) / 100,
        left: parseFloat(document.getElementById("roi_left").value) / 100,
        width: parseFloat(document.getElementById("roi_width").value) / 100,
        height: parseFloat(document.getElementById("roi_height").value) / 100,
      },
      attentionTolerancePx: parseInt(document.getElementById("attention_tolerance").value, 10),
    }
  };

  const res = await fetch(`${API_BASE}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  await res.json();
  const status = document.getElementById("status");
  status.textContent = "Сохранено";
  setTimeout(() => (status.textContent = ""), 2000);
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadConfig();
  document.getElementById("saveBtn").addEventListener("click", saveConfig);
});
