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
  modeInputs: [...document.querySelectorAll('input[name="publish-mode"]')],
  fileInput: document.querySelector("#video-file"),
  fileLimit: document.querySelector("#file-limit"),
  previewWrap: document.querySelector("#video-preview-wrap"),
  preview: document.querySelector("#video-preview"),
  videoName: document.querySelector("#video-name"),
  videoSize: document.querySelector("#video-size"),
  videoDuration: document.querySelector("#video-duration"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmDescription: document.querySelector("#confirm-description"),
  draftExplainer: document.querySelector("#draft-explainer"),
  directSettings: document.querySelector("#direct-settings"),
  directAccountName: document.querySelector("#direct-account-name"),
  directAccountLimit: document.querySelector("#direct-account-limit"),
  directRestriction: document.querySelector("#direct-restriction"),
  caption: document.querySelector("#post-caption"),
  captionCount: document.querySelector("#caption-count"),
  privacy: document.querySelector("#privacy-level"),
  privacyHelp: document.querySelector("#privacy-help"),
  allowComment: document.querySelector("#allow-comment"),
  allowDuet: document.querySelector("#allow-duet"),
  allowStitch: document.querySelector("#allow-stitch"),
  commercialContent: document.querySelector("#commercial-content"),
  commercialOptions: document.querySelector("#commercial-options"),
  brandOrganic: document.querySelector("#brand-organic"),
  brandContent: document.querySelector("#brand-content"),
  brandContentLabel: document.querySelector("#brand-content-label"),
  commercialHelp: document.querySelector("#commercial-help"),
  consent: document.querySelector("#upload-consent"),
  draftConsent: document.querySelector("#draft-consent"),
  directConsent: document.querySelector("#direct-consent"),
  musicConsent: document.querySelector("#music-consent"),
  brandPolicyConsent: document.querySelector("#brand-policy-consent"),
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
  nextStep: document.querySelector("#next-step"),
  nextStepTitle: document.querySelector("#next-step-title"),
  nextStepDescription: document.querySelector("#next-step-description"),
};

const appState = {
  session: null,
  mode: "draft",
  file: null,
  videoDurationSeconds: null,
  previewUrl: null,
  creatorInfo: null,
  creatorInfoLoading: false,
  creatorInfoRequest: 0,
  uploading: false,
  pollTimer: null,
};

const terminalStatuses = new Set([
  "SEND_TO_USER_INBOX",
  "PUBLISH_COMPLETE",
  "FAILED",
]);
const unresolvedTransferStatuses = new Set([
  "UPLOADING",
  "TRANSFER_UNCONFIRMED",
  "PROCESSING_UPLOAD",
]);
const privacyLabels = Object.freeze({
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
});

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
    headers: { Accept: "application/json", ...headers },
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
        body?.message ||
        `Request failed (${response.status}).`,
    );
    error.code = body?.error?.code || "request_failed";
    throw error;
  }
  return body;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
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

function directSettingsReady() {
  if (appState.mode !== "direct") return true;
  const creator = appState.creatorInfo;
  const duration = appState.videoDurationSeconds;
  const commercialSelectionValid =
    !ui.commercialContent.checked ||
    ui.brandOrganic.checked ||
    ui.brandContent.checked;
  return Boolean(
    creator?.directPostAllowed &&
      !appState.creatorInfoLoading &&
      ui.privacy.value &&
      Number.isFinite(duration) &&
      duration > 0 &&
      duration <= creator.maxVideoPostDurationSec &&
      commercialSelectionValid &&
      !(ui.brandContent.checked && ui.privacy.value === "SELF_ONLY"),
  );
}

function updateUploadAvailability() {
  const connected = Boolean(appState.session?.connected);
  const unresolvedTransfer = unresolvedTransferStatuses.has(
    appState.session?.lastPublish?.status,
  );
  const canConfigure = connected && !appState.uploading && !unresolvedTransfer;
  const canConfirm =
    canConfigure && Boolean(appState.file) && directSettingsReady();
  const ready = canConfirm && ui.consent.checked;

  for (const input of ui.modeInputs) input.disabled = !canConfigure;
  ui.uploadButton.disabled = !ready;
  ui.fileInput.disabled = !canConfigure;
  ui.consent.disabled = !canConfirm;
  setProgressStep("connect", connected);
  setProgressStep("preview", Boolean(appState.file));
  setProgressStep("confirm", Boolean(appState.file && ui.consent.checked));
}

function invalidateConsent() {
  ui.consent.checked = false;
  updateUploadAvailability();
}

function renderConnection() {
  const session = appState.session;
  const configured = Boolean(session?.configured);
  const connected = Boolean(session?.connected);

  ui.environmentBadge.textContent = configured
    ? "Secure backend configured"
    : "Setup required";
  ui.environmentBadge.classList.toggle("is-ready", configured);
  ui.disconnectedView.hidden = connected;
  ui.connectedView.hidden = !connected;

  if (!configured) {
    ui.connectLink.removeAttribute("href");
    ui.connectLink.setAttribute("aria-disabled", "true");
    showAlert(
      "The secure creator-app backend is not configured on this domain. Deploy the Node service and add the TikTok Sandbox environment variables before connecting an account.",
      "warning",
    );
  } else {
    ui.connectLink.href = "/auth/tiktok";
    ui.connectLink.removeAttribute("aria-disabled");
  }

  if (connected) {
    const profile = session.profile || {};
    ui.accountName.textContent =
      profile.displayName || "Authorized TikTok account";
    ui.accountScopes.textContent = `Authorized access: ${(
      session.scopes || []
    ).join(", ")}`;
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

function publishSucceeded(publish) {
  if (publish?.mode === "direct") return publish.status === "PUBLISH_COMPLETE";
  return new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"]).has(
    publish?.status,
  );
}

function renderStatus(publish) {
  if (!publish?.publishId) {
    ui.statusPanel.hidden = true;
    return;
  }

  const direct = publish.mode === "direct";
  const status = publish.status || "PROCESSING_UPLOAD";
  const messages = {
    UPLOADING: `The confirmed video is being transferred to TikTok for ${
      direct ? "Direct Post" : "draft delivery"
    }.`,
    PROCESSING_UPLOAD: direct
      ? "TikTok received the bytes and is processing the Direct Post."
      : "TikTok received the bytes and is processing the draft.",
    TRANSFER_UNCONFIRMED:
      "The transfer response was interrupted. The app will check TikTok before you try again.",
    SEND_TO_USER_INBOX:
      "The draft was delivered to your TikTok inbox. Continue in the TikTok app.",
    PUBLISH_COMPLETE: direct
      ? "TikTok reports that the Direct Post completed. It may take a few minutes to appear on the profile."
      : "TikTok reports that the creator completed the publishing flow.",
    FAILED: publish.failReason
      ? `TikTok could not complete the transfer: ${publish.failReason}.`
      : "TikTok could not complete the transfer.",
  };
  const succeeded = publishSucceeded(publish);

  ui.statusPanel.hidden = false;
  ui.statusValue.textContent = status.replaceAll("_", " ");
  ui.statusDescription.textContent =
    messages[status] || "TikTok is processing the request.";
  ui.publishId.textContent = `Reference: ${publish.publishId}`;
  ui.statusDot.dataset.status = status;
  ui.statusDot.classList.toggle("is-success", succeeded);
  ui.statusDot.classList.toggle("is-error", status === "FAILED");
  ui.nextStep.hidden = !succeeded;
  ui.nextStepTitle.textContent = direct
    ? "Direct Post completed"
    : "Continue in the TikTok app";
  ui.nextStepDescription.textContent = direct
    ? "TikTok accepted the post with the settings you confirmed. Processing and profile visibility may take a few minutes."
    : "Open the notification in your TikTok inbox. Review the draft, choose the settings TikTok makes available to your account, and publish only if you are ready.";
  setProgressStep("complete", succeeded);
}

function scheduleStatusPoll() {
  clearTimeout(appState.pollTimer);
  const status = appState.session?.lastPublish?.status;
  if (
    !appState.session?.connected ||
    !appState.session?.lastPublish?.publishId ||
    terminalStatuses.has(status)
  ) {
    return;
  }
  appState.pollTimer = setTimeout(refreshStatus, 5000);
}

async function refreshStatus() {
  if (!appState.session?.connected || !appState.session?.lastPublish?.publishId) {
    return;
  }
  try {
    const publishId = encodeURIComponent(
      appState.session.lastPublish.publishId,
    );
    const result = await requestJson(
      `/api/publish/status?publishId=${publishId}`,
    );
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
  appState.videoDurationSeconds = null;
  ui.fileInput.value = "";
  ui.preview.removeAttribute("src");
  ui.preview.load();
  ui.previewWrap.hidden = true;
  ui.consent.checked = false;
  updateUploadAvailability();
}

function validateFile(file) {
  const allowed = appState.session?.limits?.allowedMimeTypes || [
    "video/mp4",
    "video/quicktime",
    "video/webm",
  ];
  const maxBytes = appState.session?.limits?.maxUploadBytes || 0;
  if (!allowed.includes(file.type)) {
    throw new Error("Choose an MP4, MOV, or WebM video.");
  }
  if (!file.size) throw new Error("The selected video is empty.");
  if (maxBytes && file.size > maxBytes) {
    throw new Error(
      `This video exceeds the ${formatBytes(maxBytes)} limit for this deployment.`,
    );
  }
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
    ui.videoDuration.textContent = "Reading...";
    ui.preview.addEventListener(
      "loadedmetadata",
      () => {
        const duration = ui.preview.duration;
        appState.videoDurationSeconds = Number.isFinite(duration)
          ? duration
          : null;
        ui.videoDuration.textContent = formatDuration(duration);
        if (
          appState.mode === "direct" &&
          appState.creatorInfo &&
          duration > appState.creatorInfo.maxVideoPostDurationSec
        ) {
          showAlert(
            `This account accepts Direct Post videos up to ${appState.creatorInfo.maxVideoPostDurationSec} seconds.`,
            "error",
          );
        }
        updateUploadAvailability();
      },
      { once: true },
    );
    hideAlert();
  } catch (error) {
    showAlert(error.message, "error");
  }
  updateUploadAvailability();
}

function resetCreatorInfo() {
  appState.creatorInfo = null;
  appState.creatorInfoLoading = false;
  ui.directAccountName.textContent = "Loading TikTok creator settings...";
  ui.directAccountLimit.textContent = "";
  ui.directRestriction.hidden = true;
  ui.directRestriction.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select privacy";
  placeholder.selected = true;
  ui.privacy.replaceChildren(placeholder);
  ui.privacy.disabled = true;
  ui.commercialContent.checked = false;
  ui.brandOrganic.checked = false;
  ui.brandContent.checked = false;
  renderCommercialSettings();
  for (const interaction of [
    ui.allowComment,
    ui.allowDuet,
    ui.allowStitch,
  ]) {
    interaction.checked = false;
    interaction.disabled = true;
  }
  ui.consent.checked = false;
}

function renderCommercialSettings() {
  const disclosureOn = ui.commercialContent.checked;
  ui.commercialOptions.hidden = !disclosureOn;
  if (!disclosureOn) {
    ui.brandOrganic.checked = false;
    ui.brandContent.checked = false;
  }

  const privateVisibility = ui.privacy.value === "SELF_ONLY";
  ui.brandContent.disabled = privateVisibility;
  ui.brandContentLabel.classList.toggle("is-disabled", privateVisibility);
  if (privateVisibility) ui.brandContent.checked = false;

  if (disclosureOn && !ui.brandOrganic.checked && !ui.brandContent.checked) {
    ui.commercialHelp.textContent =
      "Choose Your brand, Branded content, or both before publishing.";
  } else if (ui.brandContent.checked) {
    ui.commercialHelp.textContent =
      "This video will be labeled as Paid partnership.";
  } else if (ui.brandOrganic.checked) {
    ui.commercialHelp.textContent =
      "This video will be labeled as Promotional content.";
  } else {
    ui.commercialHelp.textContent = "Disclosure is off by default.";
  }
  ui.musicConsent.hidden = ui.brandContent.checked;
  ui.brandPolicyConsent.hidden = !ui.brandContent.checked;
}

function renderCreatorInfo(creator) {
  appState.creatorInfo = creator;
  ui.directAccountName.textContent = creator.username
    ? `${creator.nickname} (@${creator.username})`
    : creator.nickname;
  ui.directAccountLimit.textContent = `Maximum video duration returned by TikTok: ${creator.maxVideoPostDurationSec} seconds.`;

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select privacy";
  placeholder.selected = true;
  ui.privacy.replaceChildren(placeholder);
  for (const value of creator.privacyLevelOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = privacyLabels[value] || value.replaceAll("_", " ");
    ui.privacy.append(option);
  }
  ui.privacy.disabled =
    !creator.directPostAllowed || creator.privacyLevelOptions.length === 0;

  ui.allowComment.checked = false;
  ui.allowDuet.checked = false;
  ui.allowStitch.checked = false;
  ui.allowComment.disabled = creator.commentDisabled;
  ui.allowDuet.disabled = creator.duetDisabled;
  ui.allowStitch.disabled = creator.stitchDisabled;

  ui.directRestriction.hidden = !creator.restrictionReason;
  ui.directRestriction.textContent = creator.restrictionReason || "";
  ui.privacyHelp.textContent = creator.unaudited
    ? "TikTok restricts this unaudited client to options allowed for private testing."
    : "Options were returned by TikTok for this connected account.";
  renderCommercialSettings();
  if (!creator.directPostAllowed) {
    showAlert(creator.restrictionReason, "warning");
  }
}

async function loadCreatorInfo() {
  if (appState.mode !== "direct" || !appState.session?.connected) return;
  const requestId = ++appState.creatorInfoRequest;
  resetCreatorInfo();
  appState.creatorInfoLoading = true;
  updateUploadAvailability();
  try {
    const result = await requestJson("/api/creator-info", { cache: "no-store" });
    if (requestId !== appState.creatorInfoRequest || appState.mode !== "direct") {
      return;
    }
    appState.creatorInfoLoading = false;
    renderCreatorInfo(result.creatorInfo);
    if (result.creatorInfo.directPostAllowed) hideAlert();
  } catch (error) {
    if (requestId !== appState.creatorInfoRequest) return;
    appState.creatorInfoLoading = false;
    ui.directAccountName.textContent = "Direct Post settings unavailable";
    showAlert(error.message, "error");
  }
  updateUploadAvailability();
}

function setPublishMode(mode) {
  appState.mode = mode === "direct" ? "direct" : "draft";
  const direct = appState.mode === "direct";
  appState.creatorInfoRequest += 1;
  resetCreatorInfo();
  ui.directSettings.hidden = !direct;
  ui.draftExplainer.hidden = direct;
  ui.draftConsent.hidden = direct;
  ui.directConsent.hidden = !direct;
  ui.confirmTitle.textContent = direct
    ? "Review and confirm Direct Post"
    : "Confirm the draft transfer";
  ui.confirmDescription.textContent = direct
    ? "TikTok provides the account-specific settings below. The post starts only after your explicit confirmation."
    : "This action uploads the selected video to the authorized account's TikTok inbox. It does not publish automatically.";
  ui.uploadButton.textContent = direct
    ? "Publish directly"
    : "Send to TikTok drafts";
  invalidateConsent();
  if (direct) void loadCreatorInfo();
}

function uploadSelectedFile() {
  if (
    !appState.file ||
    !appState.session?.connected ||
    !ui.consent.checked ||
    appState.uploading ||
    !directSettingsReady()
  ) {
    return;
  }
  appState.uploading = true;
  updateUploadAvailability();
  ui.uploadProgressWrap.hidden = false;
  ui.uploadProgress.value = 0;
  ui.uploadProgressValue.textContent = "0%";
  ui.uploadProgressLabel.textContent = "Uploading securely to the server";
  hideAlert();

  const formData = new FormData();
  formData.append("video", appState.file, appState.file.name);
  formData.append("publishMode", appState.mode);
  formData.append("consentConfirmed", "true");
  if (appState.mode === "direct") {
    formData.append("caption", ui.caption.value);
    formData.append("privacyLevel", ui.privacy.value);
    formData.append("allowComment", String(ui.allowComment.checked));
    formData.append("allowDuet", String(ui.allowDuet.checked));
    formData.append("allowStitch", String(ui.allowStitch.checked));
    formData.append(
      "commercialContent",
      String(ui.commercialContent.checked),
    );
    formData.append("brandOrganic", String(ui.brandOrganic.checked));
    formData.append("brandContent", String(ui.brandContent.checked));
    formData.append(
      "videoDurationSeconds",
      String(appState.videoDurationSeconds),
    );
  }

  const request = new XMLHttpRequest();
  request.open("POST", "/api/upload");
  request.responseType = "json";
  request.withCredentials = true;
  request.setRequestHeader("Accept", "application/json");
  request.setRequestHeader("X-CSRF-Token", appState.session.csrfToken);

  request.upload.addEventListener("progress", (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.min(
      99,
      Math.round((event.loaded / event.total) * 100),
    );
    ui.uploadProgress.value = percent;
    ui.uploadProgressValue.textContent = `${percent}%`;
    if (percent >= 99) {
      ui.uploadProgressLabel.textContent = appState.mode === "direct"
        ? "Transferring the confirmed Direct Post to TikTok"
        : "Transferring the confirmed draft to TikTok";
    }
  });

  request.addEventListener("load", () => {
    appState.uploading = false;
    if (
      request.status >= 200 &&
      request.status < 300 &&
      request.response?.publish
    ) {
      ui.uploadProgress.value = 100;
      ui.uploadProgressValue.textContent = "100%";
      ui.uploadProgressLabel.textContent = "Transfer accepted by TikTok";
      appState.session.lastPublish = request.response.publish;
      renderStatus(request.response.publish);
      resetSelectedFile();
      scheduleStatusPoll();
      return;
    }
    const message =
      request.response?.error?.message ||
      `Upload failed (${request.status}).`;
    showAlert(message, "error");
    updateUploadAvailability();
    void loadSession();
  });

  request.addEventListener("error", () => {
    appState.uploading = false;
    showAlert(
      "The upload could not reach the secure backend. Try again when the connection is available.",
      "error",
    );
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
    const result = await requestJson(endpoint, {
      method: "POST",
      headers: { "X-CSRF-Token": appState.session.csrfToken },
    });
    resetSelectedFile();
    resetCreatorInfo();
    await loadSession();
    if (result.authorizationRevoked === false) {
      showAlert(
        result.revocationNotice ||
          "Local data was removed. Also remove the app from TikTok's connected-app settings.",
        "warning",
      );
    } else {
      showAlert(
        deleteData
          ? "Connection data was deleted from this app session."
          : "TikTok access was revoked and the account was disconnected.",
        "success",
      );
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
    if (appState.mode === "direct" && appState.session.connected) {
      void loadCreatorInfo();
    }
  } catch {
    appState.session = { configured: false, connected: false, limits: {} };
    renderConnection();
    showAlert(
      "This page is running as a static website and cannot handle TikTok credentials. Open the deployed creator-app domain to use the real Sandbox workflow.",
      "warning",
    );
  }
}

ui.fileInput.addEventListener("change", () =>
  selectFile(ui.fileInput.files?.[0] || null),
);
for (const input of ui.modeInputs) {
  input.addEventListener("change", () => {
    if (input.checked) setPublishMode(input.value);
  });
}
ui.caption.addEventListener("input", () => {
  ui.captionCount.textContent = String(ui.caption.value.length);
  invalidateConsent();
});
ui.privacy.addEventListener("change", () => {
  renderCommercialSettings();
  invalidateConsent();
});
for (const interaction of [
  ui.allowComment,
  ui.allowDuet,
  ui.allowStitch,
]) {
  interaction.addEventListener("change", invalidateConsent);
}
ui.commercialContent.addEventListener("change", () => {
  renderCommercialSettings();
  invalidateConsent();
});
ui.brandOrganic.addEventListener("change", () => {
  renderCommercialSettings();
  invalidateConsent();
});
ui.brandContent.addEventListener("change", () => {
  renderCommercialSettings();
  invalidateConsent();
});
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
