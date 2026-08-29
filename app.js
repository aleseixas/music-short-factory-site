const ui = {
  runtimeAlert: document.querySelector("#runtime-alert"),
  environmentBadge: document.querySelector("#environment-badge"),
  disconnectedView: document.querySelector("#disconnected-view"),
  connectedView: document.querySelector("#connected-view"),
  connectLink: document.querySelector("#connect-link"),
  accountAvatar: document.querySelector("#account-avatar"),
  accountAvatarFallback: document.querySelector("#account-avatar-fallback"),
  accountName: document.querySelector("#account-name"),
  accountScopes: document.querySelector("#account-scopes"),
  disconnectButton: document.querySelector("#disconnect-button"),
  deleteButton: document.querySelector("#delete-button"),
  fileInput: document.querySelector("#video-file"),
  fileLimit: document.querySelector("#file-limit"),
  previewWrap: document.querySelector("#video-preview-wrap"),
  preview: document.querySelector("#video-preview"),
  videoName: document.querySelector("#video-name"),
  videoSize: document.querySelector("#video-size"),
  videoDuration: document.querySelector("#video-duration"),
  consent: document.querySelector("#upload-consent"),
  uploadButton: document.querySelector("#upload-button"),
  uploadProgressWrap: document.querySelector("#upload-progress-wrap"),
  uploadProgress: document.querySelector("#upload-progress"),
  uploadProgressLabel: document.querySelector("#upload-progress-label"),
  uploadProgressValue: document.querySelector("#upload-progress-value"),
  statusPanel: document.querySelector("#status-panel"),
  statusDescription: document.querySelector("#status-description"),
  statusValue: document.querySelector("#status-value"),
  statusDot: document.querySelector("#status-dot"),
  publishId: document.querySelector("#publish-id"),
  refreshStatusButton: document.querySelector("#refresh-status-button"),
  nextStep: document.querySelector("#next-step")
};

const appState = {
  session: null,
  file: null,
  previewUrl: null,
  uploading: false,
  pollTimer: null
};

const terminalStatuses = new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE", "FAILED"]);
const inboxStatuses = new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"]);
const unresolvedTransferStatuses = new Set([
  "UPLOADING",
  "TRANSFER_UNCONFIRMED",
  "PROCESSING_UPLOAD"
]);

function showAlert(message, type = "info") {
  ui.runtimeAlert.textContent = message;
  ui.runtimeAlert.className = `app-alert app-alert-${type}`;
  ui.runtimeAlert.hidden = false;
}

function hideAlert() {
  ui.runtimeAlert.hidden = true;
}

async function requestJson(url, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...headers }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || `Request failed (${response.status}).`);
    error.code = body?.error?.code || "request_failed";
    throw error;
  }
  return body;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "Unknown";
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function setProgressStep(name, active) {
  const item = document.querySelector(`[data-progress-step="${name}"]`);
  if (item) item.classList.toggle("is-complete", active);
}

function updateUploadAvailability() {
  const connected = Boolean(appState.session?.connected);
  const unresolvedTransfer = unresolvedTransferStatuses.has(
    appState.session?.lastPublish?.status,
  );
  const ready = connected && appState.file && ui.consent.checked && !appState.uploading && !unresolvedTransfer;
  ui.uploadButton.disabled = !ready;
  ui.fileInput.disabled = !connected || appState.uploading || unresolvedTransfer;
  ui.consent.disabled = !connected || !appState.file || appState.uploading || unresolvedTransfer;
  setProgressStep("connect", connected);
  setProgressStep("preview", Boolean(appState.file));
  setProgressStep("confirm", Boolean(appState.file && ui.consent.checked));
}

function renderConnection() {
  const session = appState.session;
  const configured = Boolean(session?.configured);
  const connected = Boolean(session?.connected);

  ui.environmentBadge.textContent = configured ? "Secure backend configured" : "Setup required";
  ui.environmentBadge.classList.toggle("is-ready", configured);
  ui.disconnectedView.hidden = connected;
  ui.connectedView.hidden = !connected;

  if (!configured) {
    ui.connectLink.removeAttribute("href");
    ui.connectLink.setAttribute("aria-disabled", "true");
    showAlert("The secure creator-app backend is not configured on this domain. Deploy the Node service and add the TikTok Sandbox environment variables before connecting an account.", "warning");
  } else {
    ui.connectLink.href = "/auth/tiktok";
    ui.connectLink.removeAttribute("aria-disabled");
  }

  if (connected) {
    const profile = session.profile || {};
    ui.accountName.textContent = profile.displayName || "Authorized TikTok account";
    ui.accountScopes.textContent = `Authorized access: ${(session.scopes || []).join(", ")}`;
    if (profile.avatarUrl) {
      ui.accountAvatar.src = profile.avatarUrl;
      ui.accountAvatar.alt = `${ui.accountName.textContent} profile image`;
      ui.accountAvatar.hidden = false;
      ui.accountAvatarFallback.hidden = true;
    } else {
      ui.accountAvatar.hidden = true;
      ui.accountAvatarFallback.hidden = false;
    }
  }

  const maxBytes = session?.limits?.maxUploadBytes;
  ui.fileLimit.textContent = connected
    ? `Video only. Maximum size for this deployment: ${formatBytes(maxBytes)}.`
    : "Connect TikTok before selecting a file.";
  updateUploadAvailability();
}

function renderStatus(publish) {
  if (!publish?.publishId) {
    ui.statusPanel.hidden = true;
    return;
  }

  const status = publish.status || "PROCESSING_UPLOAD";
  const messages = {
    UPLOADING: "The confirmed video is being transferred to TikTok.",
    PROCESSING_UPLOAD: "TikTok received the bytes and is processing the draft.",
    TRANSFER_UNCONFIRMED: "The transfer response was interrupted. The app will check TikTok before you try again.",
    SEND_TO_USER_INBOX: "The draft was delivered to your TikTok inbox. Continue in the TikTok app.",
    PUBLISH_COMPLETE: "TikTok reports that the creator completed the publishing flow.",
    FAILED: publish.failReason ? `TikTok could not complete the transfer: ${publish.failReason}.` : "TikTok could not complete the transfer."
  };

  ui.statusPanel.hidden = false;
  ui.statusValue.textContent = status.replaceAll("_", " ");
  ui.statusDescription.textContent = messages[status] || "TikTok is processing the request.";
  ui.publishId.textContent = `Reference: ${publish.publishId}`;
  ui.statusDot.dataset.status = status;
  ui.statusDot.classList.toggle("is-success", inboxStatuses.has(status));
  ui.statusDot.classList.toggle("is-error", status === "FAILED");
  ui.nextStep.hidden = !inboxStatuses.has(status);
  setProgressStep("complete", inboxStatuses.has(status));
}

function scheduleStatusPoll() {
  clearTimeout(appState.pollTimer);
  const status = appState.session?.lastPublish?.status;
  if (!appState.session?.connected || !appState.session?.lastPublish?.publishId || terminalStatuses.has(status)) return;
  appState.pollTimer = setTimeout(refreshStatus, 5000);
}

async function refreshStatus() {
  if (!appState.session?.connected || !appState.session?.lastPublish?.publishId) return;
  try {
    const publishId = encodeURIComponent(appState.session.lastPublish.publishId);
    const result = await requestJson(`/api/publish/status?publishId=${publishId}`);
    appState.session.lastPublish = result.publish;
    renderStatus(result.publish);
    updateUploadAvailability();
    scheduleStatusPoll();
  } catch (error) {
    showAlert(error.message, "error");
  }
}

function resetSelectedFile() {
  if (appState.previewUrl) URL.revokeObjectURL(appState.previewUrl);
  appState.previewUrl = null;
  appState.file = null;
  ui.fileInput.value = "";
  ui.preview.removeAttribute("src");
  ui.preview.load();
  ui.previewWrap.hidden = true;
  ui.consent.checked = false;
  updateUploadAvailability();
}

function validateFile(file) {
  const allowed = appState.session?.limits?.allowedMimeTypes || ["video/mp4", "video/quicktime", "video/webm"];
  const maxBytes = appState.session?.limits?.maxUploadBytes || 0;
  if (!allowed.includes(file.type)) throw new Error("Choose an MP4, MOV, or WebM video.");
  if (!file.size) throw new Error("The selected video is empty.");
  if (maxBytes && file.size > maxBytes) throw new Error(`This video exceeds the ${formatBytes(maxBytes)} limit for this deployment.`);
}

function selectFile(file) {
  resetSelectedFile();
  if (!file) return;
  try {
    validateFile(file);
    appState.file = file;
    appState.previewUrl = URL.createObjectURL(file);
    ui.preview.src = appState.previewUrl;
    ui.previewWrap.hidden = false;
    ui.videoName.textContent = file.name;
    ui.videoSize.textContent = formatBytes(file.size);
    ui.videoDuration.textContent = "Reading…";
    ui.preview.addEventListener("loadedmetadata", () => {
      ui.videoDuration.textContent = formatDuration(ui.preview.duration);
    }, { once: true });
    hideAlert();
  } catch (error) {
    showAlert(error.message, "error");
  }
  updateUploadAvailability();
}

function uploadSelectedFile() {
  if (!appState.file || !appState.session?.connected || !ui.consent.checked || appState.uploading) return;
  appState.uploading = true;
  updateUploadAvailability();
  ui.uploadProgressWrap.hidden = false;
  ui.uploadProgress.value = 0;
  ui.uploadProgressValue.textContent = "0%";
  ui.uploadProgressLabel.textContent = "Uploading securely to the server";
  hideAlert();

  const formData = new FormData();
  formData.append("video", appState.file, appState.file.name);
  formData.append("consentConfirmed", "true");
  const request = new XMLHttpRequest();
  request.open("POST", "/api/upload");
  request.responseType = "json";
  request.withCredentials = true;
  request.setRequestHeader("Accept", "application/json");
  request.setRequestHeader("X-CSRF-Token", appState.session.csrfToken);

  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
    ui.uploadProgress.value = percent;
    ui.uploadProgressValue.textContent = `${percent}%`;
    if (percent >= 99) ui.uploadProgressLabel.textContent = "Transferring the confirmed video to TikTok";
  });

  request.addEventListener("load", () => {
    appState.uploading = false;
    if (request.status >= 200 && request.status < 300 && request.response?.publish) {
      ui.uploadProgress.value = 100;
      ui.uploadProgressValue.textContent = "100%";
      ui.uploadProgressLabel.textContent = "Transfer accepted by TikTok";
      appState.session.lastPublish = request.response.publish;
      renderStatus(request.response.publish);
      resetSelectedFile();
      scheduleStatusPoll();
      return;
    }
    const message = request.response?.error?.message || `Upload failed (${request.status}).`;
    showAlert(message, "error");
    updateUploadAvailability();
    void loadSession();
  });

  request.addEventListener("error", () => {
    appState.uploading = false;
    showAlert("The upload could not reach the secure backend. Try again when the connection is available.", "error");
    updateUploadAvailability();
    void loadSession();
  });

  request.send(formData);
}

async function disconnect(deleteData = false) {
  const question = deleteData
    ? "Delete the server-side connection data for this browser session and revoke TikTok access?"
    : "Disconnect this TikTok account and revoke its authorization?";
  if (!window.confirm(question)) return;

  try {
    const endpoint = deleteData ? "/api/delete-data" : "/api/disconnect";
    const result = await requestJson(endpoint, { method: "POST", headers: { "X-CSRF-Token": appState.session.csrfToken } });
    resetSelectedFile();
    await loadSession();
    if (result.authorizationRevoked === false) {
      showAlert(result.revocationNotice || "Local data was removed. Also remove the app from TikTok's connected-app settings.", "warning");
    } else {
      showAlert(deleteData ? "Connection data was deleted from this app session." : "TikTok access was revoked and the account was disconnected.", "success");
    }
  } catch (error) {
    showAlert(error.message, "error");
  }
}

async function loadSession() {
  try {
    appState.session = await requestJson("/api/session");
    renderConnection();
    renderStatus(appState.session.lastPublish);
    scheduleStatusPoll();
  } catch {
    appState.session = { configured: false, connected: false, limits: {} };
    renderConnection();
    showAlert("This page is running as a static website and cannot handle TikTok credentials. Open the deployed creator-app domain to use the real Sandbox workflow.", "warning");
  }
}

ui.fileInput.addEventListener("change", () => selectFile(ui.fileInput.files?.[0] || null));
ui.consent.addEventListener("change", updateUploadAvailability);
ui.uploadButton.addEventListener("click", uploadSelectedFile);
ui.refreshStatusButton.addEventListener("click", refreshStatus);
ui.disconnectButton.addEventListener("click", () => disconnect(false));
ui.deleteButton.addEventListener("click", () => disconnect(true));
window.addEventListener("beforeunload", () => {
  if (appState.previewUrl) URL.revokeObjectURL(appState.previewUrl);
  clearTimeout(appState.pollTimer);
});

const query = new URLSearchParams(window.location.search);
if (query.get("error")) {
  showAlert(query.get("error"), "error");
  history.replaceState({}, "", window.location.pathname);
}

loadSession();
